/**
 * sysinfo PER-SESSION bridge (first-party source).
 *
 * Mirrors the workspace / codex in-process-handler pattern: the three sysinfo capabilities
 * are best served by gateway-owned local code that drives the injected
 * {@link SysinfoProvider}, so the bridge intercepts their ids and runs the provider directly,
 * then normalizes + audits the result (the `ipc` transport wire is never reached). The
 * `sysinfo.how-to-use` SKILL takes the standard `BaseCapabilityBridge` path.
 *
 *   sysinfo.processes.list → provider.listProcesses(top)      (READ, `ps`)
 *   sysinfo.resources.read → provider.readResources()         (READ, `os` + `df`)
 *   sysinfo.log.read       → provider.readLog(file, lines)    (READ, confined-fs tail)
 *
 * FAIL-CLOSED on every error (never crash the gateway):
 *   - path-jail violation (`SysinfoConfinementError`) → `transport_error` with
 *     `detail.reason:"path_confinement"`; the out-of-jail content is never returned.
 *   - missing `ps`/`df` binary or unreadable command (`SysinfoUnavailableError`) →
 *     `source_unavailable` (advisory degrade, mirrors the codex bridge).
 *   - anything else → `transport_error`.
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
  SYSINFO_SOURCE_ID,
  SYSINFO_PROCESSES_LIST_ID,
  SYSINFO_RESOURCES_READ_ID,
  SYSINFO_LOG_READ_ID,
} from "./entries.ts";
import {
  clampLines,
  clampTop,
  selectSysinfoProvider,
  SysinfoConfinementError,
  SysinfoUnavailableError,
  type SysinfoProvider,
} from "./provider.ts";

/** An in-process handler: input + provider → real local op → TransportResult. */
type SysinfoHandler = (
  input: Record<string, unknown>,
  provider: SysinfoProvider,
) => Promise<TransportResult>;

/** Map a source-unavailable degrade to a clean advisory error (mirrors codex). */
function denyUnavailable(err: SysinfoUnavailableError): TransportResult {
  return { ok: false, error: { code: "source_unavailable", message: err.message } };
}

/** Map a path-jail violation to a transport_error (out-of-jail content never returned). */
function denyConfinement(err: SysinfoConfinementError): TransportResult {
  return {
    ok: false,
    error: {
      code: "transport_error",
      message: `sysinfo: path denied (confinement): ${err.message}`,
      detail: { reason: "path_confinement" },
    },
  };
}

const HANDLERS: Record<string, SysinfoHandler> = {
  [SYSINFO_PROCESSES_LIST_ID]: async (input, provider) => {
    try {
      const result = await provider.listProcesses(clampTop(input.top));
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof SysinfoUnavailableError) return denyUnavailable(err);
      throw err;
    }
  },
  [SYSINFO_RESOURCES_READ_ID]: async (_input, provider) => {
    try {
      const result = await provider.readResources();
      return { ok: true, data: result };
    } catch (err) {
      if (err instanceof SysinfoUnavailableError) return denyUnavailable(err);
      throw err;
    }
  },
  [SYSINFO_LOG_READ_ID]: async (input, provider) => {
    const file = typeof input.file === "string" && input.file.length > 0 ? input.file : undefined;
    if (!file) {
      return { ok: false, error: { code: "schema_validation_failed", message: "`file` is required" } };
    }
    try {
      const result = await provider.readLog(file, clampLines(input.lines));
      return { ok: true, data: result };
    } catch (err) {
      // Confinement FIRST — a path escape must never fall through to a raw fs error.
      if (err instanceof SysinfoConfinementError) return denyConfinement(err);
      if (err instanceof SysinfoUnavailableError) return denyUnavailable(err);
      // ENOENT / EACCES / any other fs error: fail-closed as transport_error (the raw path
      // is not echoed back beyond the request the caller already sent).
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: "transport_error", message: `sysinfo: log read failed: ${message}` } };
    }
  },
};

export class SysinfoBridge extends BaseCapabilityBridge {
  private readonly provider: SysinfoProvider;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: SysinfoProvider,
  ) {
    super(SYSINFO_SOURCE_ID, deps, sessionId, entries);
    // real by default; fake when PLEXUS_FAKE_SYSINFO=1; or an injected provider (tests).
    this.provider = selectSysinfoProvider(provider);
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
      result = await handler(req.input ?? {}, this.provider);
    } catch (err) {
      // Last-resort catch: a handler must NEVER crash the gateway.
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
      // Redaction-safe: the op name + kind only, never the log path/content or process list.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
