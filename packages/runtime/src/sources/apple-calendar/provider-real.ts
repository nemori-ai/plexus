/**
 * Apple Calendar — REAL `CalendarProvider` (shells `osascript`/JXA, triggers macOS TCC).
 *
 * This is the LIVE OS-access implementation: each method shells a FIXED
 * `osascript -l JavaScript` (JXA) template (from `calendar-reader.ts`) via an injectable
 * `CommandRunner` (default: `node:child_process.spawn` — argv array, NO shell). The first
 * time this runs against Calendar.app, macOS shows the one-time TCC (Automation/Calendar)
 * prompt; an un-granted call returns error `-1743`, which we detect and surface as a
 * graceful, clearly-messaged not-authorized state (never a crash, never a retry loop).
 *
 * UNTESTED-HERE (by design): the live `osascript` path needs an interactive TCC grant and
 * a running Calendar.app, so it is exercised only as a documented live smoke (see
 * `docs/research/SPIKE-apple-calendar.md` §3). Every code path here is covered against a
 * FAKE `CommandRunner` in tests; the FAKE PROVIDER (`provider-fake.ts`) covers the source
 * end-to-end without macOS at all.
 *
 * READ-ONLY BY CONSTRUCTION: only the two read templates are shelled — no mutating verb.
 */

import { spawn } from "node:child_process";

import {
  CalendarNotAuthorizedError,
  LIST_CALENDARS_JXA,
  LIST_EVENTS_JXA,
  USER_FACING_TCC_MESSAGE,
  filterByCalendar,
  isNotAuthorized,
  parseCalendarsResult,
  parseEventsResult,
  type CalendarAvailability,
  type CalendarProvider,
  type CalendarsListResult,
  type CommandRunner,
  type DateWindow,
  type EventsListResult,
  type RunResult,
} from "./calendar-reader.ts";

/** Default runner: spawn the real `osascript` (no shell; argv passed directly). */
export const spawnOsascript: CommandRunner = (command, args) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

/**
 * REAL provider — shells `osascript`/JXA. The `CommandRunner` is injectable so every path
 * (success / not-authorized / malformed) is unit-tested WITHOUT a live Calendar/TCC.
 */
export class RealCalendarProvider implements CalendarProvider {
  constructor(private readonly run: CommandRunner = spawnOsascript) {}

  /**
   * Liveness probe: run the read-only list-calendars script. A TCC denial ⇒
   * `{ ok:false, reason: <onboarding message> }`; a non-zero exit ⇒ `{ ok:false, reason }`;
   * success ⇒ `{ ok:true }`. NEVER throws — health must always resolve to a status.
   */
  async available(): Promise<CalendarAvailability> {
    try {
      const res = await this.run("osascript", ["-l", "JavaScript", "-e", LIST_CALENDARS_JXA]);
      if (isNotAuthorized(res)) return { ok: false, reason: USER_FACING_TCC_MESSAGE };
      if (res.code !== 0) {
        return {
          ok: false,
          reason: `Calendar unavailable — osascript failed (code ${res.code}): ${res.stderr.trim().slice(0, 160)}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `Calendar unavailable — could not run osascript: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** READ-ONLY: list calendar names. A TCC denial → `CalendarNotAuthorizedError`. */
  async listCalendars(): Promise<CalendarsListResult> {
    const res = await this.run("osascript", ["-l", "JavaScript", "-e", LIST_CALENDARS_JXA]);
    if (isNotAuthorized(res)) throw new CalendarNotAuthorizedError();
    if (res.code !== 0) {
      throw new Error(`apple-calendar: osascript failed (code ${res.code}): ${res.stderr.trim().slice(0, 200)}`);
    }
    return parseCalendarsResult(res.stdout);
  }

  /**
   * READ-ONLY: list events overlapping a validated window. Only the numeric epoch-ms cross
   * into the script via argv. An optional calendar filter is applied in TS post-read.
   */
  async listEvents(window: DateWindow): Promise<EventsListResult> {
    const res = await this.run("osascript", [
      "-l",
      "JavaScript",
      "-e",
      LIST_EVENTS_JXA,
      // argv to the JXA `run(argv)` — numeric strings only, never agent text.
      String(window.startMs),
      String(window.endMs),
    ]);
    if (isNotAuthorized(res)) throw new CalendarNotAuthorizedError();
    if (res.code !== 0) {
      throw new Error(`apple-calendar: osascript failed (code ${res.code}): ${res.stderr.trim().slice(0, 200)}`);
    }
    return filterByCalendar(parseEventsResult(res.stdout), window.calendar);
  }
}
