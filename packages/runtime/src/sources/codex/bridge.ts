/**
 * Codex sandboxed-run PER-SESSION bridge (first-party source).
 *
 * Mirrors the claudecode in-process-handler pattern: `codex.run` is best served by
 * gateway-owned local code that drives the injected {@link SandboxedCodexLauncher}
 * (which wraps the real `codex exec` spawn in `sandbox-exec`), so the bridge
 * intercepts its id and runs the launcher directly, then normalizes + audits the
 * result. The `codex.how-to-use` SKILL takes the standard `BaseCapabilityBridge` path.
 *
 *   codex.run → launcher.run({ prompt, cwd? })  (EXECUTE, sandbox-confined)
 *
 * The launcher is INJECTED (constructor) or built from the live platform seam. The
 * REAL spawn is gated behind `PLEXUS_CODEX_HEADLESS_LAUNCH=1` inside the launcher
 * (default OFF = record-mode), so tests + the demo never auto-spawn a real Codex.
 *
 * DEGRADE, DON'T CRASH: when the local `codex` CLI is ABSENT, the launcher reports
 * `binaryMissing` and the bridge surfaces a clean `source_unavailable` ErrorCode
 * (advisory) — never a thrown crash. A `VaultConfinementError` (cwd escapes the
 * authorized dir) is surfaced as a clean `transport_error`.
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
import { CODEX_SOURCE_ID, CODEX_RUN_ID } from "./entries.ts";
import { SandboxedCodexLauncher, type SandboxedRunResult } from "./launcher.ts";

/** Strict-ish string accessor. */
function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** Project the launcher result onto the wire output (audit-friendly). */
function toData(res: SandboxedRunResult): Record<string, unknown> {
  return {
    ok: res.ok,
    launched: res.launched,
    sandboxed: res.sandboxed,
    jail: res.jail,
    profile: res.profile,
    argv: res.argv,
    output: res.output,
    exitCode: res.exitCode,
    confinement: res.confinement,
    ...(res.binaryMissing ? { binaryMissing: res.binaryMissing } : {}),
    ...(res.reason ? { reason: res.reason } : {}),
    op: "run",
  };
}

export class CodexBridge extends BaseCapabilityBridge {
  private readonly launcher: SandboxedCodexLauncher;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    launcher?: SandboxedCodexLauncher,
  ) {
    super(CODEX_SOURCE_ID, deps, sessionId, entries);
    // Inject the launcher (tests substitute a fake-spawn / fake-codex launcher).
    // Default: confine to ~/PlexusDemo/pomodoro, resolve `codex` via the platform seam.
    this.launcher =
      launcher ??
      new SandboxedCodexLauncher({
        resolveBinary: (name) => getPlatformServices().resolveBinary(name),
      });
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (req.id !== CODEX_RUN_ID) {
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
    if (!prompt) {
      result = { ok: false, error: { code: "schema_validation_failed", message: "`prompt` is required" } };
    } else {
      try {
        const cwd = strOf(input.cwd);
        const res = await this.launcher.run({ prompt, ...(cwd ? { cwd } : {}) });
        if (res.ok) {
          result = { ok: true, data: toData(res) };
        } else if (res.binaryMissing) {
          // The local `codex` CLI is absent — advisory degrade, NOT a crash.
          result = {
            ok: false,
            data: toData(res),
            error: {
              code: "source_unavailable",
              message: res.reason ?? "Codex CLI (`codex`) not found on PATH",
            },
          };
        } else {
          result = {
            ok: false,
            data: toData(res),
            error: { code: "transport_error", message: res.reason ?? "sandboxed launch failed" },
          };
        }
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
      // Redaction-safe: the op + confinement posture only, never the prompt or output.
      detail: {
        transport: "in-process",
        kind: entry.kind,
        op: "run",
        sandboxed: true,
        jail: this.launcher.jail,
        mechanism: "sandbox-exec",
      },
      // Request + result for the Activity view (writer redacts + truncates).
      input,
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
