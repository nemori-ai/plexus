/**
 * Claude Code sandboxed-run PER-SESSION bridge (first-party source).
 *
 * Mirrors the things in-process-handler pattern: `claudecode.run` is best
 * served by gateway-owned local code that drives the injected
 * {@link SandboxedClaudeLauncher} (which runs the real `claude` NATIVELY — CC's own
 * sandbox write-confines it), so the bridge intercepts its id and runs the launcher
 * directly, then normalizes + audits the result. The `claudecode.how-to-use` SKILL
 * takes the standard `BaseCapabilityBridge` path.
 *
 *   claudecode.run → launcher.run({ prompt, cwd? })  (EXECUTE, write-confined)
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
import { VaultConfinementError } from "../obsidian/vault-reader.ts";
import { CLAUDECODE_SOURCE_ID, CLAUDECODE_RUN_ID } from "./entries.ts";
import { SandboxedClaudeLauncher, type SandboxedRunResult } from "./launcher.ts";

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
 * SANITIZE a NON-ZERO-EXIT run into a PATH-FREE, agent-facing message.
 *
 * The launcher sets `reason` to the tool's raw STDERR on a failed run, and Claude Code's
 * stderr is its whole transcript — opening with a banner that states the absolute jail path
 * (including the owner's username), the model and the sandbox configuration. Returning it
 * verbatim handed the caller a fingerprint of the owner's machine through the ERROR channel,
 * defeating the wire/audit split the success path already honours.
 *
 * What the caller needs to act is the FACT of failure and the exit code. What the failure
 * actually SAID is the owner's information: it goes to the audit as `failureOutput`, which
 * the writer keeps tail-first under a diagnostics cap. Two different questions, two channels.
 */
function sanitizeRunFailure(exitCode: number | null): string {
  const code = typeof exitCode === "number" ? ` (exit ${exitCode})` : "";
  return (
    `the sandboxed Claude Code run failed${code}. Its output is recorded in the owner's audit ` +
    `record and is not returned on the wire; ask the owner to check Plexus → Activity for ` +
    `the reason.`
  );
}

/** Project the launcher result onto the wire output (audit-friendly). */
/**
 * BOUND the owner-only failure output before it reaches the audit.
 *
 * The audit's `detail` is redacted but NOT size-capped, so a raw transcript handed over
 * whole would put an unbounded blob in the JSONL — the one thing the writer's contract
 * forbids. Bound it here, at the producer, because only the producer knows the shape of the
 * value: this is a transcript, so the CAUSE is at the END. A head-biased clip would keep the
 * startup banner and throw away the error — which is exactly how a 66 KB `codex` failure got
 * recorded as its banner and nothing else.
 */
const FAILURE_OUTPUT_MAX = 8000;
function boundFailureOutput(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.length > FAILURE_OUTPUT_MAX
    ? `…[+${reason.length - FAILURE_OUTPUT_MAX} chars before]\n${reason.slice(-FAILURE_OUTPUT_MAX)}`
    : reason;
}

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
    argv: res.argv.map((a) => (a === prompt || a === trimmed ? "«prompt»" : a)),
    confinement: res.confinement,
    // The resume handle (real launches only) — the Activity view renders it as a
    // copyable `claude --resume <id>` (run from the launch cwd) so the owner can
    // replay the session in a local terminal. Owner-side only.
    ...(res.sessionId ? { sessionId: res.sessionId } : {}),
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
    // Default: confine to ~/.plexus/workspace/claudecode, resolve `claude` via the seam.
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
    // The RAW error (host jail path, fs ENOENT/EACCES, confinement detail) for the
    // OWNER's audit record ONLY — it never rides the wire result the agent sees.
    let launchErrorDetail: string | undefined;
    /** A failed run's raw output — audit-only (see `sanitizeRunFailure`). */
    let launchFailureOutput: string | undefined;
    if (!prompt) {
      result = { ok: false, error: { code: "schema_validation_failed", message: "`prompt` is required" } };
    } else {
      try {
        const cwd = strOf(input.cwd);
        res = await this.launcher.run({ prompt, ...(cwd ? { cwd } : {}) });
        if (res.ok) {
          result = { ok: true, data: toData(res) };
        } else if (res.launched) {
          // A REAL spawn that exited non-zero — the ONLY branch whose `reason` is the tool's
          // raw stderr (Claude Code's whole transcript, opening with a banner that states the
          // absolute jail path, the model and the sandbox config). Owner-only: it goes to the
          // audit as `failureOutput`, and the agent gets a sanitized summary. `reason` is also
          // dropped from `data` — belt-and-braces, since `normalizeResult` already discards
          // `data` on a failed result. Identical split to codex.run's.
          launchFailureOutput = boundFailureOutput(res.reason);
          const { reason: _ownerOnly, ...wireData } = toData(res);
          result = {
            ok: false,
            data: wireData,
            error: { code: "transport_error", message: sanitizeRunFailure(res.exitCode) },
          };
        } else {
          // Never spawned — `reason` is a CURATED string (record mode, `claude` not on PATH),
          // not tool output, so it stays on the wire.
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
        // The real (path-bearing) launch failure lives HERE only — off the wire.
        ...(launchErrorDetail ? { launchError: launchErrorDetail } : {}),
        // The failing run's OWN output — what answers "why did it fail". The key name is
        // load-bearing: the audit writer keeps `failureOutput` tail-first under a
        // diagnostics cap. The caller never sees it (see `sanitizeRunFailure`).
        ...(launchFailureOutput ? { failureOutput: launchFailureOutput } : {}),
      },
      // Request + result for the Activity view (writer redacts + truncates). Without
      // these the owner's audit shows "no params" for every run — the prompt/cwd rides
      // `input` (redacted by the writer), the run result rides `output`, matching codex.
      input,
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
