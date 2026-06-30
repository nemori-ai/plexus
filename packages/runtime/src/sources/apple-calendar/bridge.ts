/**
 * Apple Calendar PER-SESSION bridge (READ-ONLY, v1).
 *
 * Mirrors the cc-master/obsidian in-process-handler pattern: the two read capabilities
 * are served by REAL in-process handlers that read through the injected `CalendarProvider`
 * (real osascript by default; fake fixtures under `PLEXUS_FAKE_APPLE=1` or when injected).
 * The how-to-use SKILL takes the standard base path (skills are read-as-context, never
 * invoked over a wire).
 *
 *  - `apple-calendar.calendars.list` → `provider.listCalendars()`.
 *  - `apple-calendar.events.list`    → validate the {start,end[,calendar]} window FIRST
 *    (parse + re-serialize + ≤60-day cap), then `provider.listEvents(window)`. A bad /
 *    oversized / reversed window is rejected with a clear `invalid_input` transport_error
 *    BEFORE the provider is touched; a TCC denial surfaces as a graceful not-authorized
 *    transport_error (clear onboarding message), never a crash.
 *
 * READ-ONLY BY CONSTRUCTION: only the provider's read methods are reachable here.
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
  APPLE_CALENDAR_SOURCE_ID,
  CALENDARS_LIST_ID,
  EVENTS_LIST_ID,
  appleCalendarEntries,
} from "./entries.ts";
import {
  CalendarInputError,
  CalendarNotAuthorizedError,
  validateWindow,
  type CalendarProvider,
} from "./calendar-reader.ts";
import { resolveCalendarProvider } from "./provider-select.ts";

/** Map a provider/validation error to a graceful, structured `transport_error`. */
function readerErrorResult(entry: CapabilityEntry, err: unknown): TransportResult {
  if (err instanceof CalendarNotAuthorizedError) {
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: err.message,
        capabilityId: entry.id,
        detail: { reason: "not_authorized" },
      },
    };
  }
  if (err instanceof CalendarInputError) {
    return {
      ok: false,
      error: {
        code: "transport_error",
        message: `apple-calendar: invalid input: ${err.message}`,
        capabilityId: entry.id,
        detail: { reason: "invalid_input" },
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "transport_error",
      message: err instanceof Error ? err.message : String(err),
      capabilityId: entry.id,
    },
  };
}

export class AppleCalendarBridge extends BaseCapabilityBridge {
  private readonly provider: CalendarProvider;

  constructor(deps: BridgeDeps, sessionId: string, entries: CapabilityEntry[], provider?: CalendarProvider) {
    super(APPLE_CALENDAR_SOURCE_ID, deps, sessionId, entries);
    // Inject the provider (tests substitute a fake); default selects real/fake by env.
    this.provider = provider ?? resolveCalendarProvider();
  }

  override async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    if (req.id !== CALENDARS_LIST_ID && req.id !== EVENTS_LIST_ID) {
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
      if (req.id === CALENDARS_LIST_ID) {
        const data = await this.provider.listCalendars();
        result = { ok: true, data };
      } else {
        // VALIDATE the window BEFORE touching the provider (bad input never reaches osascript).
        const window = validateWindow(req.input ?? {});
        const data = await this.provider.listEvents(window);
        result = { ok: true, data };
      }
    } catch (err) {
      result = readerErrorResult(entry, err);
    }

    const audit = await this.deps.audit({
      type: "invoke",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: result.ok ? "ok" : "error",
      // Redaction-safe: the op name + kind only, never the window dates or event content.
      detail: { transport: "in-process", kind: entry.kind, op: req.id },
      // Request + result for the Activity view (writer redacts + truncates).
      input: req.input ?? {},
      output: result.ok ? result.data : result.error,
    });
    return normalizeResult(entry.id, result, audit.id);
  }
}

/** Re-export so the module factory can build the full read-only entry set. */
export { appleCalendarEntries };
