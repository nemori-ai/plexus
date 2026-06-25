/**
 * MCP CLIENT over a line/JSON-RPC transport (the engine behind the `mcp`
 * transport). This is a genuinely functional MCP client:
 *
 *   - initialize  (sends clientInfo + client capabilities; sends the
 *                  `notifications/initialized` follow-up before any list/call),
 *   - tools/list, resources/list, prompts/list — each PAGED TO EXHAUSTION via the
 *     MCP `cursor`,
 *   - tools/call, resources/read, prompts/get.
 *
 * It is transport-agnostic over the BYTE channel: it talks JSON-RPC 2.0 framed as
 * NDJSON (one JSON object per line) through an injected `RpcChannel`. The real
 * stdio channel wraps `PlatformServices.spawnProcess`; tests inject an in-proc
 * channel wired to a fake MCP server, exercising the exact same code path.
 *
 * @see https://modelcontextprotocol.io  (JSON-RPC 2.0, initialize, cursor paging)
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** A bidirectional NDJSON line channel (a spawned process's stdio, or an in-proc pipe). */
export interface RpcChannel {
  /** Write one already-serialized JSON-RPC message (the client appends the newline). */
  send(line: string): void;
  /** Register the per-line reader (one call per `\n`-terminated line of server output). */
  onLine(cb: (line: string) => void): void;
  /** Register an exit/close handler. */
  onClose(cb: () => void): void;
  /** Tear the channel down. */
  close(): void;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A persistent, initialize'd MCP client session over one `RpcChannel`. Owns the
 * request-id sequence and the pending-response map. Reused across invokes (the
 * source's `start()` owns one of these per server).
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private buffer: string[] = [];

  private serverInfo: Record<string, unknown> = {};
  private negotiatedVersion = MCP_PROTOCOL_VERSION;
  private initialized = false;

  constructor(private readonly channel: RpcChannel) {
    this.channel.onLine((line) => this.onLine(line));
    this.channel.onClose(() => this.onClose());
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return; // not a JSON-RPC line (e.g. a server log line) — ignore.
    }
    // Server-initiated notifications (no id) — e.g. list_changed. We don't act on
    // them here; the owning source subscribes separately. Responses carry an id.
    if (msg.id === undefined || msg.id === null) return;
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (msg.error) {
      waiter.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      waiter.resolve(msg.result);
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("MCP channel closed"));
    }
    this.pending.clear();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("MCP channel closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel.send(payload);
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.channel.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
  }

  /**
   * initialize handshake. Sends clientInfo + client capabilities, then the
   * mandatory `notifications/initialized` follow-up. Idempotent.
   */
  async initialize(): Promise<{ protocolVersion: string; serverInfo: Record<string, unknown> }> {
    if (this.initialized) {
      return { protocolVersion: this.negotiatedVersion, serverInfo: this.serverInfo };
    }
    const result = (await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        // Plexus is a passive collector: it consumes tools/resources/prompts and
        // wants list_changed notifications. It exposes no roots/sampling.
        roots: { listChanged: false },
      },
      clientInfo: { name: "plexus", version: "0.1.0" },
    })) as { protocolVersion?: string; serverInfo?: Record<string, unknown> } | undefined;

    this.negotiatedVersion = result?.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.serverInfo = result?.serverInfo ?? {};
    // OBLIGATION: send notifications/initialized before any list/call.
    this.notify("notifications/initialized");
    this.initialized = true;
    return { protocolVersion: this.negotiatedVersion, serverInfo: this.serverInfo };
  }

  /** Page a list method (tools/resources/prompts) to exhaustion via the MCP cursor. */
  private async listPaged(method: string, key: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    // Bounded loop guard against a misbehaving server returning the same cursor.
    const seenCursors = new Set<string>();
    do {
      const params = cursor === undefined ? {} : { cursor };
      const page = (await this.request(method, params)) as
        | { nextCursor?: string; [k: string]: unknown }
        | undefined;
      const arr = (page?.[key] as unknown[] | undefined) ?? [];
      items.push(...arr);
      const next = page?.nextCursor;
      if (typeof next === "string" && next.length > 0 && !seenCursors.has(next)) {
        seenCursors.add(next);
        cursor = next;
      } else {
        cursor = undefined;
      }
    } while (cursor !== undefined);
    return items;
  }

  /** tools/list + resources/list + prompts/list, each paged to exhaustion. */
  async list(): Promise<{ tools: unknown[]; resources: unknown[]; prompts: unknown[] }> {
    const [tools, resources, prompts] = await Promise.all([
      this.listPaged("tools/list", "tools").catch(() => []),
      this.listPaged("resources/list", "resources").catch(() => []),
      this.listPaged("prompts/list", "prompts").catch(() => []),
    ]);
    return { tools, resources, prompts };
  }

  /** tools/call — returns the raw MCP tool result ({content, structuredContent, isError}). */
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.request("tools/call", { name, arguments: args })) as Record<string, unknown>;
  }

  /** resources/read — returns the raw MCP resource result ({contents}). */
  async readResource(uri: string): Promise<Record<string, unknown>> {
    return (await this.request("resources/read", { uri })) as Record<string, unknown>;
  }

  /** prompts/get — returns the raw MCP prompt result ({messages, description?}). */
  async getPrompt(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return (await this.request("prompts/get", { name, arguments: args })) as Record<string, unknown>;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.channel.close();
    this.onClose();
  }
}
