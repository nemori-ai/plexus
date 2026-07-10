/**
 * browser self-describe ENTRIES (READ-ONLY first-party source).
 *
 * The `browser` source exposes the user's browsers (Safari + Google Chrome) as a
 * STRICTLY READ-ONLY surface:
 *
 *   - `browser.tabs.list`        — the currently OPEN tabs (title + url + window) of both
 *                                  browsers via fixed AppleScript/JXA reads.
 *   - `browser.bookmarks.search` — bookmarks whose title/url contains a substring, bounded.
 *   - `browser.history.search`   — browsing history by title/url substring + optional date
 *                                  range, bounded, newest first.
 *
 * ALL THREE are `grants:["read"]` — READ-ONLY BY CONSTRUCTION: the provider seam
 * (`BrowserProvider`) has no navigate/open/close/write/delete method anywhere, and the
 * sqlite files are only ever COPIED to a temp path and read there.
 *
 * DEGRADE PER-BROWSER: every result carries a `browsers.safari` / `browsers.chrome`
 * section `{ status: "ok"|"unavailable", count, note? }` — a browser that is not
 * installed / not running / unreadable (Safari without Full Disk Access) contributes an
 * empty list plus a note, and NEVER breaks the other browser's rows.
 *
 * All capability entries are `transport:"ipc"` with an `extras.route.op` the bridge
 * intercepts (the in-process-handler pattern shared with sysinfo/workspace). A
 * `browser.how-to-use` SKILL ships the usage guide. Ids follow the derivation rule
 * `browser.<noun>.<verb>`; the source id is reserved via MODULES (first-party provenance).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from "./provider.ts";

/** Stable source id for the browser first-party adapter. */
export const BROWSER_SOURCE_ID = "browser" as const;

/** Capability + skill ids (id-derivation: browser.<noun>.<verb>). */
export const BROWSER_TABS_LIST_ID = "browser.tabs.list" as const;
export const BROWSER_BOOKMARKS_SEARCH_ID = "browser.bookmarks.search" as const;
export const BROWSER_HISTORY_SEARCH_ID = "browser.history.search" as const;
export const BROWSER_HOW_TO_USE_ID = "browser.how-to-use" as const;

const VERSION = "0.1.0";

/** The per-browser degradation section schema fragment shared by all three outputs. */
const BROWSERS_SECTION_DESCRIPTION =
  "Per-browser degradation: { safari: { status: 'ok'|'unavailable', count, note? }, chrome: " +
  "{ … } }. `unavailable` carries the reason in `note` (e.g. Safari data needs Full Disk " +
  "Access); a browser that is not installed or not running is `ok` with an explanatory note " +
  "and simply contributes no rows. Partial results are normal — never treat one browser's " +
  "unavailability as a failure of the call.";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadHowToSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-browser.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use browser (read-only)\n" +
      "List open tabs (`browser.tabs.list`, {}), search bookmarks " +
      "(`browser.bookmarks.search`, { query, limit? }), and search history " +
      "(`browser.history.search`, { query, start?, end?, limit? }). Results are bounded " +
      "(default 20) and merged from Safari + Chrome with per-browser `browsers` status " +
      "sections; a browser being unavailable never breaks the other. Read-only."
    );
  }
}

/** TABS.LIST: the currently open tabs of Safari + Chrome. */
function tabsList(): CapabilityEntry {
  return {
    id: BROWSER_TABS_LIST_ID,
    source: BROWSER_SOURCE_ID,
    kind: "capability",
    label: "List open browser tabs",
    describe:
      "List the tabs currently OPEN in the user's browsers (Safari + Google Chrome) READ-ONLY " +
      "— each row is { browser, window, title, url }. Use when you need to know what the user " +
      "is looking at right now: 'what was that page I had open', resuming research, or citing " +
      "the user's current context. Takes no input (call with {}). A browser that is not " +
      "running or not installed contributes an EMPTY list plus a per-browser note — that is " +
      "normal, not an error. Requires macOS Automation access to each browser (one-time " +
      "approval). It cannot open, close, navigate, or modify any tab.",
    io: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          tabs: {
            type: "array",
            description:
              "Open tabs: { browser: 'safari'|'chrome', window: number (1-based), title: " +
              "string, url: string }.",
          },
          browsers: { type: "object", description: BROWSERS_SECTION_DESCRIPTION },
        },
        required: ["tabs", "browsers"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BROWSER_HOW_TO_USE_ID, label: "How to use browser (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: BROWSER_TABS_LIST_ID } },
  };
}

/** BOOKMARKS.SEARCH: substring search over both browsers' bookmarks, bounded. */
function bookmarksSearch(): CapabilityEntry {
  return {
    id: BROWSER_BOOKMARKS_SEARCH_ID,
    source: BROWSER_SOURCE_ID,
    kind: "capability",
    label: "Search browser bookmarks",
    describe:
      "Search the user's Safari + Google Chrome BOOKMARKS by title/url substring READ-ONLY — " +
      "returns { browser, title, url, folder } rows, merged across both browsers and BOUNDED " +
      `(default ${SEARCH_LIMIT_DEFAULT}, hard-capped at ${SEARCH_LIMIT_MAX}). Use when the user asks 'did I bookmark…' ` +
      "or you need a saved link you know roughly by name or domain. Input: { query: string " +
      "(required, case-insensitive substring), limit?: number }. Safari bookmarks live in a " +
      "protected file — without Full Disk Access the Safari half degrades to " +
      "`browsers.safari.status:'unavailable'` while Chrome results still return. Never writes.",
    io: {
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Substring matched case-insensitively against bookmark title OR url.",
          },
          limit: {
            type: "number",
            description: `Max merged rows. Default ${SEARCH_LIMIT_DEFAULT}; clamped to 1..${SEARCH_LIMIT_MAX}.`,
          },
        },
        required: ["query"],
      },
      output: {
        type: "object",
        properties: {
          bookmarks: {
            type: "array",
            description:
              "Matches: { browser: 'safari'|'chrome', title: string, url: string, folder: " +
              "string ('/'-joined folder path, may be '') }.",
          },
          browsers: { type: "object", description: BROWSERS_SECTION_DESCRIPTION },
        },
        required: ["bookmarks", "browsers"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BROWSER_HOW_TO_USE_ID, label: "How to use browser (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: BROWSER_BOOKMARKS_SEARCH_ID } },
  };
}

/** HISTORY.SEARCH: substring + optional date-range search, newest first, bounded. */
function historySearch(): CapabilityEntry {
  return {
    id: BROWSER_HISTORY_SEARCH_ID,
    source: BROWSER_SOURCE_ID,
    kind: "capability",
    label: "Search browser history",
    describe:
      "Search the user's Safari + Google Chrome browsing HISTORY by title/url substring, with " +
      "an optional date range, READ-ONLY — returns { browser, title, url, lastVisited } rows " +
      `merged NEWEST FIRST and BOUNDED (default ${SEARCH_LIMIT_DEFAULT}, hard-capped at ${SEARCH_LIMIT_MAX}). Use when the ` +
      "user asks 'what was that site I visited…' or you need to reconstruct what was read and " +
      "when. Input: { query: string (required), start?: ISO date, end?: ISO date, limit?: " +
      "number } — timestamps come back as ISO-8601 UTC (converted from each browser's native " +
      "epoch). The history databases are only ever COPIED to a temp path and read there, so a " +
      "running Chrome never blocks the read. Safari history requires Full Disk Access — " +
      "without it the Safari half degrades per-browser while Chrome results still return. " +
      "Never writes.",
    io: {
      input: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Substring matched case-insensitively against page title OR url.",
          },
          start: {
            type: "string",
            description:
              "Optional ISO-8601 lower bound (inclusive) on the visit time. Compute from the " +
              "current date you were given — do NOT copy a literal example date.",
          },
          end: {
            type: "string",
            description: "Optional ISO-8601 upper bound (inclusive). Must be after `start` when both given.",
          },
          limit: {
            type: "number",
            description: `Max merged rows (newest first). Default ${SEARCH_LIMIT_DEFAULT}; clamped to 1..${SEARCH_LIMIT_MAX}.`,
          },
        },
        required: ["query"],
      },
      output: {
        type: "object",
        properties: {
          visits: {
            type: "array",
            description:
              "Matches, newest first: { browser: 'safari'|'chrome', title: string, url: " +
              "string, lastVisited: ISO-8601 UTC }.",
          },
          browsers: { type: "object", description: BROWSERS_SECTION_DESCRIPTION },
        },
        required: ["visits", "browsers"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: BROWSER_HOW_TO_USE_ID, label: "How to use browser (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: BROWSER_HISTORY_SEARCH_ID } },
  };
}

/** The how-to-use SKILL (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: BROWSER_HOW_TO_USE_ID,
    source: BROWSER_SOURCE_ID,
    kind: "skill",
    label: "How to use browser (read-only)",
    describe:
      "Usage guidance for the browser capabilities: list open tabs (read), search bookmarks " +
      "(read, bounded), search history (read, bounded, newest first, ISO timestamps). All " +
      "read-only, merged from Safari + Chrome with PER-BROWSER degradation sections — one " +
      "browser being unavailable (e.g. Safari without Full Disk Access) never breaks the " +
      "other's results. Read-as-context; not invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The browser entry set: three READ capabilities (tabs / bookmarks / history) + the
 * how-to-use skill. UNGATED — availability (is any browser's data reachable?) is reported
 * via HEALTH and per-call `browsers` sections, never by hiding entries.
 */
export function browserEntries(): CapabilityEntry[] {
  return [tabsList(), bookmarksSearch(), historySearch(), howToUseSkill()];
}
