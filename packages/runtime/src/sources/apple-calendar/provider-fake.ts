/**
 * Apple Calendar — FAKE `CalendarProvider` (deterministic in-memory fixtures, no macOS).
 *
 * This is the hermetic OS-access implementation: it serves a fixed set of sample calendars
 * and events with NO `osascript`, NO Calendar.app, and NO TCC permission. The source
 * selects it when `PLEXUS_FAKE_APPLE=1` (tests + the hermetic e2e set this), or it can be
 * injected directly into the source constructor for unit tests.
 *
 * `available()` always reports `{ ok:true }` (the fake needs no permission), so health is
 * green under the fake. `listEvents` honors the validated window (overlap filter) and the
 * optional calendar filter, so window/calendar behavior is exercised deterministically.
 *
 * Forcing a not-authorized state for tests: construct with `{ notAuthorized: true }` — then
 * `available()` reports the TCC reason and the read methods throw `CalendarNotAuthorizedError`,
 * exactly mirroring the real un-granted path WITHOUT touching macOS.
 */

import {
  CalendarNotAuthorizedError,
  USER_FACING_TCC_MESSAGE,
  type CalendarAvailability,
  type CalendarEvent,
  type CalendarProvider,
  type CalendarsListResult,
  type DateWindow,
  type EventsListResult,
} from "./calendar-reader.ts";

/** The deterministic sample calendars the fake exposes. */
export const FAKE_CALENDARS = ["Home", "Work", "Birthdays"] as const;

/**
 * The deterministic sample events. Chosen to span a few days in mid-2026 so a typical
 * window query returns a stable, assertable subset.
 */
export const FAKE_EVENTS: CalendarEvent[] = [
  {
    title: "Team sync",
    start: "2026-06-24T15:00:00.000Z",
    end: "2026-06-24T15:30:00.000Z",
    calendar: "Work",
    location: null,
    notes: null,
  },
  {
    title: "Dentist",
    start: "2026-06-25T09:00:00.000Z",
    end: "2026-06-25T10:00:00.000Z",
    calendar: "Home",
    location: "12 Main St",
    notes: "Bring insurance card",
  },
  {
    title: "Alex's birthday",
    start: "2026-06-27T00:00:00.000Z",
    end: "2026-06-28T00:00:00.000Z",
    calendar: "Birthdays",
    location: null,
    notes: null,
  },
];

/** Construction options for the fake provider. */
export interface FakeCalendarProviderOptions {
  /** Override the sample calendars. */
  calendars?: string[];
  /** Override the sample events. */
  events?: CalendarEvent[];
  /** Force the un-granted (TCC) state — available() reports the reason, reads throw. */
  notAuthorized?: boolean;
}

/**
 * In-memory fixture provider. Deterministic, permission-free. Honors the window + calendar
 * filters so window-validation and calendar-filter behavior are testable through it.
 */
export class FakeCalendarProvider implements CalendarProvider {
  private readonly calendars: string[];
  private readonly events: CalendarEvent[];
  private readonly notAuthorized: boolean;

  constructor(opts: FakeCalendarProviderOptions = {}) {
    this.calendars = opts.calendars ?? [...FAKE_CALENDARS];
    this.events = opts.events ?? FAKE_EVENTS;
    this.notAuthorized = opts.notAuthorized ?? false;
  }

  async available(): Promise<CalendarAvailability> {
    return this.notAuthorized ? { ok: false, reason: USER_FACING_TCC_MESSAGE } : { ok: true };
  }

  async listCalendars(): Promise<CalendarsListResult> {
    if (this.notAuthorized) throw new CalendarNotAuthorizedError();
    return { calendars: [...this.calendars] };
  }

  async listEvents(window: DateWindow): Promise<EventsListResult> {
    if (this.notAuthorized) throw new CalendarNotAuthorizedError();
    const events = this.events.filter((e) => {
      // Overlap filter: event starts before window end AND ends after window start.
      const startMs = Date.parse(e.start);
      const endMs = Date.parse(e.end);
      const overlaps = startMs < window.endMs && endMs > window.startMs;
      const calMatch = !window.calendar || e.calendar === window.calendar;
      return overlaps && calMatch;
    });
    return { events };
  }
}
