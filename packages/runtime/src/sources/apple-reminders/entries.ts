/**
 * Apple Reminders self-describe ENTRIES (first-party, read + write).
 *
 * The CONNECTOR is the macOS Reminders app; the SOURCE reaches it through the
 * injectable `RemindersProvider` seam (real osascript / fake in-memory). These
 * entries are served by REAL in-process handlers in `bridge.ts` (transport "ipc").
 *
 * Capabilities:
 *  - `apple-reminders.lists.list`        (read)   — the reminder lists.
 *  - `apple-reminders.reminders.list`    (read)   — reminders, optionally filtered.
 *  - `apple-reminders.reminders.create`  (WRITE)  — create a reminder (native write).
 *  - `apple-reminders.reminders.complete`(write)  — mark a reminder complete.
 *  - a how-to-use SKILL attached to the read/write capabilities.
 *
 * Each `describe` is HONEST about what it does — the create/complete entries name
 * the fact that they MUTATE the user's Reminders and therefore require a write grant.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id + capability/skill ids for the Apple Reminders source. */
export const APPLE_REMINDERS_SOURCE_ID = "apple-reminders" as const;

export const LISTS_LIST_ID = "apple-reminders.lists.list" as const;
export const REMINDERS_LIST_ID = "apple-reminders.reminders.list" as const;
export const REMINDERS_CREATE_ID = "apple-reminders.reminders.create" as const;
export const REMINDERS_COMPLETE_ID = "apple-reminders.reminders.complete" as const;
export const HOW_TO_USE_SKILL_ID = "apple-reminders.skill.how-to-use" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body (alongside this file). */
function loadHowToUseSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-reminders.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# Using Apple Reminders via Plexus\n" +
      "Read lists/reminders freely. Creating or completing a reminder MUTATES the user's " +
      "Reminders and requires an explicit WRITE grant."
    );
  }
}

/** read — enumerate the reminder lists. */
function listsList(): CapabilityEntry {
  return {
    id: LISTS_LIST_ID,
    source: APPLE_REMINDERS_SOURCE_ID,
    kind: "capability",
    label: "List Apple Reminders lists",
    describe:
      "List the user's Apple Reminders lists (e.g. \"Reminders\", \"Groceries\"). Use to discover " +
      "which list to read from or create a reminder in. Read-only ⇒ requires read.",
    io: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          lists: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
        required: ["lists"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_SKILL_ID, label: "How to use Apple Reminders" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "lists.list" } },
  };
}

/** read — list reminders, optionally filtered by list / completion. */
function remindersList(): CapabilityEntry {
  return {
    id: REMINDERS_LIST_ID,
    source: APPLE_REMINDERS_SOURCE_ID,
    kind: "capability",
    label: "List Apple Reminders",
    describe:
      "List reminders from Apple Reminders, optionally restricted to one `list` and/or by " +
      "`completed` state. Use when you need the user's to-dos to answer, summarize, or decide what " +
      "to create next. Read-only ⇒ requires read.",
    io: {
      input: {
        type: "object",
        properties: {
          list: { type: "string", description: "Restrict to one list by name. Omit for all lists." },
          completed: { type: "boolean", description: "Filter by completion. Omit for both." },
        },
      },
      output: {
        type: "object",
        properties: {
          reminders: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                list: { type: "string" },
                title: { type: "string" },
                notes: { type: "string" },
                completed: { type: "boolean" },
                dueDate: { type: "string" },
              },
            },
          },
        },
        required: ["reminders"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_SKILL_ID, label: "How to use Apple Reminders" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "reminders.list" } },
  };
}

/** WRITE — the sensitive native write: create a reminder in the user's Reminders. */
function remindersCreate(): CapabilityEntry {
  return {
    id: REMINDERS_CREATE_ID,
    source: APPLE_REMINDERS_SOURCE_ID,
    kind: "capability",
    label: "Create an Apple Reminder",
    describe:
      "Create a NEW reminder in the user's Apple Reminders. Provide a `title`; optionally a target " +
      "`list` (defaults to the default list), `notes`, and an ISO-8601 `dueDate`. This MUTATES the " +
      "user's Reminders on this Mac (a real native write) ⇒ requires an explicit WRITE grant. Use " +
      "only when the user asked to add a to-do / reminder.",
    io: {
      input: {
        type: "object",
        properties: {
          title: { type: "string", description: "The reminder title (required)." },
          list: { type: "string", description: "Target list by name. Omit for the default list." },
          notes: { type: "string", description: "Optional notes/body." },
          dueDate: { type: "string", description: "Optional ISO-8601 due date, e.g. 2026-06-26T09:00:00." },
        },
        required: ["title"],
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          list: { type: "string" },
          title: { type: "string" },
          completed: { type: "boolean" },
        },
        required: ["id", "title"],
      },
    },
    grants: ["write"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_SKILL_ID, label: "How to use Apple Reminders" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "reminders.create" } },
  };
}

/** write — mark a reminder complete. */
function remindersComplete(): CapabilityEntry {
  return {
    id: REMINDERS_COMPLETE_ID,
    source: APPLE_REMINDERS_SOURCE_ID,
    kind: "capability",
    label: "Complete an Apple Reminder",
    describe:
      "Mark an existing reminder complete by `id`. This MUTATES the user's Apple Reminders ⇒ " +
      "requires a WRITE grant. Use after listing reminders to check one off at the user's request.",
    io: {
      input: {
        type: "object",
        properties: { id: { type: "string", description: "The reminder id (from reminders.list)." } },
        required: ["id"],
      },
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          completed: { type: "boolean" },
        },
        required: ["id", "completed"],
      },
    },
    grants: ["write"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_SKILL_ID, label: "How to use Apple Reminders" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: "reminders.complete" } },
  };
}

/** The how-to-use SKILL (read-as-context). Names the write-grant caveat + examples. */
function howToUseSkill(): CapabilityEntry {
  return {
    id: HOW_TO_USE_SKILL_ID,
    source: APPLE_REMINDERS_SOURCE_ID,
    kind: "skill",
    label: "How to use Apple Reminders",
    describe:
      "Usage guidance for the Apple Reminders capabilities: when to read vs. write, the WRITE-grant " +
      "caveat for create/complete (they mutate the user's Reminders), and worked examples.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToUseSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The Apple Reminders entry set: two reads, the WRITE create, the write complete, and
 * the how-to-use skill. Honest, self-describing, with the write capabilities clearly
 * declaring `grants:["write"]`.
 */
export function appleRemindersEntries(): CapabilityEntry[] {
  return [
    listsList(),
    remindersList(),
    remindersCreate(),
    remindersComplete(),
    howToUseSkill(),
  ];
}
