/**
 * Apple Calendar — reader/provider UNIT tests (no live Calendar/TCC).
 *
 * Covers the security-critical core via the injectable seams:
 *   - `validateWindow` (missing / non-string / unparseable / reversed / >60-day /
 *     60-day boundary / optional calendar filter);
 *   - the REAL provider against a FAKE `CommandRunner`: the FIXED scripts are the ones
 *     shelled, argv carries only numeric epoch-ms, output parsing for both shapes,
 *     malformed/empty output errors, TCC `-1743` → not-authorized, and `available()`;
 *   - the FAKE provider: deterministic fixtures, window + calendar filtering, and the
 *     forced not-authorized state.
 */

import { describe, it, expect } from "bun:test";

import {
  CalendarInputError,
  CalendarNotAuthorizedError,
  LIST_CALENDARS_JXA,
  LIST_EVENTS_JXA,
  MAX_WINDOW_DAYS,
  validateWindow,
  type CommandRunner,
  type RunResult,
} from "@plexus/runtime/sources/apple-calendar/calendar-reader.ts";
import { RealCalendarProvider } from "@plexus/runtime/sources/apple-calendar/provider-real.ts";
import {
  FAKE_CALENDARS,
  FAKE_EVENTS,
  FakeCalendarProvider,
} from "@plexus/runtime/sources/apple-calendar/provider-fake.ts";

const DAY = 24 * 60 * 60 * 1000;

// ── validateWindow ────────────────────────────────────────────────────────────
describe("apple-calendar validateWindow", () => {
  it("rejects missing / non-string start or end", () => {
    expect(() => validateWindow({})).toThrow(CalendarInputError);
    expect(() => validateWindow({ start: "2026-01-01T00:00:00Z" })).toThrow(CalendarInputError);
    expect(() => validateWindow({ start: 1, end: 2 } as never)).toThrow(CalendarInputError);
  });

  it("rejects unparseable dates", () => {
    expect(() => validateWindow({ start: "not-a-date", end: "2026-01-02T00:00:00Z" })).toThrow(
      /not a valid date/,
    );
  });

  it("rejects a reversed / equal window", () => {
    expect(() =>
      validateWindow({ start: "2026-06-30T00:00:00Z", end: "2026-06-23T00:00:00Z" }),
    ).toThrow(/after `start`/);
    expect(() =>
      validateWindow({ start: "2026-06-23T00:00:00Z", end: "2026-06-23T00:00:00Z" }),
    ).toThrow(/after `start`/);
  });

  it("rejects a window > 60 days but accepts the 60-day boundary", () => {
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    const over = new Date(start + (MAX_WINDOW_DAYS + 1) * DAY).toISOString();
    const exact = new Date(start + MAX_WINDOW_DAYS * DAY).toISOString();
    expect(() => validateWindow({ start: "2026-01-01T00:00:00Z", end: over })).toThrow(/window too large/);
    const ok = validateWindow({ start: "2026-01-01T00:00:00Z", end: exact });
    expect(ok.startMs).toBe(start);
  });

  it("re-serializes canonical ISO and carries an optional calendar filter", () => {
    const w = validateWindow({
      start: "2026-06-23T00:00:00Z",
      end: "2026-06-30T00:00:00Z",
      calendar: "Work",
    });
    expect(w.startIso).toBe("2026-06-23T00:00:00.000Z");
    expect(w.calendar).toBe("Work");
  });

  it("rejects an empty-string calendar filter", () => {
    expect(() =>
      validateWindow({ start: "2026-06-23T00:00:00Z", end: "2026-06-30T00:00:00Z", calendar: "" }),
    ).toThrow(/non-empty string/);
  });
});

// ── REAL provider against a fake CommandRunner ─────────────────────────────────
function runner(opts: { calendars?: string[]; events?: unknown[]; notAuthorized?: boolean; code?: number; stdout?: string }): {
  run: CommandRunner;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const run: CommandRunner = async (command, args): Promise<RunResult> => {
    calls.push({ command, args });
    if (opts.notAuthorized) {
      return { code: 1, stdout: "", stderr: "execution error: Not authorized to send Apple events (-1743)" };
    }
    if (opts.stdout !== undefined || opts.code !== undefined) {
      return { code: opts.code ?? 0, stdout: opts.stdout ?? "", stderr: "" };
    }
    const script = args.find((a) => a.includes("function run")) ?? "";
    if (script.includes("calendars: names")) {
      return { code: 0, stdout: JSON.stringify({ calendars: opts.calendars ?? [] }), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify({ events: opts.events ?? [] }), stderr: "" };
  };
  return { run, calls };
}

describe("apple-calendar RealCalendarProvider (fake CommandRunner)", () => {
  it("shells the FIXED list-calendars script and parses { calendars }", async () => {
    const { run, calls } = runner({ calendars: ["Home", "Work"] });
    const provider = new RealCalendarProvider(run);
    const out = await provider.listCalendars();
    expect(out.calendars).toEqual(["Home", "Work"]);
    // It shelled osascript -l JavaScript -e <FIXED script> — no agent-controlled body.
    const call = calls[0]!;
    expect(call.command).toBe("osascript");
    expect(call.args).toContain("JavaScript");
    expect(call.args).toContain(LIST_CALENDARS_JXA);
  });

  it("events.list passes ONLY numeric epoch-ms argv to the FIXED events script", async () => {
    const event = {
      title: "Team sync",
      start: "2026-06-24T15:00:00.000Z",
      end: "2026-06-24T15:30:00.000Z",
      calendar: "Work",
      location: null,
      notes: null,
    };
    const { run, calls } = runner({ events: [event] });
    const provider = new RealCalendarProvider(run);
    const window = validateWindow({ start: "2026-06-23T00:00:00Z", end: "2026-06-30T00:00:00Z" });
    const out = await provider.listEvents(window);
    expect(out.events).toEqual([event]);

    const args = calls[0]!.args;
    expect(args).toContain(LIST_EVENTS_JXA);
    // The two trailing argv are the numeric epoch-ms — never the agent's raw strings.
    const trailing = args.slice(-2);
    expect(trailing).toEqual([String(window.startMs), String(window.endMs)]);
    expect(trailing.every((a) => /^\d+$/.test(a))).toBe(true);
  });

  it("the FIXED events script uses BULK property access (no per-EVENT property reads)", () => {
    // STRUCTURAL perf assertion: each property is fetched across ALL events at once
    // (`evs.summary()` / `evs.startDate()` / `evs.endDate()`), and the inner loop only
    // INDEXES the parallel arrays — it never calls a property accessor on a single
    // event (the old `ev.summary()` / `ev.startDate()` per-event Apple-Event pattern).
    expect(LIST_EVENTS_JXA).toContain("evs.summary()");
    expect(LIST_EVENTS_JXA).toContain("evs.startDate()");
    expect(LIST_EVENTS_JXA).toContain("evs.endDate()");
    expect(LIST_EVENTS_JXA).toContain("titles[j]");
    // No per-event property calls remain.
    expect(LIST_EVENTS_JXA).not.toContain("ev.summary()");
    expect(LIST_EVENTS_JXA).not.toContain("ev.startDate()");
    expect(LIST_EVENTS_JXA).not.toContain("ev.endDate()");
  });

  it("applies the optional calendar filter post-read", async () => {
    const events = [
      { title: "A", start: "2026-06-24T00:00:00Z", end: "2026-06-24T01:00:00Z", calendar: "Work", location: null, notes: null },
      { title: "B", start: "2026-06-24T00:00:00Z", end: "2026-06-24T01:00:00Z", calendar: "Home", location: null, notes: null },
    ];
    const { run } = runner({ events });
    const provider = new RealCalendarProvider(run);
    const window = validateWindow({ start: "2026-06-23T00:00:00Z", end: "2026-06-30T00:00:00Z", calendar: "Home" });
    const out = await provider.listEvents(window);
    expect(out.events.map((e) => e.title)).toEqual(["B"]);
  });

  it("maps a TCC -1743 denial to CalendarNotAuthorizedError", async () => {
    const { run } = runner({ notAuthorized: true });
    const provider = new RealCalendarProvider(run);
    await expect(provider.listCalendars()).rejects.toBeInstanceOf(CalendarNotAuthorizedError);
  });

  it("errors clearly on empty / malformed osascript output", async () => {
    const empty = new RealCalendarProvider(runner({ stdout: "" }).run);
    await expect(empty.listCalendars()).rejects.toThrow(/empty output/);
    const bad = new RealCalendarProvider(runner({ stdout: "<<not json>>" }).run);
    await expect(bad.listCalendars()).rejects.toThrow(/could not parse/);
  });

  it("available() reflects the probe: ok on success, reason on TCC denial", async () => {
    const okp = new RealCalendarProvider(runner({ calendars: ["Home"] }).run);
    expect(await okp.available()).toEqual({ ok: true });
    const denied = new RealCalendarProvider(runner({ notAuthorized: true }).run);
    const a = await denied.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("Calendar access not granted");
  });
});

// ── FAKE provider ──────────────────────────────────────────────────────────────
describe("apple-calendar FakeCalendarProvider", () => {
  it("lists the deterministic sample calendars and is available", async () => {
    const provider = new FakeCalendarProvider();
    expect(await provider.available()).toEqual({ ok: true });
    expect((await provider.listCalendars()).calendars).toEqual([...FAKE_CALENDARS]);
  });

  it("filters events by window overlap and by calendar name", async () => {
    const provider = new FakeCalendarProvider();
    // A window covering only 2026-06-24 → just the Work "Team sync".
    const narrow = validateWindow({ start: "2026-06-24T00:00:00Z", end: "2026-06-25T00:00:00Z" });
    const got = await provider.listEvents(narrow);
    expect(got.events.map((e) => e.title)).toEqual(["Team sync"]);

    // Whole-window, filtered to Home → just the Dentist.
    const wide = validateWindow({ start: "2026-06-23T00:00:00Z", end: "2026-06-30T00:00:00Z", calendar: "Home" });
    const home = await provider.listEvents(wide);
    expect(home.events.map((e) => e.title)).toEqual(["Dentist"]);
    expect(FAKE_EVENTS.length).toBe(3);
  });

  it("forced not-authorized: available() reports the reason, reads throw", async () => {
    const provider = new FakeCalendarProvider({ notAuthorized: true });
    const a = await provider.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("Calendar access not granted");
    await expect(provider.listCalendars()).rejects.toBeInstanceOf(CalendarNotAuthorizedError);
  });
});
