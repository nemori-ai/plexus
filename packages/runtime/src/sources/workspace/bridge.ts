/**
 * Workspace PER-SESSION bridge (first-party source).
 *
 * Mirrors the Things in-process-handler pattern: the three workspace capabilities are
 * best served by gateway-owned local code that drives the injected
 * {@link WorkspaceProvider}, so the bridge intercepts their ids and runs the provider
 * directly, then normalizes + audits the result (the `ipc` transport wire is never
 * reached). Everything else (the how-to-use SKILL) takes the standard
 * `BaseCapabilityBridge` path.
 *
 *   workspace.list   → provider.read(path)            (LIST, confined fs)
 *   workspace.read   → provider.read(path)            (READ, confined fs)
 *   workspace.write  → provider.write(path, content)  (WRITE, confined fs — PENDS upstream)
 *
 * A path-confinement violation (`WorkspaceConfinementError`) is mapped to a
 * `transport_error` with `detail.reason:"path_confinement"` (mirrors obsidian's
 * `vaultReadHandler`) — NOT a thrown exception, and the out-of-dir content is never
 * returned.
 *
 * The provider is INJECTED (constructor) or selected by `selectWorkspaceProvider()` —
 * the fake (temp-dir) when `PLEXUS_FAKE_WORKSPACE=1`, else the real confined-fs provider
 * — so the automated probe + tests are hermetic.
 */

import type {
  BridgeDeps,
  CapabilityEntry,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  TransportResult,
} from "@plexus/protocol";
import { BaseCapabilityBridge, normalizeResult } from "../base.ts";
import {
  WORKSPACE_SOURCE_ID,
  WORKSPACE_VERB_LIST,
  WORKSPACE_VERB_READ,
  WORKSPACE_VERB_WRITE,
} from "./entries.ts";
import {
  selectWorkspaceProvider,
  WorkspaceConfinementError,
  type WorkspaceProvider,
} from "./provider.ts";

/** An in-process handler: input + provider → real local op → TransportResult. */
type WorkspaceHandler = (
  input: Record<string, unknown>,
  provider: WorkspaceProvider,
) => Promise<TransportResult>;

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Map a confinement violation to a transport_error (out-of-dir content never returned). */
function denyConfinement(err: WorkspaceConfinementError): TransportResult {
  return {
    ok: false,
    error: {
      code: "transport_error",
      message: `workspace: path denied (confinement): ${err.message}`,
      detail: { reason: "path_confinement" },
    },
  };
}

/**
 * Handlers keyed by the per-instance VERB SUFFIX (`list`/`read`/`write`) — NOT by a
 * hardcoded capability id — so a bridge constructed for source `notes-a` only ever
 * intercepts `notes-a.<verb>` ops (its own entries), never another instance's. The
 * concrete capability-id → handler map is derived per bridge from its entry snapshot's
 * `extras.route.op` (see the constructor).
 */
const HANDLERS: Record<string, WorkspaceHandler> = {
  [WORKSPACE_VERB_LIST]: async (input, provider) => {
    const path = typeof input.path === "string" ? input.path : "";
    try {
      const result = await provider.read(path);
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof WorkspaceConfinementError) return denyConfinement(err);
      throw err;
    }
  },
  [WORKSPACE_VERB_READ]: async (input, provider) => {
    const path = strOf(input.path);
    if (!path) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`path` is required" } };
    }
    try {
      const result = await provider.read(path);
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof WorkspaceConfinementError) return denyConfinement(err);
      throw err;
    }
  },
  [WORKSPACE_VERB_WRITE]: async (input, provider) => {
    const path = strOf(input.path);
    if (!path) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`path` is required" } };
    }
    const content = typeof input.content === "string" ? input.content : undefined;
    if (content === undefined) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`content` is required" } };
    }
    try {
      const result = await provider.write(path, content);
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof WorkspaceConfinementError) return denyConfinement(err);
      throw err;
    }
  },
};

export class WorkspaceBridge extends BaseCapabilityBridge {
  private readonly provider: WorkspaceProvider;
  /** Per-instance capability-id → handler map, derived from the entries' `route.op`. */
  private readonly opHandlers: Map<string, WorkspaceHandler>;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: WorkspaceProvider,
    sourceId: string = WORKSPACE_SOURCE_ID,
  ) {
    super(sourceId, deps, sessionId, entries);
    // real by default; fake (temp dir) when PLEXUS_FAKE_WORKSPACE=1; or an injected
    // provider (a managed instance injects a RealWorkspaceProvider(root) built from
    // its OWN configured root — never the env-selected singleton root).
    this.provider = selectWorkspaceProvider(provider);
    // Bind handlers ONLY for this instance's own ops (`<sourceId>.<verb>`): the op is
    // parameterized per source id, so two instances' bridges can never intercept each
    // other's capabilities.
    this.opHandlers = new Map();
    for (const e of entries) {
      const op = (e.extras?.route as { op?: string } | undefined)?.op;
      if (typeof op !== "string" || !op.startsWith(`${sourceId}.`)) continue;
      const verb = op.slice(sourceId.length + 1);
      const handler = HANDLERS[verb];
      if (handler) this.opHandlers.set(e.id, handler);
    }
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const handler = this.opHandlers.get(req.id);
    if (!handler) {
      // The skill (and anything else) takes the standard base path.
      return super.invoke(req, ctx);
    }

    const entry = this.deps.getEntry(req.id) ?? this.getCapabilities().find((e) => e.id === req.id);
    if (!entry) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
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

    let result: TransportResult;
    try {
      result = await handler(req.input ?? {}, this.provider);
    } catch (err) {
      const audit = await this.deps.audit({
        type: "invoke",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { reason: "handler_threw", op: req.id },
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
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: the op name + kind only, never the file path/content.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
