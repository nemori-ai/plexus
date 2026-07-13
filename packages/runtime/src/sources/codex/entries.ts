/**
 * Codex sandboxed-run self-describe ENTRIES (first-party source).
 *
 * The CONNECTOR is the local Codex CLI, exposed as ONE sensitive capability:
 *   - `codex.run({ prompt })` — launch headless `codex exec` sandboxed to the authorized
 *     directory, do real work there, and return its output. `grants:["execute"]` ⇒ the
 *     gateway PENDS it for a human automatically (an `execute` on a first-party source is
 *     elevated → owner approval).
 *
 * The calling agent NEVER sees a shell or the launch command — only this capability.
 * Codex does its work inside the authorized dir and cannot create or modify files outside it.
 *
 * Marked `transport:"ipc"` with an `extras.route.op` the bridge intercepts to drive
 * the injected `SandboxedCodexLauncher` directly (the same in-process-handler pattern
 * claudecode uses). A `codex.how-to-use` SKILL ships the usage guide.
 *
 * Id-derivation: `codex.<verb>` — the source is recoverable from the id.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id for the Codex sandboxed-run first-party adapter. */
export const CODEX_SOURCE_ID = "codex" as const;

/** Capability + skill ids. */
export const CODEX_RUN_ID = "codex.run" as const;
export const HOW_TO_USE_ID = "codex.how-to-use" as const;

/** The handler op the bridge intercepts (carried on extras.route.op). */
export const OP_RUN = "run" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadHowToSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-codex.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use codex.run\n" +
      "Call `codex.run({ prompt })` to have the Codex CLI do real coding work INSIDE the " +
      "authorized directory. It runs sandboxed to that directory: it does its work there and " +
      "cannot create or modify files outside it. " +
      "`run` is an `execute` capability: if your manifest entry carries `standing: true` the " +
      "owner pre-authorized it and calls run directly; otherwise each call PENDS for the " +
      "owner's approval — wait for it."
    );
  }
}

/** EXECUTE: launch headless Codex confined to the authorized dir. */
function runEntry(): CapabilityEntry {
  return {
    id: CODEX_RUN_ID,
    source: CODEX_SOURCE_ID,
    kind: "capability",
    label: "Run Codex",
    describe:
      "Run the Codex CLI (`codex exec`) HEADLESS to do REAL coding work — read files, write " +
      "code, run a multi-step task — sandboxed to ONE authorized directory: it does its work " +
      "there and cannot create or modify files outside it. You never get a shell or the raw " +
      "launch command; you only pass a `{ prompt }` (and an optional in-dir `cwd`) describing " +
      "the task. This is a SENSITIVE execute capability. If your manifest entry carries " +
      "`standing: true` the owner pre-authorized it for your connection and calls run WITHOUT " +
      "a per-call approval; otherwise each call PENDS for the owner's approval — issue the " +
      "call and WAIT. Use it to scaffold/build/modify the project " +
      "in the authorized dir; verify the products (via the workspace read capability) between " +
      "calls. If the local `codex` CLI is absent, the call reports `source_unavailable` instead " +
      "of failing the session.",
    io: {
      input: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The task for Codex to perform inside the authorized directory, e.g. " +
              "'Refactor the timer module in this folder and add unit tests.'",
          },
          cwd: {
            type: "string",
            description:
              "Optional sub-directory of the authorized dir to run in. Any path that escapes " +
              "the authorized dir is rejected before Codex is spawned.",
          },
        },
        required: ["prompt"],
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "True iff Codex ran (or would run) and exited 0." },
          launched: { type: "boolean", description: "True iff a real sandboxed spawn happened." },
          sandboxed: { type: "boolean", description: "Always true — the run is sandboxed to the authorized directory." },
          output: { type: "string", description: "Codex's captured stdout, verbatim." },
          exitCode: { type: "number", description: "Codex's exit code (real launches)." },
          // Confinement diagnostics (absolute jail path, sandbox argv, machine layout)
          // are the OWNER's information — audit record only, never on the wire.
        },
        required: ["ok", "sandboxed"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_ID, label: "How to use codex.run" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_RUN } },
  };
}

/** The how-to-use SKILL (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: HOW_TO_USE_ID,
    source: CODEX_SOURCE_ID,
    kind: "skill",
    label: "How to use codex.run",
    describe:
      "Usage guidance for `codex.run`: it runs the Codex CLI sandboxed to the authorized dir to " +
      "do real coding work; it is an execute capability that PENDS for the owner, so wait for " +
      "approval; verify products between calls. Read-as-context; not invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The Codex sandboxed-run entry set: one EXECUTE capability + the how-to skill.
 * UNGATED — availability (whether `codex` + sandbox-exec are present) surfaces via
 * HEALTH, not by hiding the entry.
 */
export function codexEntries(): CapabilityEntry[] {
  return [runEntry(), howToUseSkill()];
}
