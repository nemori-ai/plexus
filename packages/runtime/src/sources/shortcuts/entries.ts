/**
 * Apple Shortcuts self-describe ENTRIES (first-party source).
 *
 * The CONNECTOR is Apple's Shortcuts app, reached through the macOS `shortcuts` CLI:
 *
 *   - `shortcuts.list` — enumerate the user's shortcuts (names + folder names).
 *     `grants:["read"]` — discovery only, never runs anything.
 *   - `shortcuts.run`  — run ONE named shortcut with optional text input. A shortcut
 *     is a USER-DEFINED AUTOMATION (it can send messages, move files, control apps —
 *     anything the owner built it to do), so this is `grants:["execute"]` ⇒ the
 *     gateway PENDS it for the owner, and the REAL execution is additionally
 *     owner-gated behind the record-mode default (claudecode/codex precedent).
 *
 * Both capability entries are `transport:"ipc"` with an `extras.route.op` the bridge
 * intercepts to drive the injected ShortcutsProvider directly (the in-process-handler
 * pattern). A `shortcuts.how-to-use` SKILL ships the usage guide.
 *
 * Id-derivation: `shortcuts.<verb>` — the source is recoverable from the id.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id for the Apple Shortcuts first-party adapter. */
export const SHORTCUTS_SOURCE_ID = "shortcuts" as const;

/** Capability + skill ids (id-derivation: shortcuts.<verb>). */
export const SHORTCUTS_LIST_ID = "shortcuts.list" as const;
export const SHORTCUTS_RUN_ID = "shortcuts.run" as const;
export const SHORTCUTS_HOW_TO_USE_ID = "shortcuts.how-to-use" as const;

/** The handler ops the bridge intercepts (carried on extras.route.op). */
export const OP_LIST = "list" as const;
export const OP_RUN = "run" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadHowToSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-shortcuts.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use Apple Shortcuts\n" +
      "Call `shortcuts.list` (read) to discover the owner's shortcut names, then " +
      "`shortcuts.run({ name, input? })` to run one. `run` EXECUTES a user-defined " +
      "automation, so it is an `execute` capability: it PENDS for the owner's approval, " +
      "and by default the gateway is in RECORD MODE — the call returns the exact command " +
      "that WOULD have run (recorded + audited, not executed) until the owner enables " +
      "real launch in the Plexus console. Issue the call and wait."
    );
  }
}

/** READ: list the user's shortcuts (names + folder names). */
function listEntry(): CapabilityEntry {
  return {
    id: SHORTCUTS_LIST_ID,
    source: SHORTCUTS_SOURCE_ID,
    kind: "capability",
    label: "List Apple Shortcuts",
    describe:
      "List the Apple Shortcuts on this Mac: every shortcut name the owner has, plus the " +
      "folder names their shortcuts are organized into (via the macOS `shortcuts` CLI). " +
      "READ-ONLY — it never runs, edits, or creates a shortcut. Use when you need to know " +
      "what automations the owner has, or to find the EXACT shortcut name to pass to " +
      "`shortcuts.run` (always list before you run — run takes the name verbatim).",
    io: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          shortcuts: {
            type: "array",
            description: "The owner's shortcuts.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "The shortcut's name (the handle `shortcuts.run` takes)." },
                folder: { type: "string", description: "The folder it lives in, when known." },
              },
              required: ["name"],
            },
          },
          folders: {
            type: "array",
            description: "The shortcut folder names (best-effort; may be empty).",
            items: { type: "string" },
          },
        },
        required: ["shortcuts"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: SHORTCUTS_HOW_TO_USE_ID, label: "How to use Apple Shortcuts" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_LIST } },
  };
}

/** EXECUTE: run one named shortcut (a user-defined automation) — owner-gated. */
function runEntry(): CapabilityEntry {
  return {
    id: SHORTCUTS_RUN_ID,
    source: SHORTCUTS_SOURCE_ID,
    kind: "capability",
    label: "Run an Apple Shortcut",
    describe:
      "Run ONE of the owner's Apple Shortcuts by name (optionally passing `input` text the " +
      "shortcut receives as its input) and return its captured output and exit code. This " +
      "EXECUTES a USER-DEFINED AUTOMATION — a shortcut can do anything the owner built it to " +
      "do (send messages, move files, control apps) — so it is a SENSITIVE execute capability " +
      "and it is OWNER-GATED twice: the call PENDS for the owner's approval, and real " +
      "execution only happens when the owner has enabled real launch for this source in the " +
      "Plexus console. Until then the gateway is in RECORD MODE: your call returns " +
      "`launched:false` plus the exact `shortcuts run` command that WOULD have run, recorded " +
      "and audited but not executed. Use when the user asks to trigger one of their Shortcuts " +
      "by name — call `shortcuts.list` first to get the exact name, then issue the call and " +
      "WAIT for approval.",
    io: {
      input: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The exact shortcut name to run (discover it via `shortcuts.list`).",
          },
          input: {
            type: "string",
            description: "Optional text input handed to the shortcut as its input.",
          },
          timeoutMs: {
            type: "number",
            description:
              "Hard timeout in milliseconds (default 60000, clamped to [1000, 600000]); the run is killed at the deadline.",
          },
        },
        required: ["name"],
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "True iff the shortcut ran (or would run) successfully." },
          launched: { type: "boolean", description: "True iff a real execution happened (false in record mode)." },
          output: { type: "string", description: "The shortcut's captured output, verbatim (empty in record mode)." },
          exitCode: { type: "number", description: "The CLI exit code (real runs)." },
          timedOut: { type: "boolean", description: "True iff the run was killed at the timeout." },
          reason: { type: "string", description: "Why the run did not execute or failed (record mode, timeout, error)." },
        },
        required: ["ok", "launched"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    skills: [{ id: SHORTCUTS_HOW_TO_USE_ID, label: "How to use Apple Shortcuts" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_RUN } },
  };
}

/** The how-to-use SKILL (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: SHORTCUTS_HOW_TO_USE_ID,
    source: SHORTCUTS_SOURCE_ID,
    kind: "skill",
    label: "How to use Apple Shortcuts",
    describe:
      "Usage guidance for the Apple Shortcuts source: list-then-run (`shortcuts.list` to " +
      "discover names, `shortcuts.run` to execute one); `run` is an execute capability that " +
      "PENDS for the owner and defaults to record mode (recorded, not executed) until the " +
      "owner enables real launch. Read-as-context; not invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The Apple Shortcuts entry set: one READ + one EXECUTE capability + the how-to
 * skill. UNGATED — availability (whether the `shortcuts` CLI is present) surfaces
 * via HEALTH, not by hiding entries.
 */
export function shortcutsEntries(): CapabilityEntry[] {
  return [listEntry(), runEntry(), howToUseSkill()];
}
