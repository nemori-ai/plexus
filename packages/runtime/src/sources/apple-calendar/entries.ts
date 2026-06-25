/**
 * Apple Calendar self-describe ENTRIES (READ-ONLY first-party source, v1).
 *
 * Two READ capabilities + a bundled how-to-use skill, mirroring the cc-master/obsidian
 * first-party entry-set pattern:
 *
 *  - `apple-calendar.calendars.list` — list the NAMES of the user's calendars (no input).
 *  - `apple-calendar.events.list`    — list events overlapping a ≤60-day window.
 *  - `apple-calendar.how-to-use`     — the bundled usage skill (read-as-context).
 *
 * READ-ONLY BY CONSTRUCTION: both capabilities declare `grants: ["read"]`, and the
 * underlying provider seam (`CalendarProvider`) has no write/create/update/delete method.
 * There is no mutating path anywhere in the source — that is the safety story.
 *
 * The source id is reserved in `RESERVED_SOURCE_IDS`, so every entry is gateway-stamped
 * `provenance: "first-party"` and a wire extension cannot impersonate it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id + capability/skill names for the Apple Calendar source. */
export const APPLE_CALENDAR_SOURCE_ID = "apple-calendar" as const;
export const CALENDARS_LIST_ID = "apple-calendar.calendars.list" as const;
export const EVENTS_LIST_ID = "apple-calendar.events.list" as const;
export const CALENDAR_SKILL_ID = "apple-calendar.how-to-use" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-calendar.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return "# How to use Apple Calendar (read-only)\nList calendars, then list events in a date window (≤60 days). Read-only.";
  }
}

/** READ-ONLY: list the names of the user's calendars (no input). */
function calendarsList(): CapabilityEntry {
  return {
    id: CALENDARS_LIST_ID,
    source: APPLE_CALENDAR_SOURCE_ID,
    kind: "capability",
    label: "List Apple Calendar calendars",
    describe:
      "List the NAMES of the user's Apple Calendar calendars READ-ONLY. " +
      "Use this first to discover which calendars exist (e.g. 'Home', 'Work') before " +
      "reading events. Takes no input. Returns { calendars: string[] }. " +
      "Requires macOS Automation/Calendar access (one-time approval). Never writes.",
    io: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        description: "{ calendars: string[] } — the names of the user's calendars.",
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: CALENDAR_SKILL_ID, label: "How to use Apple Calendar (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "calendars.list" } },
  };
}

/** READ-ONLY: list events overlapping a validated ≤60-day window. */
function eventsList(): CapabilityEntry {
  return {
    id: EVENTS_LIST_ID,
    source: APPLE_CALENDAR_SOURCE_ID,
    kind: "capability",
    label: "List Apple Calendar events in a date window",
    describe:
      "List events from the user's Apple Calendar within a date window READ-ONLY. " +
      "Use when you need the user's meetings/appointments to answer scheduling questions. " +
      "Input: { start: ISO date, end: ISO date, calendar?: string } — the window MUST be " +
      "≤ 60 days and end after start; pass `calendar` to filter to one calendar by name. " +
      "Returns { events: [{ title, start, end, calendar, location, notes }] } (location/notes " +
      "may be null). Requires macOS Automation/Calendar access (one-time approval). Never writes.",
    io: {
      input: {
        type: "object",
        properties: {
          start: { type: "string", description: "ISO-8601 window start, e.g. '2026-06-23T00:00:00Z'." },
          end: { type: "string", description: "ISO-8601 window end (after start; window ≤ 60 days)." },
          calendar: { type: "string", description: "Optional calendar name to filter to (from calendars.list)." },
        },
        required: ["start", "end"],
      },
      output: {
        type: "object",
        description: "{ events: [{ title, start, end, calendar, location, notes }] }.",
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: CALENDAR_SKILL_ID, label: "How to use Apple Calendar (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "events.list" } },
  };
}

/** The bundled how-to-use SKILL entry (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: CALENDAR_SKILL_ID,
    source: APPLE_CALENDAR_SOURCE_ID,
    kind: "skill",
    label: "How to use Apple Calendar (read-only)",
    describe:
      "Usage guidance for apple-calendar.calendars.list and apple-calendar.events.list: " +
      "discover calendars first, then query a ≤60-day window; read-only; handle the " +
      "not-authorized (TCC) case by telling the user to grant Automation/Calendar access.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The apple-calendar entry set: two read capabilities + the how-to-use skill. Always the
 * same set (the source is read-only and has no config gate); when the provider is
 * unavailable the entries are still exposed and inherit the source's `unavailable` health.
 */
export function appleCalendarEntries(): CapabilityEntry[] {
  return [calendarsList(), eventsList(), howToUseSkill()];
}
