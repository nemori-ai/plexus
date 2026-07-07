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
  WORKSPACE_LIST_ID,
  WORKSPACE_READ_ID,
  WORKSPACE_WRITE_ID,
  WORKSPACE_SOURCE_ID,
} from "./entries.ts";
import { selectWorkspaceProvider, type WorkspaceProvider } from "./provider.ts";
import { wsList, wsRead, wsWrite } from "./ops.ts";

/** An in-process handler: input + provider → real local op → TransportResult. */
type WorkspaceHandler = (
  provider: WorkspaceProvider,
  input: Record<string, unknown>,
) => Promise<TransportResult>;

/**
 * The three confined-fs ops for the SINGLETON `workspace` source, keyed by its concrete
 * capability ids. The managed `workspace-dir` instances do NOT use this bridge — they go
 * through the generic `ExtensionBridge` with the in-process handlers in `open-dir.ts`
 * (which share the SAME `ops.ts` core, so the two paths cannot drift). `WorkspaceBridge`
 * is therefore only ever the singleton; no per-instance op-keying is needed here.
 */
const HANDLERS: Record<string, WorkspaceHandler> = {
  [WORKSPACE_LIST_ID]: wsList,
  [WORKSPACE_READ_ID]: wsRead,
  [WORKSPACE_WRITE_ID]: wsWrite,
};

export class WorkspaceBridge extends BaseCapabilityBridge {
  private readonly provider: WorkspaceProvider;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: WorkspaceProvider,
  ) {
    super(WORKSPACE_SOURCE_ID, deps, sessionId, entries);
    // real by default; fake (temp dir) when PLEXUS_FAKE_WORKSPACE=1; or an injected provider.
    this.provider = selectWorkspaceProvider(provider);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const handler = HANDLERS[req.id];
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
      result = await handler(this.provider, req.input ?? {});
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
