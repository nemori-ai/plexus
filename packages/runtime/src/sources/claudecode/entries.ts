/**
 * Claude Code sandboxed-run self-describe ENTRIES (first-party source).
 *
 * The CONNECTOR is Claude Code, exposed as ONE sensitive capability:
 *   - `claudecode.run({ prompt })` — launch headless Claude Code CONFINED by macOS
 *     `sandbox-exec` to the authorized directory, do real work there, and return its
 *     output. `grants:["execute"]` ⇒ the gateway PENDS it for a human automatically
 *     (an `execute` on a first-party source is elevated → owner approval).
 *
 * The calling agent NEVER sees a shell or the launch command — only this capability.
 * CC reads/writes inside the jail; reads/writes outside FAIL at the kernel (AC5/AC6).
 *
 * Marked `transport:"ipc"` with an `extras.route.op` the bridge intercepts to drive
 * the injected `SandboxedClaudeLauncher` directly (the cc-master / things in-process-
 * handler pattern). A `claudecode.how-to-use` SKILL ships the usage guide.
 *
 * Id-derivation: `claudecode.<verb>` — the source is recoverable from the id.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id for the Claude Code sandboxed-run first-party adapter. */
export const CLAUDECODE_SOURCE_ID = "claudecode" as const;

/** Capability + skill ids. */
export const CLAUDECODE_RUN_ID = "claudecode.run" as const;
export const HOW_TO_USE_ID = "claudecode.how-to-use" as const;

/** The handler op the bridge intercepts (carried on extras.route.op). */
export const OP_RUN = "run" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadHowToSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-claudecode.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use claudecode.run\n" +
      "Call `claudecode.run({ prompt })` to have Claude Code do real coding work INSIDE the " +
      "authorized directory. It is sandboxed: CC cannot read or write outside that dir. " +
      "`run` is an `execute` capability, so it PENDS for the owner's approval — wait for it."
    );
  }
}

/** EXECUTE: launch headless Claude Code confined to the authorized dir. */
function runEntry(): CapabilityEntry {
  return {
    id: CLAUDECODE_RUN_ID,
    source: CLAUDECODE_SOURCE_ID,
    kind: "capability",
    label: "Run Claude Code (sandboxed)",
    describe:
      "Launch headless Claude Code to do REAL coding work — read files, write code, run a " +
      "multi-step task — CONFINED by the macOS sandbox to ONE authorized directory. CC cannot " +
      "read or write anything outside that directory (kernel-enforced). You never get a shell or " +
      "the raw launch command; you only pass a `{ prompt }` describing the task. This is a " +
      "SENSITIVE execute capability: it PENDS for the owner's approval before it runs — issue the " +
      "call and WAIT. Use it to scaffold/build/modify the project in the authorized dir; verify " +
      "the products (via the workspace read capability) between calls.",
    io: {
      input: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The task for Claude Code to perform inside the authorized directory, e.g. " +
              "'Build a single-page pomodoro web app from PRD.html in this folder.'",
          },
        },
        required: ["prompt"],
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "True iff CC ran (or would run) and exited 0." },
          launched: { type: "boolean", description: "True iff a real sandboxed spawn happened." },
          sandboxed: { type: "boolean", description: "Always true — the run is seatbelt-confined." },
          jail: { type: "string", description: "The authorized dir CC was confined to." },
          output: { type: "string", description: "CC's captured stdout." },
          confinement: {
            type: "object",
            description: "Audit metadata: { mechanism:'sandbox-exec', jail, homedir, ... }.",
          },
        },
        required: ["ok", "sandboxed", "jail"],
      },
    },
    grants: ["execute"],
    transport: "ipc",
    skills: [{ id: HOW_TO_USE_ID, label: "How to use claudecode.run" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_RUN } },
  };
}

/** The how-to-use SKILL (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: HOW_TO_USE_ID,
    source: CLAUDECODE_SOURCE_ID,
    kind: "skill",
    label: "How to use claudecode.run",
    describe:
      "Usage guidance for `claudecode.run`: it runs Claude Code sandboxed to the authorized dir " +
      "to do real coding work; it is an execute capability that PENDS for the owner, so wait for " +
      "approval; verify products between calls. Read-as-context; not invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The Claude Code sandboxed-run entry set: one EXECUTE capability + the how-to skill.
 * UNGATED — availability (whether `claude` + sandbox-exec are present) surfaces via
 * HEALTH, not by hiding the entry.
 */
export function claudecodeEntries(): CapabilityEntry[] {
  return [runEntry(), howToUseSkill()];
}
