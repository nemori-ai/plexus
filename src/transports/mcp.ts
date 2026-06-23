/**
 * `mcp` transport (PRIVILEGED) — Plexus runs an MCP CLIENT against an MCP server.
 * Implements `McpTransport`: dispatch BRANCHES on `entry.mcp.primitive`
 * (tool→tools/call, resource→resources/read, prompt→prompts/get) and returns the
 * verbatim `McpResult`. The persistent client is owned by the source's start() and
 * reused across request-scoped invokes (re-created on session loss). (ADR-001/003,
 * review #1/#2.)
 *
 * The transport owns a pool of `McpClient`s keyed by serverId. A client is created
 * lazily on first use (or by the source's `start()`) via a `ChannelFactory`. The
 * default factory spawns the server over stdio using `PlatformServices.spawnProcess`
 * and reads its launch spec from the entry's MCP launch config; tests inject a
 * factory wired to an in-proc fake server, exercising the SAME initialize→list→call
 * code path.
 */

import type {
  McpTransport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
  McpResult,
  SpawnSpec,
} from "../protocol/index.ts";
import type { PlatformServices } from "../platform/index.ts";
import { McpClient, type RpcChannel } from "./mcp-client.ts";

/** How to obtain a byte channel for a server. Injectable for tests. */
export type ChannelFactory = (serverId: string) => RpcChannel | Promise<RpcChannel>;

/**
 * The per-server launch config the MCP transport needs to spawn a stdio server.
 * Sources stash it on `entry.extras.mcpLaunch` (core never reads extras). Shape:
 * `{ command, args, cwd?, env? }`.
 */
interface McpLaunch extends SpawnSpec {}

export class McpClientTransport implements McpTransport {
  readonly kind = "mcp" as const;

  private readonly clients = new Map<string, McpClient>();
  /** Per-server launch config, registered by sources (or read from entry.extras). */
  private readonly launchConfig = new Map<string, McpLaunch>();
  private readonly channelFactory: ChannelFactory;

  constructor(
    private readonly platform: PlatformServices,
    /** Override the channel factory (tests inject an in-proc fake server here). */
    channelFactory?: ChannelFactory,
  ) {
    this.channelFactory = channelFactory ?? ((serverId) => this.spawnStdioChannel(serverId));
  }

  /** Register how to launch a given MCP server over stdio (called by the source). */
  registerServer(serverId: string, launch: McpLaunch): void {
    this.launchConfig.set(serverId, launch);
  }

  /** Default stdio channel: spawn the server and frame its stdio as NDJSON lines. */
  private spawnStdioChannel(serverId: string): RpcChannel {
    const launch = this.launchConfig.get(serverId);
    if (!launch) {
      throw new Error(`mcp: no launch config registered for server "${serverId}"`);
    }
    const proc = this.platform.spawnProcess(launch);
    return {
      send: (line: string) => proc.write(line + "\n"),
      onLine: (cb) => proc.onLine(cb),
      onClose: (cb) => proc.onExit(() => cb()),
      close: () => proc.kill(),
    };
  }

  /** Get (or lazily create + initialize) the persistent client for a server. */
  private async getClient(serverId: string): Promise<McpClient> {
    let client = this.clients.get(serverId);
    if (client && !client.isClosed) return client;
    const channel = await this.channelFactory(serverId);
    client = new McpClient(channel);
    this.clients.set(serverId, client);
    await client.initialize();
    return client;
  }

  // ── McpTransport surface ──────────────────────────────────────────────────

  async initialize(
    serverId: string,
  ): Promise<{ protocolVersion: string; serverInfo: Record<string, unknown> }> {
    const client = await this.getClient(serverId);
    return client.initialize();
  }

  async list(
    serverId: string,
  ): Promise<{ tools: unknown[]; resources: unknown[]; prompts: unknown[] }> {
    const client = await this.getClient(serverId);
    return client.list();
  }

  async call(
    serverId: string,
    originName: string,
    args: Record<string, unknown>,
  ): Promise<TransportResult> {
    try {
      const client = await this.getClient(serverId);
      const raw = await client.call(originName, args);
      const mcpResult: McpResult = {
        content: (raw.content as unknown[] | undefined) ?? [],
        ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
        ...(raw.isError === true ? { isError: true } : {}),
      };
      // ok mirrors the absence of isError; the bridge maps isError → mcp_tool_error.
      return { ok: raw.isError !== true, data: raw.structuredContent ?? raw.content, mcpResult };
    } catch (err) {
      return this.transportError(err);
    }
  }

  async readResource(serverId: string, uri: string): Promise<TransportResult> {
    try {
      const client = await this.getClient(serverId);
      const raw = await client.readResource(uri);
      const mcpResult: McpResult = { contents: (raw.contents as unknown[] | undefined) ?? [] };
      return { ok: true, data: mcpResult.contents, mcpResult };
    } catch (err) {
      return this.transportError(err);
    }
  }

  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<TransportResult> {
    try {
      const client = await this.getClient(serverId);
      const raw = await client.getPrompt(name, args);
      const mcpResult: McpResult = { messages: (raw.messages as unknown[] | undefined) ?? [] };
      return { ok: true, data: mcpResult.messages, mcpResult };
    } catch (err) {
      return this.transportError(err);
    }
  }

  /**
   * dispatch — BRANCH on `entry.mcp.primitive`, route by `entry.mcp.originName`.
   * `ctx` is ignored (mcp is a leaf transport). The verbatim `McpResult` rides
   * back in the `TransportResult`.
   */
  async dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    _ctx?: TransportDispatchContext,
  ): Promise<TransportResult> {
    const mcp = entry.mcp;
    if (!mcp) {
      return {
        ok: false,
        error: {
          code: "transport_error",
          message: `mcp transport: entry ${entry.id} has no mcp passthrough`,
          capabilityId: entry.id,
        },
      };
    }

    // Lazily register a launch spec stashed by the source on extras, if any.
    const launch = entry.extras?.mcpLaunch as McpLaunch | undefined;
    if (launch && !this.launchConfig.has(mcp.serverId)) {
      this.launchConfig.set(mcp.serverId, launch);
    }

    switch (mcp.primitive) {
      case "tool":
        return this.call(mcp.serverId, mcp.originName, input);
      case "resource":
        return this.readResource(mcp.serverId, mcp.originName);
      case "prompt":
        return this.getPrompt(mcp.serverId, mcp.originName, input);
      default:
        return {
          ok: false,
          error: {
            code: "transport_error",
            message: `mcp transport: unknown primitive ${String(mcp.primitive)}`,
            capabilityId: entry.id,
          },
        };
    }
  }

  /** Close all clients (called when transports are torn down). */
  closeAll(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }

  private transportError(err: unknown): TransportResult {
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
