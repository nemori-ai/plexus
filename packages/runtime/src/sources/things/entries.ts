/**
 * Things 3 self-describe ENTRIES (first-party source).
 *
 * Things 3 demonstrates a DIFFERENT surface class from the other first-party sources:
 *   - READ via the AppleScript dictionary (osascript) — `things.todos.list`,
 *     `things.projects.list`, both `grants:["read"]`.
 *   - WRITE via the Things URL-scheme (`things:///add?...`) — `things.todos.add`,
 *     `grants:["write"]`. A well-blast-radius "append a to-do" mechanism, NOT arbitrary
 *     mutation; the describe is honest about that.
 *
 * All capability entries are marked `transport:"ipc"` (in-process / local bridge) and
 * carry an `extras.route.op` the bridge intercepts to run the injected ThingsProvider
 * directly — mirroring the first-party member-handler pattern (the bridge runs gateway-
 * owned local code and only normalizes + audits the result; the ipc transport wire is
 * never reached). A `things.how-to-use` SKILL ships the read-as-context usage guide.
 *
 * The id-derivation rule holds: `things.<noun>.<verb>` — the source is recoverable
 * from the id, and ids are unique.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id for the Things 3 first-party adapter. */
export const THINGS_SOURCE_ID = "things" as const;

/** Capability + skill ids (id-derivation: things.<noun>.<verb>). */
export const TODOS_LIST_ID = "things.todos.list" as const;
export const PROJECTS_LIST_ID = "things.projects.list" as const;
export const TODOS_ADD_ID = "things.todos.add" as const;
export const HOW_TO_USE_ID = "things.how-to-use" as const;

/** The handler op names the bridge intercepts (carried on extras.route.op). */
export const OP_TODOS_LIST = "todos.list" as const;
export const OP_PROJECTS_LIST = "projects.list" as const;
export const OP_TODOS_ADD = "todos.add" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadHowToSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-things.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use Things 3\n" +
      "Read to-dos with `things.todos.list` (optionally `{ list }`); read projects with " +
      "`things.projects.list`. Append a to-do with `things.todos.add { title, notes?, when?, list? }` " +
      "(write, via the Things URL-scheme — it appends a new to-do)."
    );
  }
}

/** READ: list to-dos via AppleScript. */
function todosList(): CapabilityEntry {
  return {
    id: TODOS_LIST_ID,
    source: THINGS_SOURCE_ID,
    kind: "capability",
    label: "List Things to-dos",
    describe:
      "List the user's Things 3 to-dos (title, notes, status, list). Read via the Things " +
      "AppleScript dictionary (osascript) — READ-ONLY, never mutates. Use when you need the " +
      "user's tasks to answer, summarize, or decide what to add. Pass an optional `{ list }` to " +
      "confine to a named list/project.",
    io: {
      input: {
        type: "object",
        properties: {
          list: {
            type: "string",
            description: "Optional list/project name to confine the to-dos returned, e.g. 'Groceries'.",
          },
        },
      },
      output: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The to-dos: { id, title, notes, status, list? }.",
          },
        },
        required: ["todos"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_ID, label: "How to use Things 3" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_TODOS_LIST } },
  };
}

/** READ: list projects via AppleScript. */
function projectsList(): CapabilityEntry {
  return {
    id: PROJECTS_LIST_ID,
    source: THINGS_SOURCE_ID,
    kind: "capability",
    label: "List Things projects",
    describe:
      "List the user's Things 3 projects (title, area, status). Read via the Things AppleScript " +
      "dictionary (osascript) — READ-ONLY, never mutates. Use to understand the user's project " +
      "structure before adding or organizing to-dos.",
    io: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          projects: {
            type: "array",
            description: "The projects: { id, title, area?, status }.",
          },
        },
        required: ["projects"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_PROJECTS_LIST } },
  };
}

/** WRITE: append a to-do via the Things URL-scheme. */
function todosAdd(): CapabilityEntry {
  return {
    id: TODOS_ADD_ID,
    source: THINGS_SOURCE_ID,
    kind: "capability",
    label: "Add a Things to-do",
    describe:
      "Append a new to-do to Things 3 via the Things URL-scheme (`things:///add?title=...`). This " +
      "is a well-bounded WRITE — it ADDS a to-do, it does not edit or delete existing ones. Pass " +
      "`{ title, notes?, when?, list? }`: `when` is a Things schedule value (today | tomorrow | " +
      "evening | anytime | someday | a date); `list` targets a named list/project. Mutates the " +
      "user's task store ⇒ requires write.",
    io: {
      input: {
        type: "object",
        properties: {
          title: { type: "string", description: "The to-do title (required)." },
          notes: { type: "string", description: "Optional free-text notes for the to-do." },
          when: {
            type: "string",
            description: "Optional schedule: today | tomorrow | evening | anytime | someday | a date.",
          },
          list: { type: "string", description: "Optional target list/project name." },
        },
        required: ["title"],
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          url: { type: "string", description: "The things:///add URL that was opened." },
        },
        required: ["ok"],
      },
    },
    grants: ["write"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_ID, label: "How to use Things 3" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_TODOS_ADD } },
  };
}

/** The how-to-use SKILL (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: HOW_TO_USE_ID,
    source: THINGS_SOURCE_ID,
    kind: "skill",
    label: "How to use Things 3",
    describe:
      "Usage guidance for the Things 3 capabilities: read to-dos/projects via AppleScript, append a " +
      "to-do via the URL-scheme. Read-as-context; not invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The Things 3 entry set: two READ capabilities, one WRITE capability, and the
 * how-to-use skill. UNGATED — Things has no config toggle; availability is reported via
 * HEALTH (provider.available()), not by hiding entries.
 */
export function thingsEntries(): CapabilityEntry[] {
  return [todosList(), projectsList(), todosAdd(), howToUseSkill()];
}
