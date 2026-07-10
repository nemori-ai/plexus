/**
 * Apple Photos self-describe ENTRIES (READ-ONLY-posture first-party source, v1).
 *
 * Three READ capabilities + a bundled how-to-use skill, mirroring the apple-calendar
 * first-party entry-set pattern:
 *
 *  - `apple-photos.albums.list` — albums + folders with item counts (no input).
 *  - `apple-photos.search`      — bounded METADATA search over media items.
 *  - `apple-photos.export`      — export ONE media item into the confined export jail.
 *  - `apple-photos.how-to-use`  — the bundled usage skill (read-as-context).
 *
 * READ POSTURE, STATED HONESTLY: every capability declares `grants: ["read"]` — the
 * provider seam has NO method that mutates the photo library. `export` DOES have a disk
 * side effect: it writes exactly ONE file, and ONLY into the gateway-owned jail
 * directory `~/.plexus/exports/photos/` (created if missing; destination always
 * gateway-constructed). That side effect + jail is declared verbatim in the describe
 * text and the skill, so the grant is honest, not silent.
 *
 * The source id is reserved via `MODULES` → `RESERVED_SOURCE_IDS`, so every entry is
 * gateway-stamped `provenance: "first-party"` and a wire extension cannot impersonate it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";
import { DEFAULT_SEARCH_LIMIT, MAX_ALBUMS, MAX_SEARCH_LIMIT, SEARCH_SCAN_CAP } from "./provider.ts";

/** Stable source id + capability/skill names for the Apple Photos source. */
export const APPLE_PHOTOS_SOURCE_ID = "apple-photos" as const;
export const PHOTOS_ALBUMS_LIST_ID = "apple-photos.albums.list" as const;
export const PHOTOS_SEARCH_ID = "apple-photos.search" as const;
export const PHOTOS_EXPORT_ID = "apple-photos.export" as const;
export const PHOTOS_SKILL_ID = "apple-photos.how-to-use" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-photos.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use Apple Photos (read-only)\n" +
      "List albums, search media items by metadata (album/date/filename substring — no content/ML search), " +
      "and export one item by id into the confined ~/.plexus/exports/photos/ directory. Never modifies the library."
    );
  }
}

/** READ-ONLY: albums + folders with item counts (no input). */
function albumsList(): CapabilityEntry {
  return {
    id: PHOTOS_ALBUMS_LIST_ID,
    source: APPLE_PHOTOS_SOURCE_ID,
    kind: "capability",
    label: "List Apple Photos albums and folders",
    describe:
      "List the user's Apple Photos albums and top-level folders READ-ONLY, with per-album " +
      "item counts. Use this first to discover how the photo library is organized (and to get " +
      "album names for a scoped search). Takes no input. Returns { albums: [{ id, name, " +
      `itemCount }], folders: [{ id, name, albums }], truncated } — at most ${MAX_ALBUMS} per level. ` +
      "Requires macOS Automation access to Photos (one-time approval). Never modifies the library.",
    io: {
      input: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description:
          "{ albums: [{ id, name, itemCount }], folders: [{ id, name, albums: [{ id, name, itemCount }] }], truncated }.",
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: PHOTOS_SKILL_ID, label: "How to use Apple Photos (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "albums.list" } },
  };
}

/** READ-ONLY: bounded metadata search over media items. */
function search(): CapabilityEntry {
  return {
    id: PHOTOS_SEARCH_ID,
    source: APPLE_PHOTOS_SOURCE_ID,
    kind: "capability",
    label: "Search Apple Photos media items (metadata only)",
    describe:
      "Search the user's Apple Photos media items READ-ONLY by album and/or capture-date range " +
      "and/or a filename/keyword substring. METADATA ONLY — there is no content/ML search, so it " +
      "cannot find 'photos of dogs'; it matches filenames, keywords, and dates. Use when you need " +
      "photo ids/filenames/dates to answer questions or to pick an item for apple-photos.export. " +
      "Input: { album?: string (name from albums.list — STRONGLY preferred on large libraries), " +
      "start?: ISO date, end?: ISO date, query?: string (case-insensitive substring), limit?: int " +
      `(default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}) }. An unscoped search over more than ${SEARCH_SCAN_CAP} items is ` +
      "rejected — scope with `album`. Returns { items: [{ id, filename, date, width, height, " +
      "favorite }], scanned, truncated }. Requires macOS Automation access to Photos. Never " +
      "modifies the library.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          album: {
            type: "string",
            description: "Album name (from albums.list) to scope the search to. Strongly preferred on large libraries.",
          },
          start: {
            type: "string",
            description:
              "ISO-8601 inclusive lower bound on the capture date. Compute from the current date you were given — do NOT infer today from an example.",
          },
          end: { type: "string", description: "ISO-8601 inclusive upper bound on the capture date (after start when both given)." },
          query: {
            type: "string",
            maxLength: 200,
            description: "Case-insensitive substring matched against filename + keywords (metadata only — no content search).",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            default: DEFAULT_SEARCH_LIMIT,
            description: `Max results (default ${DEFAULT_SEARCH_LIMIT}).`,
          },
        },
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description: "{ items: [{ id, filename, date, width, height, favorite }], scanned, truncated }.",
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: PHOTOS_SKILL_ID, label: "How to use Apple Photos (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "search" } },
  };
}

/** READ (with a declared, jailed disk side effect): export ONE media item by id. */
function exportItem(): CapabilityEntry {
  return {
    id: PHOTOS_EXPORT_ID,
    source: APPLE_PHOTOS_SOURCE_ID,
    kind: "capability",
    label: "Export one Apple Photos item to the confined export directory",
    describe:
      "Export ONE photo/video from Apple Photos by media-item id (from apple-photos.search) and " +
      "return the absolute file path. Use when the user wants an actual photo file on disk to " +
      "view, attach, or process. SIDE EFFECT, stated plainly: this READS the photo library and " +
      "WRITES exactly one file to disk — but ONLY inside the gateway-owned jail directory " +
      "~/.plexus/exports/photos/ (created if missing; a fresh subdirectory per export). It can " +
      "never write anywhere else on disk and never modifies the Photos library itself, which is " +
      "why it carries grants [\"read\"]. Input: { id: string }. Returns { path (absolute, inside " +
      "the jail), filename }. Requires macOS Automation access to Photos.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: 300,
            description: "The media-item id exactly as returned by apple-photos.search (e.g. '9C1B…/L0/001').",
          },
        },
        required: ["id"],
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        description: "{ path: absolute path inside ~/.plexus/exports/photos/, filename }.",
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: PHOTOS_SKILL_ID, label: "How to use Apple Photos (read-only)" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "export" } },
  };
}

/** The bundled how-to-use SKILL entry (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: PHOTOS_SKILL_ID,
    source: APPLE_PHOTOS_SOURCE_ID,
    kind: "skill",
    label: "How to use Apple Photos (read-only)",
    describe:
      "Usage guidance for apple-photos.albums.list / apple-photos.search / apple-photos.export: " +
      "discover albums first; search is METADATA-ONLY (filename/keyword/date — no content/ML " +
      "search) and bounded (default 20 results, unscoped scans capped); export writes one file " +
      "into the confined ~/.plexus/exports/photos/ directory only; handle the not-authorized " +
      "(TCC) case by pointing the user at System Settings ▸ Privacy & Security ▸ Automation ▸ Photos.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The apple-photos entry set: three read capabilities + the how-to-use skill. Always
 * the same set (no config gate); when the provider is unavailable (TCC not granted /
 * app missing) the entries are still exposed and inherit the source's `unavailable`
 * health — registration is never hard-blocked on TCC.
 */
export function applePhotosEntries(): CapabilityEntry[] {
  return [albumsList(), search(), exportItem(), howToUseSkill()];
}
