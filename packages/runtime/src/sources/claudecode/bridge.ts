/**
 * Claude Code sandboxed-run PER-SESSION bridge (first-party source).
 *
 * Mirrors the things in-process-handler pattern: `claudecode.run` is best
 * served by gateway-owned local code that drives the injected
 * {@link SandboxedClaudeLauncher} (which wraps the real `claude` spawn in
 * `sandbox-exec`), so the bridge intercepts its id and runs the launcher directly,
 * then normalizes + audits the result. The `claudecode.how-to-use` SKILL takes the
 * standard `BaseCapabilityBridge` path.
 *
 *   claudecode.run → launcher.run({ prompt, cwd? })  (EXECUTE, sandbox-confined)
 *
 * The launcher is INJECTED (constructor) or built from the live platform seam. The
 * REAL spawn is gated behind `PLEXUS_CC_HEADLESS_LAUNCH=1` inside the launcher
 * (default OFF = record-mode), so tests + the e2e demo never auto-spawn a real CC.
 *
 * AUDIT (AC5/AC8): every invoke records `sandboxed:true` + the jail dir + the
 * confinement mechanism in the audit detail (redaction-safe — never the prompt text
 * or CC's output). A `VaultConfinementError` (cwd escapes the authorized dir) is
 * surfaced as a clean `transport_error`.
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
import { getPlatformServices } from "../../platform/index.ts";
import { CLAUDECODE_SOURCE_ID, CLAUDECODE_RUN_ID } from "./entries.ts";
import { SandboxedClaudeLauncher, type SandboxedRunResult } from "./launcher.ts";

/** Strict-ish string accessor. */
function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** Project the launcher result onto the wire output (audit-friendly). */
/**
 * MINIMAL wire projection — what the CALLING AGENT receives. The confinement
 * diagnostics (absolute jail path, home dir, install path, full sandbox argv)
 * fingerprint the owner's machine, so they go to the audit record only (see
 * `toAuditDiagnostics`); the tool's own `output` is returned verbatim.
 */
function toData(res: SandboxedRunResult): Record<string, unknown> {
  return {
    ok: res.ok,
    launched: res.launched,
    sandboxed: res.sandboxed,
    output: res.output,
    exitCode: res.exitCode,
    ...(res.reason ? { reason: res.reason } : {}),
    op: "run",
  };
}

/**
 * OWNER-facing confinement diagnostics — audit `detail` only. The prompt is MASKED
 * out of the argv copy (it already rides the audit `input`, redacted + truncated by
 * the single writer).
 */
function toAuditDiagnostics(res: SandboxedRunResult, prompt: string): Record<string, unknown> {
  // The launcher builds argv from the TRIMMED prompt, so mask both forms — a raw
  // prompt with surrounding whitespace must not survive into the audit detail.
  const trimmed = prompt.trim();
  return {
    launched: res.launched,
    profile: res.profile,
    argv: res.argv.map((a) => (a === prompt || a === trimmed ? "«prompt»" : a)),
    confinement: res.confinement,
  };
}

export class ClaudecodeBridge extends BaseCapabilityBridge {
  private readonly launcher: SandboxedClaudeLauncher;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    launcher?: SandboxedClaudeLauncher,
  ) {
    super(CLAUDECODE_SOURCE_ID, deps, sessionId, entries);
    // Inject the launcher (tests substitute a fake-spawn / fake-claude launcher).
    // Default: confine to ~/PlexusDemo/pomodoro, resolve `claude` via the platform seam.
    this.launcher =
      launcher ??
      new SandboxedClaudeLauncher({
        resolveBinary: (name) => getPlatformServices().resolveBinary(name),
      });
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (req.id !== CLAUDECODE_RUN_ID) {
      // The how-to-use SKILL (and anything else) takes the standard base path.
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

    const input = req.input ?? {};
    const prompt = strOf(input.prompt);

    let result: TransportResult;
    let res: SandboxedRunResult | undefined;
    if (!prompt) {
      result = { ok: false, error: { code: "schema_validation_failed", message: "`prompt` is required" } };
    } else {
      try {
        const cwd = strOf(input.cwd);
        res = await this.launcher.run({ prompt, ...(cwd ? { cwd } : {}) });
        result = res.ok
          ? { ok: true, data: toData(res) }
          : {
              ok: false,
              data: toData(res),
              error: { code: "transport_error", message: res.reason ?? "sandboxed launch failed" },
            };
      } catch (err) {
        // A cwd that escapes the authorized dir (VaultConfinementError) — or any other
        // launch failure — surfaces as a clean transport_error (never a thrown crash).
        const message = err instanceof Error ? err.message : String(err);
        result = { ok: false, error: { code: "transport_error", message } };
      }
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: op + confinement posture + OWNER-facing diagnostics (argv with
      // the prompt masked) — never the raw prompt or output. Diagnostics live HERE (the
      // owner's Activity view), not on the wire result the agent sees.
      detail: {
        transport: "in-process",
        kind: entry.kind,
        op: "run",
        sandboxed: true,
        jail: this.launcher.jail,
        mechanism: this.launcher.mechanism,
        ...(res && prompt ? toAuditDiagnostics(res, prompt) : {}),
      },
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
