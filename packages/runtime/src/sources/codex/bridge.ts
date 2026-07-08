/**
 * Codex sandboxed-run PER-SESSION bridge (first-party source).
 *
 * Mirrors the claudecode in-process-handler pattern: `codex.run` is best served by
 * gateway-owned local code that drives the injected {@link SandboxedCodexLauncher}
 * (which runs the real `codex exec` NATIVELY — Codex's own sandbox write-confines it),
 * so the bridge intercepts its id and runs the launcher directly, then normalizes +
 * audits the result. The `codex.how-to-use` SKILL takes the standard `BaseCapabilityBridge` path.
 *
 *   codex.run → launcher.run({ prompt, cwd? })  (EXECUTE, write-confined)
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
import { VaultConfinementError } from "../obsidian/vault-reader.ts";
import { CODEX_SOURCE_ID, CODEX_RUN_ID } from "./entries.ts";
import { SandboxedCodexLauncher, type SandboxedRunResult } from "./launcher.ts";

/** Strict-ish string accessor. */
function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/**
 * SANITIZE a thrown launch/confinement error into a PATH-FREE, agent-facing message.
 * The raw `err.message` from `confineCwd`/`realpathSync` carries the ABSOLUTE host jail
 * path + its existence status (an fs ENOENT/EACCES leak), and a `VaultConfinementError`
 * echoes the agent's requested cwd — neither belongs on the wire. We map to ONE of two
 * generic messages and keep the real detail in the AUDIT record only (see invoke()).
 */
function sanitizeLaunchError(err: unknown): string {
  if (err instanceof VaultConfinementError) {
    return "the requested working directory is outside the authorized workspace";
  }
  return "the coding workspace is not available — ask the owner to configure its authorized directory in Plexus";
}

/**
 * MINIMAL wire projection — what the CALLING AGENT receives. Deliberately excludes
 * the confinement diagnostics (absolute jail path, the owner's home dir, the tool's
 * install path/version, the full sandbox argv): those fingerprint the owner's machine
 * and are the OWNER's information — they go to the audit record via
 * `toAuditDiagnostics`, never over the wire. The tool's own `output` is returned
 * verbatim (the gateway never rewrites what the tool said).
 */
function toData(res: SandboxedRunResult): Record<string, unknown> {
  return {
    ok: res.ok,
    launched: res.launched,
    sandboxed: res.sandboxed,
    output: res.output,
    exitCode: res.exitCode,
    ...(res.binaryMissing ? { binaryMissing: res.binaryMissing } : {}),
    ...(res.reason ? { reason: res.reason } : {}),
    op: "run",
  };
}

/**
 * OWNER-facing confinement diagnostics — audit `detail` only (the Activity view).
 * The prompt is MASKED out of the argv copy (detail never carries the prompt — it
 * already rides the audit `input`, where the single writer redacts + truncates).
 */
function toAuditDiagnostics(res: SandboxedRunResult, prompt: string): Record<string, unknown> {
  // The launcher builds argv from the TRIMMED prompt, so mask both forms — a raw
  // prompt with surrounding whitespace must not survive into the audit detail.
  const trimmed = prompt.trim();
  return {
    launched: res.launched,
    argv: res.argv.map((a) => (a === prompt || a === trimmed ? "«prompt»" : a)),
    confinement: res.confinement,
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
    // Default: confine to ~/.plexus/workspace/codex, resolve `codex` via the platform seam.
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
    let res: SandboxedRunResult | undefined;
    // The RAW error (host jail path, fs ENOENT/EACCES, confinement detail) for the
    // OWNER's audit record ONLY — it never rides the wire result the agent sees.
    let launchErrorDetail: string | undefined;
    if (!prompt) {
      result = { ok: false, error: { code: "schema_validation_failed", message: "`prompt` is required" } };
    } else {
      try {
        const cwd = strOf(input.cwd);
        res = await this.launcher.run({ prompt, ...(cwd ? { cwd } : {}) });
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
        // A cwd that escapes the authorized dir (VaultConfinementError) or a missing/
        // unusable jail root (fs ENOENT/EACCES from confineCwd's realpath) surfaces as a
        // clean transport_error (never a thrown crash). The raw message carries the
        // absolute HOST path + its existence status — a machine-fingerprint leak — so we
        // return a SANITIZED, path-free message and keep the real detail audit-only.
        launchErrorDetail = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          error: { code: "transport_error", message: sanitizeLaunchError(err) },
        };
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
      // the prompt masked, profile, confinement) — never the raw prompt or output. The
      // diagnostics live HERE (the owner's Activity view), not on the wire result the
      // agent sees (see toData/toAuditDiagnostics).
      detail: {
        transport: "in-process",
        kind: entry.kind,
        op: "run",
        sandboxed: true,
        jail: this.launcher.jail,
        mechanism: this.launcher.mechanism,
        ...(res && prompt ? toAuditDiagnostics(res, prompt) : {}),
        // The real (path-bearing) launch failure lives HERE only — off the wire.
        ...(launchErrorDetail ? { launchError: launchErrorDetail } : {}),
      },
      // Request + result for the Activity view (writer redacts + truncates).
      input,
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
