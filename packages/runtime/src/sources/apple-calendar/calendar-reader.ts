/**
 * Apple Calendar — READ-ONLY reader core + the `CalendarProvider` OS-access seam.
 *
 * This module is the security-critical heart of the apple-calendar first-party source.
 * It holds:
 *   - the `CalendarProvider` interface — the INJECTABLE OS-access seam the source reads
 *     through (`available()` / `listCalendars()` / `listEvents()`). Two implementations
 *     live in `provider-real.ts` (shells `osascript`/JXA, triggers macOS TCC) and
 *     `provider-fake.ts` (deterministic in-memory fixtures, no macOS permission needed);
 *   - the FIXED JXA (`osascript -l JavaScript`) script templates the REAL provider shells
 *     — NO agent-controlled script body is ever executed; only narrowly-validated,
 *     self-re-serialized numeric epoch-ms dates are substituted, and even those go in via
 *     the JXA `run(argv)` argument vector (never string-interpolated into the script text);
 *   - strict input validation (parse both dates, reject invalid / end<start / >60d);
 *   - robust parsing of the script's JSON stdout;
 *   - graceful detection of the macOS TCC "not authorized" error (-1743) so a missing
 *     Automation/Calendar permission is a recoverable, clearly-messaged state, not a crash.
 *
 * READ-ONLY BY CONSTRUCTION: the only AppleScript verbs used are `whose`, property reads,
 * and `get` over calendars/events. There is no `make`, `delete`, or `set` in any template,
 * so this source cannot mutate calendar data, and both capabilities require only `["read"]`.
 */

// ── §1  Validation limits ─────────────────────────────────────────────────────

/** Max event window the events.list capability will scan (anti-runaway / privacy). */
export const MAX_WINDOW_DAYS = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A validated, re-serialized date window — epoch-ms is what we hand to the provider. */
export interface DateWindow {
  /** Inclusive lower bound, epoch ms (UTC). */
  startMs: number;
  /** Exclusive-ish upper bound, epoch ms (UTC). */
  endMs: number;
  /** The canonical ISO strings we re-serialized ourselves (never the agent's raw text). */
  startIso: string;
  endIso: string;
  /** Optional calendar-name filter (validated to a non-empty string or undefined). */
  calendar?: string;
}

/** Raised when the {start,end} input fails validation. Carries a stable, agent-legible message. */
export class CalendarInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarInputError";
  }
}

/**
 * Parse + validate a `{ start, end, calendar? }` window. We NEVER trust the agent's
 * string: we parse it to a number, range-check it, and re-serialize our own ISO from
 * the epoch-ms. Only the epoch-ms numbers (+ an optional validated calendar name) cross
 * into the provider. Rules:
 *   - both `start` and `end` must be present strings that parse to a finite time;
 *   - `end` must be strictly after `start`;
 *   - the window must be ≤ MAX_WINDOW_DAYS;
 *   - `calendar`, if present, must be a non-empty string.
 */
export function validateWindow(input: Record<string, unknown>): DateWindow {
  const start = input.start;
  const end = input.end;
  if (typeof start !== "string" || start.trim() === "") {
    throw new CalendarInputError("`start` is required and must be an ISO date string");
  }
  if (typeof end !== "string" || end.trim() === "") {
    throw new CalendarInputError("`end` is required and must be an ISO date string");
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs)) {
    throw new CalendarInputError(`\`start\` is not a valid date: ${JSON.stringify(start)}`);
  }
  if (!Number.isFinite(endMs)) {
    throw new CalendarInputError(`\`end\` is not a valid date: ${JSON.stringify(end)}`);
  }
  if (endMs <= startMs) {
    throw new CalendarInputError("`end` must be strictly after `start`");
  }
  const days = (endMs - startMs) / MS_PER_DAY;
  if (days > MAX_WINDOW_DAYS) {
    throw new CalendarInputError(
      `window too large (${days.toFixed(1)} days > ${MAX_WINDOW_DAYS} day limit) — narrow the range`,
    );
  }
  let calendar: string | undefined;
  if (input.calendar !== undefined && input.calendar !== null) {
    if (typeof input.calendar !== "string" || input.calendar.trim() === "") {
      throw new CalendarInputError("`calendar`, when present, must be a non-empty string");
    }
    calendar = input.calendar;
  }
  // Re-serialize OUR OWN canonical ISO from the validated epoch-ms — the agent's raw
  // strings never flow onward.
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    ...(calendar ? { calendar } : {}),
  };
}

// ── §2  Output shapes ─────────────────────────────────────────────────────────

export interface CalendarsListResult {
  calendars: string[];
}

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  calendar: string;
  location: string | null;
  notes: string | null;
}

export interface EventsListResult {
  events: CalendarEvent[];
}

/** Result of an availability probe — the source's health() reads this. */
export interface CalendarAvailability {
  ok: boolean;
  /** Human-readable reason when !ok (e.g. the precise TCC onboarding instruction). */
  reason?: string;
}

// ── §3  The OS-access seam ──────────────────────────────────────────────────────

/**
 * The OS-access seam the apple-calendar source reads through. The REAL implementation
 * (`provider-real.ts`) shells `osascript`/JXA and triggers macOS TCC; the FAKE
 * implementation (`provider-fake.ts`) serves deterministic in-memory fixtures with no
 * macOS permission. The source selects the provider (real by default; fake when
 * `PLEXUS_FAKE_APPLE=1`, or injected directly for unit tests).
 *
 * Every method is READ-ONLY — there is no create/update/delete on the interface, so the
 * read-only guarantee holds at the seam, not just in a particular implementation.
 */
export interface CalendarProvider {
  /**
   * Probe whether Calendar access is reachable RIGHT NOW (app present + TCC granted for
   * the real provider; always ok for the fake). Never throws — a denial/timeout degrades
   * to `{ ok:false, reason }` with a precise onboarding message.
   */
  available(): Promise<CalendarAvailability>;
  /** READ-ONLY: list the NAMES of the user's calendars. */
  listCalendars(): Promise<CalendarsListResult>;
  /** READ-ONLY: list events overlapping a validated window (optionally one calendar). */
  listEvents(window: DateWindow): Promise<EventsListResult>;
}

/** Raised for a recognized TCC denial — mapped to a graceful transport error upstream. */
export class CalendarNotAuthorizedError extends Error {
  constructor(message: string = USER_FACING_TCC_MESSAGE) {
    super(message);
    this.name = "CalendarNotAuthorizedError";
  }
}

/** The precise onboarding instruction surfaced for an un-granted TCC state. */
export const USER_FACING_TCC_MESSAGE =
  "Calendar access not granted — approve Plexus in System Settings ▸ Privacy & Security ▸ " +
  "Automation (allow control of “Calendar”) and ▸ Calendars, then retry.";

// ── §4  FIXED JXA script templates (no agent-controlled body) ─────────────────
//
// These are CONSTANT JXA programs the REAL provider shells. The only dynamic data they
// ever receive is two numeric epoch-ms values for the events query, fed via the JXA
// `run(argv)` argument vector (NOT string-interpolated into the script). osascript passes
// everything after the script as `argv` strings; the script parses them back to numbers
// itself. This keeps the "no arbitrary script execution" invariant TRUE BY CONSTRUCTION.

/** A read-only liveness probe: emit the calendar names (used by available() too). */
export const LIST_CALENDARS_JXA = `
function run() {
  var app = Application("Calendar");
  var cals = app.calendars();
  var names = [];
  for (var i = 0; i < cals.length; i++) {
    names.push(cals[i].name());
  }
  return JSON.stringify({ calendars: names });
}
`.trim();

/**
 * JXA: given argv = [startMs, endMs], emit
 *   { "events": [ { title, start, end, calendar, location, notes }, ... ] }
 * Events are filtered by overlap with [start, end) using a `whose` query for speed.
 * All dates are emitted as ISO strings. READ-ONLY: only property reads + `whose`.
 */
export const LIST_EVENTS_JXA = `
function run(argv) {
  var startMs = parseInt(argv[0], 10);
  var endMs = parseInt(argv[1], 10);
  var start = new Date(startMs);
  var end = new Date(endMs);
  var app = Application("Calendar");
  var cals = app.calendars();
  var out = [];
  for (var i = 0; i < cals.length; i++) {
    var cal = cals[i];
    var calName = cal.name();
    var evs = cal.events.whose({ _and: [ { startDate: { _lessThan: end } }, { endDate: { _greaterThan: start } } ] })();
    for (var j = 0; j < evs.length; j++) {
      var ev = evs[j];
      var loc = null, notes = null;
      try { loc = ev.location(); } catch (e) {}
      try { notes = ev.description(); } catch (e) {}
      out.push({
        title: ev.summary(),
        start: ev.startDate().toISOString(),
        end: ev.endDate().toISOString(),
        calendar: calName,
        location: loc || null,
        notes: notes || null
      });
    }
  }
  return JSON.stringify({ events: out });
}
`.trim();

// ── §5  Command runner seam (dependency-injectable, used by the REAL provider) ──

/** The result of running a command: exit code + captured stdout/stderr. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a fixed program with a fixed argv. Injected so tests can simulate osascript
 * WITHOUT a live Calendar/TCC. The runner takes a COMMAND + ARGV array — there is no
 * shell, so nothing is word-split or interpolated.
 */
export type CommandRunner = (command: string, args: string[]) => Promise<RunResult>;

/** The osascript error code macOS returns when Automation/Calendar access is not granted. */
const NOT_AUTHORIZED_CODE = "-1743";

/**
 * Recognize the macOS TCC denial in a runner result. Returns true for the classic
 * `errAEEventNotPermitted` (-1743) and the textual "Not authorized" / "not allowed to
 * send Apple events" forms osascript prints to stderr.
 */
export function isNotAuthorized(res: RunResult): boolean {
  const blob = `${res.stderr}`.toLowerCase();
  return (
    res.stderr.includes(NOT_AUTHORIZED_CODE) ||
    blob.includes("not authorized") ||
    blob.includes("not allowed to send apple events") ||
    blob.includes("not been granted")
  );
}

// ── §6  Robust JSON-stdout parsing (shared by the REAL provider) ───────────────

/**
 * Parse the JSON the JXA script emitted on stdout. osascript may print a trailing
 * newline; JXA's `return` of a string prints it verbatim. We trim and JSON.parse, and
 * defensively shape the result so a malformed payload surfaces as a clear error rather
 * than leaking `undefined`s downstream.
 */
function parseJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new Error("apple-calendar: empty output from osascript");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`apple-calendar: could not parse osascript output as JSON: ${trimmed.slice(0, 200)}`);
  }
}

export function parseCalendarsResult(stdout: string): CalendarsListResult {
  const parsed = parseJsonStdout(stdout) as { calendars?: unknown };
  const cals = parsed?.calendars;
  if (!Array.isArray(cals) || !cals.every((c) => typeof c === "string")) {
    throw new Error("apple-calendar: malformed calendars payload (expected string[])");
  }
  return { calendars: cals as string[] };
}

export function parseEventsResult(stdout: string): EventsListResult {
  const parsed = parseJsonStdout(stdout) as { events?: unknown };
  const evs = parsed?.events;
  if (!Array.isArray(evs)) {
    throw new Error("apple-calendar: malformed events payload (expected array)");
  }
  const events: CalendarEvent[] = evs.map((raw) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    return {
      title: typeof e.title === "string" ? e.title : "",
      start: typeof e.start === "string" ? e.start : "",
      end: typeof e.end === "string" ? e.end : "",
      calendar: typeof e.calendar === "string" ? e.calendar : "",
      location: typeof e.location === "string" ? e.location : null,
      notes: typeof e.notes === "string" ? e.notes : null,
    };
  });
  return { events };
}

/** Apply the optional calendar-name filter (done in TS, post-read, read-only). */
export function filterByCalendar(result: EventsListResult, calendar?: string): EventsListResult {
  if (!calendar) return result;
  return { events: result.events.filter((e) => e.calendar === calendar) };
}
