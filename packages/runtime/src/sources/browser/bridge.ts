/**
 * browser PER-SESSION bridge (READ-ONLY first-party source).
 *
 * Mirrors the sysinfo in-process-handler pattern: the three browser capabilities are
 * served by gateway-owned local code that drives the injected {@link BrowserProvider}
 * (real osascript/fs/sqlite by default; fake fixtures under `PLEXUS_FAKE_BROWSER=1` or
 * when injected), so the bridge intercepts their ids, validates input FIRST, runs the
 * provider, then normalizes + audits (the `ipc` transport wire is never reached). The
 * `browser.how-to-use` SKILL takes the standard `BaseCapabilityBridge` path.
 *
 *   browser.tabs.list        → provider.listTabs()                       (READ, osascript)
 *   browser.bookmarks.search → provider.searchBookmarks(query, limit)    (READ, fs/plutil)
 *   browser.history.search   → provider.searchHistory({query, range…})   (READ, copied sqlite)
 *
 * VALIDATION before the provider is touched: `query` must be a non-empty string;
 * `start`/`end`, when present, must parse as dates (and `end` after `start`); `limit` is
 * clamped (default 20, cap 200). Bad input → `schema_validation_failed`, provider untouched.
 *
 * PER-BROWSER failures are NOT errors here — the provider degrades them into the result's
 * `browsers` sections (partial results + notes), so the invoke stays ok:true. Only a
 * whole-provider throw becomes a `transport_error` (last-resort, never a crash).
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
  BROWSER_SOURCE_ID,
  BROWSER_TABS_LIST_ID,
  BROWSER_BOOKMARKS_SEARCH_ID,
  BROWSER_HISTORY_SEARCH_ID,
} from "./entries.ts";
import {
  clampLimit,
  selectBrowserProvider,
  type BrowserProvider,
  type HistoryQuery,
} from "./provider.ts";

/** An in-process handler: input + provider → real local read → TransportResult. */
type BrowserHandler = (
  input: Record<string, unknown>,
  provider: BrowserProvider,
) => Promise<TransportResult>;

/** A clean pre-dispatch input rejection (provider never touched). */
function badInput(message: string): TransportResult {
  return { ok: false, error: { code: "schema_validation_failed", message: `browser: ${message}` } };
}

/** Extract + validate the required non-empty `query` string, or undefined when invalid. */
function requireQuery(input: Record<string, unknown>): string | undefined {
  const q = input.query;
  return typeof q === "string" && q.trim().length > 0 ? q : undefined;
}

/**
 * Validate `{ query, start?, end?, limit? }` into a {@link HistoryQuery}. We never trust
 * the agent's date strings: each is parsed to epoch-ms, range-checked, and only the
 * validated numbers cross into the provider (which converts them to each browser's epoch).
 */
export function validateHistoryInput(
  input: Record<string, unknown>,
): { ok: true; q: HistoryQuery } | { ok: false; message: string } {
  const query = requireQuery(input);
  if (!query) return { ok: false, message: "`query` is required and must be a non-empty string" };

  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const [key, val] of [["start", input.start], ["end", input.end]] as const) {
    if (val === undefined || val === null) continue;
    if (typeof val !== "string" || !Number.isFinite(Date.parse(val))) {
      return { ok: false, message: `\`${key}\` is not a valid ISO date: ${JSON.stringify(val)}` };
    }
    if (key === "start") startMs = Date.parse(val);
    else endMs = Date.parse(val);
  }
  if (startMs !== undefined && endMs !== undefined && endMs <= startMs) {
    return { ok: false, message: "`end` must be after `start`" };
  }
  return {
    ok: true,
    q: {
      query,
      limit: clampLimit(input.limit),
      ...(startMs !== undefined ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs } : {}),
    },
  };
}

const HANDLERS: Record<string, BrowserHandler> = {
  [BROWSER_TABS_LIST_ID]: async (_input, provider) => {
    const result = await provider.listTabs();
    return { ok: true, data: result };
  },
  [BROWSER_BOOKMARKS_SEARCH_ID]: async (input, provider) => {
    const query = requireQuery(input);
    if (!query) return badInput("`query` is required and must be a non-empty string");
    const result = await provider.searchBookmarks(query, clampLimit(input.limit));
    return { ok: true, data: result };
  },
  [BROWSER_HISTORY_SEARCH_ID]: async (input, provider) => {
    const v = validateHistoryInput(input);
    if (!v.ok) return badInput(v.message);
    const result = await provider.searchHistory(v.q);
    return { ok: true, data: result };
  },
};

export class BrowserBridge extends BaseCapabilityBridge {
  private readonly provider: BrowserProvider;

  constructor(
    deps: BridgeDeps,
    sessionId: string,
    entries: CapabilityEntry[],
    provider?: BrowserProvider,
  ) {
    super(BROWSER_SOURCE_ID, deps, sessionId, entries);
    // Real by default; fake when PLEXUS_FAKE_BROWSER=1; or an injected provider (tests).
    this.provider = selectBrowserProvider(provider);
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
      // Last-resort catch: per-browser failures are degraded INSIDE the provider, so only a
      // truly unexpected throw lands here — and it must NEVER crash the gateway.
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
      // Redaction-safe: the op name + kind only, never queries/urls/titles.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}
