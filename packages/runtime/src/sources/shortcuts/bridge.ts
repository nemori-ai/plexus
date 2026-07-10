/**
 * Apple Shortcuts PER-SESSION bridge (first-party source).
 *
 * Mirrors the claudecode/codex in-process-handler pattern: `shortcuts.list` and
 * `shortcuts.run` are served by gateway-owned local code driving the injected
 * {@link ShortcutsProvider}; the `shortcuts.how-to-use` SKILL takes the standard
 * `BaseCapabilityBridge` path. Every invoke is normalized + audited.
 *
 * THE EXECUTE GATE (the point of this source): `shortcuts.run` follows the
 * claudecode record-mode precedent EXACTLY —
 *
 *   - gate OFF (default): NOTHING executes. The bridge returns a clean
 *     `ok:true, launched:false` record-mode result carrying the exact
 *     `shortcuts run <name> [-i «input»]` command that WOULD have run
 *     (assembled + audited, never spawned). The provider is NOT called, so the
 *     fake and the real backend are gated identically.
 *   - gate ON (`shortcutsLaunchEnabled()` — persisted console setting wins,
 *     `PLEXUS_SHORTCUTS_LAUNCH=1` env fallback): the provider executes the
 *     shortcut with a hard timeout and the result is returned verbatim.
 *
 * DEGRADE, DON'T CRASH: a missing `shortcuts` CLI (non-macOS) surfaces as the
 * `source_unavailable` ErrorCode (advisory), never a thrown crash.
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
  SHORTCUTS_LIST_ID,
  SHORTCUTS_RUN_ID,
  SHORTCUTS_SOURCE_ID,
} from "./entries.ts";
import {
  buildRunArgs,
  clampRunTimeout,
  INPUT_PLACEHOLDER,
  SHORTCUTS_BINARY,
  selectShortcutsProvider,
  shortcutsLaunchEnabled,
  type ShortcutRunOutcome,
  type ShortcutsProvider,
} from "./provider.ts";

/** Strict-ish string accessor (non-empty after trim). */
function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/**
 * The record-mode reason the CALLING AGENT sees. Points at the owner-side control
 * the agent can reason about — the console — not the env var (which the agent can't
 * set, and which a persisted console setting overrides anyway, per ADR-021 precedence).
 */
export const RECORD_MODE_REASON =
  "record mode: the owner has not enabled real launch for this source (Plexus console → What I expose → Shortcuts → Real launch), so the command was assembled and audited but not executed" as const;

/** The wire projection of one run outcome — what the CALLING AGENT receives. */
function toData(res: ShortcutRunOutcome): Record<string, unknown> {
  return {
    ok: res.ok,
    launched: res.launched,
    output: res.output,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    ...(res.binaryMissing ? { binaryMissing: res.binaryMissing } : {}),
    ...(res.reason ? { reason: res.reason } : {}),
    op: "run",
  };
}

export class ShortcutsBridge extends BaseCapabilityBridge {
  private readonly provider: ShortcutsProvider;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: ShortcutsProvider,
  ) {
    super(SHORTCUTS_SOURCE_ID, deps, sessionId, entries);
    // Inject the provider (tests force the fake); default selection honors
    // PLEXUS_FAKE_SHORTCUTS=1, else the real CLI provider.
    this.provider = selectShortcutsProvider(provider);
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (req.id !== SHORTCUTS_LIST_ID && req.id !== SHORTCUTS_RUN_ID) {
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

    return req.id === SHORTCUTS_LIST_ID
      ? this.invokeList(entry, req, ctx)
      : this.invokeRun(entry, req, ctx);
  }

  /** shortcuts.list — READ, straight through the provider. */
  private async invokeList(
    entry: CapabilityEntry,
    req: InvokeRequest,
    ctx: InvokeContext,
  ): Promise<InvokeResponse> {
    let result: TransportResult;
    try {
      const listing = await this.provider.listShortcuts();
      result = { ok: true, data: { shortcuts: listing.shortcuts, folders: listing.folders } };
    } catch (err) {
      result = {
        ok: false,
        error: {
          code: "transport_error",
          message: err instanceof Error ? err.message : String(err),
        },
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
      // Redaction-safe: op + kind only.
      detail: { transport: "in-process", kind: entry.kind, op: "list" },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }

  /** shortcuts.run — EXECUTE, record-mode by default (the owner opt-in gate). */
  private async invokeRun(
    entry: CapabilityEntry,
    req: InvokeRequest,
    ctx: InvokeContext,
  ): Promise<InvokeResponse> {
    const input = req.input ?? {};
    const name = strOf(input.name);
    const inputText = typeof input.input === "string" ? input.input : undefined;
    const timeoutMs = clampRunTimeout(input.timeoutMs);

    // The exact command that runs (or would run). The agent's input TEXT never rides
    // an argv — the real runner passes a temp FILE path; here the placeholder stands in.
    const predictedArgv = name
      ? [SHORTCUTS_BINARY, ...buildRunArgs(name, inputText !== undefined ? INPUT_PLACEHOLDER : undefined)]
      : undefined;

    const realLaunch = shortcutsLaunchEnabled();

    let result: TransportResult;
    let outcome: ShortcutRunOutcome | undefined;
    // The RAW provider failure for the OWNER's audit record only — off the wire.
    let runErrorDetail: string | undefined;
    if (!name) {
      result = { ok: false, error: { code: "schema_validation_failed", message: "`name` is required" } };
    } else if (!realLaunch) {
      // ── RECORD MODE (default): assemble + audit, never execute. The provider is
      // not consulted, so a fake backend is gated exactly like the real one.
      result = {
        ok: true,
        data: {
          ok: true,
          launched: false,
          output: "",
          exitCode: null,
          timedOut: false,
          reason: RECORD_MODE_REASON,
          op: "run",
        },
      };
    } else {
      try {
        outcome = await this.provider.runShortcut({
          name,
          ...(inputText !== undefined ? { input: inputText } : {}),
          timeoutMs,
        });
        if (outcome.ok) {
          result = { ok: true, data: toData(outcome) };
        } else if (outcome.binaryMissing) {
          // The `shortcuts` CLI is absent (non-macOS) — advisory degrade, NOT a crash.
          result = {
            ok: false,
            data: toData(outcome),
            error: {
              code: "source_unavailable",
              message: outcome.reason ?? "the `shortcuts` CLI is not available on this machine",
            },
          };
        } else {
          result = {
            ok: false,
            data: toData(outcome),
            error: { code: "transport_error", message: outcome.reason ?? "shortcut run failed" },
          };
        }
      } catch (err) {
        // The provider is designed not to throw, but a genuine surprise surfaces as a
        // clean transport_error with a generic message; the raw detail is audit-only.
        runErrorDetail = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          error: { code: "transport_error", message: "the Shortcuts backend failed to run the shortcut" },
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
      // Redaction-safe, OWNER-facing diagnostics: op + gate posture + the exact argv
      // (the input text is a placeholder — it rides the audit `input`, where the
      // single writer redacts + truncates). Never the shortcut's output.
      detail: {
        transport: "in-process",
        kind: entry.kind,
        op: "run",
        realLaunch,
        launched: outcome?.launched ?? false,
        ...(predictedArgv ? { argv: predictedArgv } : {}),
        ...(outcome?.timedOut ? { timedOut: true } : {}),
        // The real (raw) provider failure lives HERE only — off the wire.
        ...(runErrorDetail ? { runError: runErrorDetail } : {}),
      },
      // Request + result for the Activity view (writer redacts + truncates).
      input,
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
