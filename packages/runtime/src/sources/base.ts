/**
 * Two-layer adapter base helpers (§6).
 *
 * Concrete base classes a source author subclasses so that first-party / MCP /
 * extension sources only implement the MINIMAL surface that differs:
 *
 *  - `BaseCapabilitySource` (LIFECYCLE layer, implements `CapabilitySource`):
 *      provides idempotent start/stop bookkeeping, an `onEntriesChanged` fan-out
 *      hub (so a source can `emitEntriesChanged(entries)` and every subscriber —
 *      including the capability registry — is notified), and sane defaults for
 *      `checkRequirements`. Subclasses implement `scan()` (and optionally override
 *      the lifecycle hooks `onStart`/`onStop` and `checkRequirements`).
 *
 *  - `BaseCapabilityBridge` (PER-SESSION protocol-translation layer, implements
 *      `CapabilityBridge`): the single uniform `invoke()` path that
 *        1. looks up the full entry (via `BridgeDeps.getEntry`),
 *        2. resolves the owning `Transport` (via `BridgeDeps.getTransport`) — NO
 *           branching on transport kind in the bridge,
 *        3. dispatches (threading the re-entrant `TransportDispatchContext` for the
 *           workflow transport),
 *        4. normalizes `TransportResult` → `InvokeResponse` (mapping MCP
 *           `isError:true` → ok:false + `mcp_tool_error`, preserving `mcpResult`),
 *        5. emits exactly ONE audit event.
 *      Subclasses generally need only set the `source` field and the set of ids
 *      they own (for `route()`); `getCapabilities()` is served from a snapshot the
 *      source hands the bridge factory.
 *
 * The adapter type stays PRIVATE to the impl — core never sees it (the bridge
 * closes over whatever it needs). Core never branches on source/transport kind.
 */

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilityId,
  GatewayMode,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  McpResult,
  RouteResult,
  SourceHealth,
  SourceId,
  SourceRequirementResult,
  TransportKind,
  TransportResult,
} from "@plexus/protocol";

// ──────────────────────────────────────────────────────────────────────────
// LIFECYCLE LAYER
// ──────────────────────────────────────────────────────────────────────────

/**
 * Base `CapabilitySource`. Subclass and implement `scan()`; optionally override
 * `checkRequirements()`, `onStart()`, `onStop()`.
 */
export abstract class BaseCapabilitySource {
  abstract readonly id: SourceId;
  abstract readonly label: string;
  abstract readonly transport: TransportKind;

  private started = false;
  private readonly entriesChangedSubs = new Set<(entries: CapabilityEntry[]) => void>();

  /**
   * Default availability probe: optimistic. Sources with a real dependency
   * (a binary, a port, an MCP initialize) override this.
   */
  async checkRequirements(): Promise<SourceRequirementResult> {
    return { ok: true };
  }

  /**
   * OPTIONAL per-source HEALTH probe (HEALTH, additive). The DEFAULT DERIVES from
   * `checkRequirements()`: ok→"ok", not-ok→"unavailable" (the reason as detail). A
   * source with a richer signal (reachable-but-impaired) overrides this to return
   * `"degraded"`; a source that wants to opt out can override to return `"unknown"`.
   * Kept cheap — the gateway's health service polls it in the background (stale-
   * while-revalidate), never on the hot discovery/handshake/invoke path.
   */
  async health(): Promise<SourceHealth> {
    const req = await this.checkRequirements();
    return req.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(req.reason ? { detail: req.reason } : {}) };
  }

  /** Enumerate the self-describe entries this source provides. Subclass implements. */
  abstract scan(): Promise<CapabilityEntry[]>;

  /** Idempotent start — long-lived resources are spun up in `onStart()`. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.onStart();
    this.started = true;
  }

  /** Idempotent stop. */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.onStop();
    this.started = false;
  }

  /** Subscribe to live entry-set changes (e.g. MCP list_changed). */
  onEntriesChanged(cb: (entries: CapabilityEntry[]) => void): void {
    this.entriesChangedSubs.add(cb);
  }

  /** Subclass hook: spin up persistent resources (e.g. the MCP client). */
  protected async onStart(): Promise<void> {}
  /** Subclass hook: tear down persistent resources. */
  protected async onStop(): Promise<void> {}

  /**
   * Notify subscribers that the entry set changed (subclasses call this when the
   * underlying source emits e.g. an MCP `notifications/tools/list_changed`).
   */
  protected emitEntriesChanged(entries: CapabilityEntry[]): void {
    for (const cb of this.entriesChangedSubs) cb(entries);
  }

  /** Whether `start()` has run without a matching `stop()`. */
  protected get isStarted(): boolean {
    return this.started;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// PER-SESSION PROTOCOL-TRANSLATION LAYER
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalize a transport-level `TransportResult` into a wire `InvokeResponse`.
 * Centralizes the MCP `isError:true → ok:false + mcp_tool_error` mapping and the
 * verbatim `mcpResult` pass-through so every bridge does it identically.
 */
export function normalizeResult(
  id: CapabilityId,
  result: TransportResult,
  auditId: string,
): InvokeResponse {
  const mcpResult: McpResult | undefined = result.mcpResult;

  // MCP in-band tool error: server returned isError:true. Map to ok:false +
  // mcp_tool_error while PRESERVING the verbatim content[] in mcpResult.
  if (mcpResult?.isError === true) {
    return {
      id,
      ok: false,
      mcpResult,
      error: {
        code: "mcp_tool_error",
        message: "MCP server returned isError:true",
        capabilityId: id,
      },
      auditId,
    };
  }

  if (!result.ok) {
    return {
      id,
      ok: false,
      ...(mcpResult ? { mcpResult } : {}),
      error: result.error ?? {
        code: "transport_error",
        message: "transport dispatch failed",
        capabilityId: id,
      },
      auditId,
    };
  }

  return {
    id,
    ok: true,
    output: result.data,
    ...(mcpResult ? { mcpResult } : {}),
    auditId,
  };
}

/**
 * Base `CapabilityBridge`. Holds an entry snapshot (handed by the source at bridge-
 * construction) and provides the uniform invoke path. Subclasses typically just
 * construct it; the workflow transport re-entrancy is handled here transparently
 * because `invoke()` threads `BridgeDeps.invokeById` into the transport via the
 * `TransportDispatchContext`.
 */
export class BaseCapabilityBridge implements CapabilityBridge {
  readonly source: SourceId;

  protected readonly deps: BridgeDeps;
  protected readonly sessionId: string;
  private readonly ownedIds: Set<CapabilityId>;
  private readonly snapshot: CapabilityEntry[];

  constructor(
    source: SourceId,
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
  ) {
    this.source = source;
    this.deps = deps;
    this.sessionId = sessionId;
    this.snapshot = entries;
    this.ownedIds = new Set(entries.map((e) => e.id));
  }

  getCapabilities(): CapabilityEntry[] {
    return this.snapshot;
  }

  route(id: CapabilityId): RouteResult {
    return this.ownedIds.has(id) ? "handled" : "passthrough";
  }

  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    // Cross-tier audit linkage (mesh §3.5): a tunnel-trusted (proxy-tier) forwarded invoke
    // carries a shared `correlationId` + `tier:"proxy"` on its context; stamp them onto the
    // ONE audit event this bridge emits so the proxy's authoritative local record threads to
    // the primary's edge-span and is self-identifying when it bubbles up (T9). Both spread to
    // nothing on a single-gateway/agent-facing invoke — no behavior change off the mesh.
    // Read at WRITE time (a function, not a snapshot): the `mesh` transport stamps the
    // edge-span's `correlationId` onto `ctx` DURING dispatch, so the post-dispatch audit
    // writes must observe the freshly-mutated context.
    const linkage = (): { correlationId?: string; tier?: GatewayMode } => ({
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...(ctx.tier ? { tier: ctx.tier } : {}),
    });
    // The full, routing-bearing entry comes from the registry (the snapshot may be
    // stale; the registry is the source of truth for transport/mcp routing info).
    const entry = this.deps.getEntry(req.id) ?? this.snapshot.find((e) => e.id === req.id);

    if (!entry) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        ...linkage(),
        capabilityId: req.id,
        outcome: "error",
        detail: { reason: "unknown_capability" },
      });
      return {
        id: req.id,
        ok: false,
        error: { code: "unknown_capability", message: `no such entry: ${req.id}`, capabilityId: req.id },
        auditId: audit.id,
      };
    }

    // Skills are read-as-context, never invoked over a wire (contract).
    if (entry.kind === "skill") {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        ...linkage(),
        capabilityId: entry.id,
        outcome: "error",
        detail: { reason: "skill_not_invocable", kind: entry.kind },
      });
      return {
        id: entry.id,
        ok: false,
        error: {
          code: "transport_error",
          message: "skill entries are read-as-context, not invoked",
          capabilityId: entry.id,
        },
        auditId: audit.id,
      };
    }

    const transport = this.deps.getTransport(entry.transport);
    const input = req.input ?? {};

    let result: TransportResult;
    try {
      // Thread the re-entrant context: leaf transports ignore it, the workflow
      // transport uses `invokeById` to fan out to members through the SAME pipeline.
      result = await transport.dispatch(entry, input, {
        invokeById: this.deps.invokeById,
        invoke: ctx,
      });
    } catch (err) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        ...linkage(),
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { reason: "transport_threw", transport: entry.transport },
      });
      return {
        id: entry.id,
        ok: false,
        error: {
          code: "transport_error",
          message: err instanceof Error ? err.message : String(err),
          capabilityId: entry.id,
        },
        auditId: audit.id,
      };
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      ...linkage(),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok && result.mcpResult?.isError !== true ? "ok" : "error",
      // Redaction-safe detail only: shapes/counts/ids, never raw input/values.
      detail: { transport: entry.transport, kind: entry.kind },
      // Request + result captured for the Activity view; the single audit writer
      // redacts (per the policy) + truncates these before they ever hit disk.
      input,
      output: result.ok ? (result.data ?? result.mcpResult) : result.error,
    });

    return normalizeResult(entry.id, result, audit.id);
  }

  async disconnect(): Promise<void> {
    // Base bridge owns no per-session resources. Subclasses override if they do.
  }
}
