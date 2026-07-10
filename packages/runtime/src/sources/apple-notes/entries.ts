/**
 * Apple Notes self-describe ENTRIES (first-party, read + CREATE-ONLY write).
 *
 * The CONNECTOR is the macOS Notes app; the SOURCE reaches it through the injectable
 * `NotesProvider` seam (real osascript/JXA / fake in-memory). These entries are
 * served by REAL in-process handlers in `bridge.ts` (transport "ipc").
 *
 * Capabilities:
 *  - `apple-notes.folders.list` (read)  — the folders per account.
 *  - `apple-notes.notes.search` (read)  — bounded title/body search (limit ≤ 50).
 *  - `apple-notes.notes.read`   (read)  — ONE note's content by id or exact title.
 *  - `apple-notes.notes.create` (WRITE) — create a NEW note. THE ONLY WRITE.
 *  - a how-to-use SKILL attached to every capability.
 *
 * CREATE-ONLY WRITE SURFACE (product decision, structural): there is NO update, NO
 * delete, NO move, NO rename entry in this set — and none exists anywhere in the
 * source (the provider seam has no such method, the bridge has no such handler).
 * Existing notes cannot be modified or removed through Plexus; the mutation
 * capabilities do not exist rather than being merely denied.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@plexus/protocol";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./provider.ts";

/** Stable source id + capability/skill ids for the Apple Notes source. */
export const APPLE_NOTES_SOURCE_ID = "apple-notes" as const;

export const NOTES_FOLDERS_LIST_ID = "apple-notes.folders.list" as const;
export const NOTES_SEARCH_ID = "apple-notes.notes.search" as const;
export const NOTES_READ_ID = "apple-notes.notes.read" as const;
export const NOTES_CREATE_ID = "apple-notes.notes.create" as const;
export const NOTES_HOW_TO_USE_SKILL_ID = "apple-notes.skill.how-to-use" as const;

const VERSION = "0.1.0";
const SKILL_REF = { id: NOTES_HOW_TO_USE_SKILL_ID, label: "How to use Apple Notes" };

/** Load the bundled how-to-use skill body (alongside this file). */
function loadHowToUseSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-notes.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# Using Apple Notes via Plexus\n" +
      "Read folders/notes freely; search is bounded (default 20 hits). The ONLY write is " +
      "creating a NEW note — no update/delete/move capability exists. Cite notes by id or exact title."
    );
  }
}

/** read — enumerate the folders (per account). */
function foldersList(): CapabilityEntry {
  return {
    id: NOTES_FOLDERS_LIST_ID,
    source: APPLE_NOTES_SOURCE_ID,
    kind: "capability",
    label: "List Apple Notes folders",
    describe:
      "List the user's Apple Notes folders with their owning account (e.g. \"Notes\" and " +
      "\"Recipes\" in \"iCloud\"). Use FIRST to discover where notes live before searching, or to " +
      "pick a valid target folder before creating a note. Takes no input. Read-only ⇒ requires read.",
    io: {
      input: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          folders: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Folder name, e.g. \"Recipes\"." },
                account: { type: "string", description: "Owning account, e.g. \"iCloud\"." },
              },
              required: ["name", "account"],
            },
          },
        },
        required: ["folders"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [SKILL_REF],
    version: VERSION,
    extras: { firstParty: true, route: { op: "folders.list" } },
  };
}

/** read — bounded search by title/body substring. */
function notesSearch(): CapabilityEntry {
  return {
    id: NOTES_SEARCH_ID,
    source: APPLE_NOTES_SOURCE_ID,
    kind: "capability",
    label: "Search Apple Notes",
    describe:
      "Search the user's Apple Notes by a substring of the title OR body text, returning a BOUNDED " +
      `hit list (id, title, folder, modification date, short snippet — never full bodies; default ` +
      `${DEFAULT_SEARCH_LIMIT} hits, hard cap ${MAX_SEARCH_LIMIT}). Use when you need to FIND notes before reading one — ` +
      "then pass a hit's `id` to notes.read. Prefer a specific query; broad queries over a large " +
      "library are slow and truncated at the cap. Read-only ⇒ requires read.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            description: "Substring matched against note titles and body text.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            default: DEFAULT_SEARCH_LIMIT,
            description: `Max hits to return (default ${DEFAULT_SEARCH_LIMIT}, cap ${MAX_SEARCH_LIMIT}).`,
          },
        },
        required: ["query"],
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          notes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable note id — pass to notes.read." },
                title: { type: "string" },
                folder: { type: "string" },
                modifiedAt: { type: "string", description: "ISO-8601 modification date." },
                snippet: { type: "string", description: "Short plain-text excerpt (≤ ~200 chars)." },
              },
              required: ["id", "title", "folder", "modifiedAt", "snippet"],
            },
          },
        },
        required: ["notes"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [SKILL_REF],
    version: VERSION,
    extras: { firstParty: true, route: { op: "notes.search" } },
  };
}

/** read — one note's full content by id or exact title. */
function notesRead(): CapabilityEntry {
  return {
    id: NOTES_READ_ID,
    source: APPLE_NOTES_SOURCE_ID,
    kind: "capability",
    label: "Read one Apple Note",
    describe:
      "Read ONE note's full content by its `id` (preferred — from notes.search) or by EXACT `title`. " +
      "Notes bodies are stored as HTML, so the result carries BOTH `text` (plain-text extraction) " +
      "and `html` (the raw body), plus folder and creation/modification dates. Use after notes.search " +
      "when you need a note's actual content; cite the note by its id or title. Read-only ⇒ requires read.",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: { type: "string", description: "The note id (from notes.search). Preferred." },
          title: { type: "string", description: "EXACT note title — used only when `id` is omitted." },
        },
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          folder: { type: "string" },
          createdAt: { type: "string", description: "ISO-8601 creation date." },
          modifiedAt: { type: "string", description: "ISO-8601 modification date." },
          text: { type: "string", description: "Plain-text extraction of the body." },
          html: { type: "string", description: "The raw HTML body exactly as Notes stores it." },
        },
        required: ["id", "title", "text", "html"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [SKILL_REF],
    version: VERSION,
    extras: { firstParty: true, route: { op: "notes.read" } },
  };
}

/** WRITE — the ONLY write: create a NEW note. No update/delete/move exists anywhere. */
function notesCreate(): CapabilityEntry {
  return {
    id: NOTES_CREATE_ID,
    source: APPLE_NOTES_SOURCE_ID,
    kind: "capability",
    label: "Create a new Apple Note",
    describe:
      "Create a NEW note in the user's Apple Notes. Provide a `title`; optionally a plain-text `body` " +
      "and a target `folder` name (from folders.list; defaults to the default Notes folder). This " +
      "MUTATES the user's Notes (a real native write) ⇒ requires an explicit WRITE grant — use only " +
      "when the user asked to save/capture a note. CREATE-ONLY: this source cannot update, delete, " +
      "or move any existing note (those capabilities do not exist).",
    io: {
      input: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, description: "The note title (required)." },
          body: { type: "string", description: "Plain-text body; line breaks become paragraphs. Optional." },
          folder: {
            type: "string",
            description: "Target folder by name (from folders.list). Omit for the default folder.",
          },
        },
        required: ["title"],
      },
      output: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          id: { type: "string", description: "The new note's id — cite it back to the user." },
          title: { type: "string" },
          folder: { type: "string" },
        },
        required: ["id", "title", "folder"],
      },
    },
    grants: ["write"],
    transport: "ipc",
    skills: [SKILL_REF],
    version: VERSION,
    extras: { firstParty: true, route: { op: "notes.create" } },
  };
}

/** The how-to-use SKILL (read-as-context). Names the create-only write surface. */
function howToUseSkill(): CapabilityEntry {
  return {
    id: NOTES_HOW_TO_USE_SKILL_ID,
    source: APPLE_NOTES_SOURCE_ID,
    kind: "skill",
    label: "How to use Apple Notes",
    describe:
      "Usage guidance for the Apple Notes capabilities: discover folders, search bounded, read one " +
      "note (text + raw HTML), and the CREATE-ONLY write surface — creating a new note requires a " +
      "WRITE grant, and no update/delete/move capability exists. Cite notes by id or exact title.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToUseSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The apple-notes entry set: three reads, the ONE write (create), and the how-to-use
 * skill. Always the same set — availability is reported via health, never by hiding
 * entries. There is deliberately no update/delete/move entry to add.
 */
export function appleNotesEntries(): CapabilityEntry[] {
  return [foldersList(), notesSearch(), notesRead(), notesCreate(), howToUseSkill()];
}
