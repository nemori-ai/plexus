/**
 * sysinfo self-describe ENTRIES (first-party source).
 *
 * The `sysinfo` source exposes a Linux/Unix host's SYSTEM-RESOURCE + SYSLOG surface as a
 * READ-ONLY API — the "scan the server status + read its security/access log" half of the
 * mesh flagship flow (a Linux child advertises this; a cloud agent reads it, hands it to
 * Codex for analysis, writes the conclusion to Obsidian).
 *
 *   - `sysinfo.processes.list`  — top-N running processes (pid, user, %cpu, %mem, command).
 *   - `sysinfo.resources.read`  — cpu load (loadavg) + memory + per-filesystem disk usage.
 *   - `sysinfo.log.read`        — the TAIL of a system/security/access log file, PATH-JAILED
 *                                  to an allowlisted log root + tail-bounded.
 *
 * ALL THREE are `grants:["read"]` (auto-grant, read-only by construction — there is no
 * write/exec path anywhere in this source). All capability entries are `transport:"ipc"`
 * (in-process / local bridge) and carry an `extras.route.op` the bridge intercepts to drive
 * the injected SysinfoProvider directly (mirroring the workspace / things in-process-handler
 * pattern — the bridge runs gateway-owned local code and only normalizes + audits; the ipc
 * wire is never reached). A `sysinfo.how-to-use` SKILL ships the usage guide.
 *
 * The id-derivation rule holds: `sysinfo.<verb>` — the source is recoverable from the id,
 * and ids are unique.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapabilityEntry } from "@plexus/protocol";

/** Stable source id for the sysinfo first-party adapter. */
export const SYSINFO_SOURCE_ID = "sysinfo" as const;

/** Capability + skill ids (id-derivation: sysinfo.<verb>). */
export const SYSINFO_PROCESSES_LIST_ID = "sysinfo.processes.list" as const;
export const SYSINFO_RESOURCES_READ_ID = "sysinfo.resources.read" as const;
export const SYSINFO_LOG_READ_ID = "sysinfo.log.read" as const;
export const SYSINFO_HOW_TO_USE_ID = "sysinfo.how-to-use" as const;

/** The handler op names the bridge intercepts (carried on extras.route.op). */
export const OP_PROCESSES_LIST = "sysinfo.processes.list" as const;
export const OP_RESOURCES_READ = "sysinfo.resources.read" as const;
export const OP_LOG_READ = "sysinfo.log.read" as const;

const VERSION = "0.1.0";

/** Load the bundled how-to-use skill body from disk (alongside this file). */
function loadHowToSkill(): string {
  try {
    const here = fileURLToPath(new URL("./skills/how-to-use-sysinfo.md", import.meta.url));
    return readFileSync(here, "utf-8");
  } catch {
    return (
      "# How to use sysinfo\n" +
      "Read this host's system status: `sysinfo.processes.list` ({ top? }) for the busiest " +
      "processes, `sysinfo.resources.read` ({}) for cpu/memory/disk, and `sysinfo.log.read` " +
      "({ file, lines? }) for the tail of a system/security/access log. `file` is relative to " +
      "the allowlisted log root and rejected if it escapes (`..`, absolute, or symlink-out). " +
      "All three are READ-ONLY."
    );
  }
}

/** PROCESSES.LIST: top-N running processes by cpu. */
function processesList(): CapabilityEntry {
  return {
    id: SYSINFO_PROCESSES_LIST_ID,
    source: SYSINFO_SOURCE_ID,
    kind: "capability",
    label: "List running processes",
    describe:
      "List the running processes on this host, sorted by CPU usage (busiest first). READ-ONLY " +
      "— it shells out to `ps` (portable across Linux + macOS) and returns structured rows of " +
      "{ pid, user, cpu, mem, command } where `cpu`/`mem` are percentages. Pass `{ top }` to cap " +
      "how many rows you get back (default 50, hard-capped at 200) — ask for a small `top` when " +
      "you just want the heavy hitters. Use this to see what is consuming CPU/memory on a server " +
      "before you diagnose load, a runaway process, or a suspicious binary. It cannot start, " +
      "stop, or signal any process.",
    io: {
      input: {
        type: "object",
        properties: {
          top: {
            type: "number",
            description:
              "How many processes to return (busiest-by-cpu first). Default 50; values are " +
              "clamped to 1..200.",
          },
        },
      },
      output: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of rows returned." },
          total: { type: "number", description: "Total processes seen before the top-N cut." },
          processes: {
            type: "array",
            description:
              "Rows: { pid: number, user: string, cpu: number (%CPU), mem: number (%MEM), " +
              "command: string }, sorted by cpu descending.",
          },
        },
        required: ["count", "processes"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: SYSINFO_HOW_TO_USE_ID, label: "How to use sysinfo" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_PROCESSES_LIST } },
  };
}

/** RESOURCES.READ: cpu load + memory + disk snapshot. */
function resourcesRead(): CapabilityEntry {
  return {
    id: SYSINFO_RESOURCES_READ_ID,
    source: SYSINFO_SOURCE_ID,
    kind: "capability",
    label: "Read system resources",
    describe:
      "Read a point-in-time snapshot of this host's resource pressure: CPU load average " +
      "(1/5/15-minute, plus the cpu-core count so you can judge load-per-core), memory " +
      "(total/used/free bytes), and per-filesystem disk usage (from `df`). READ-ONLY and takes " +
      "no arguments — call it with `{}`. Returns structured JSON. Use this first when asked 'how " +
      "is the server doing' or to check whether a box is CPU-bound, out of RAM, or out of disk " +
      "before drilling into processes or logs.",
    io: {
      input: { type: "object", properties: {} },
      output: {
        type: "object",
        properties: {
          platform: { type: "string", description: "OS platform (e.g. 'linux', 'darwin')." },
          uptimeSeconds: { type: "number" },
          cpu: {
            type: "object",
            description:
              "{ cores: number, loadavg: [1m, 5m, 15m], loadPerCore: number } — loadavg is the " +
              "OS run-queue load; loadPerCore = load1 / cores.",
          },
          memory: {
            type: "object",
            description: "{ totalBytes, usedBytes, freeBytes, usedPct } — physical memory.",
          },
          disks: {
            type: "array",
            description:
              "Per-filesystem: { filesystem, mount, totalBytes, usedBytes, availableBytes, " +
              "usedPct }. Empty if `df` is unavailable.",
          },
        },
        required: ["cpu", "memory", "disks"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: SYSINFO_HOW_TO_USE_ID, label: "How to use sysinfo" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_RESOURCES_READ } },
  };
}

/** LOG.READ: the tail of a system/security/access log, path-jailed + tail-bounded. */
function logRead(): CapabilityEntry {
  return {
    id: SYSINFO_LOG_READ_ID,
    source: SYSINFO_SOURCE_ID,
    kind: "capability",
    label: "Read a system log tail",
    describe:
      "Read the TAIL (last N lines) of a system / security / access log file on this host — e.g. " +
      "an auth log, an sshd/access log, a web-server access log. READ-ONLY, tail-bounded, and " +
      "STRICTLY PATH-JAILED: `file` is resolved UNDER an allowlisted log root (configured via " +
      "`PLEXUS_SYSINFO_LOG_DIR`, default `/var/log`) and REJECTED if it escapes the root (`..` " +
      "traversal, an absolute path, or a symlink whose target lands outside the root). You can " +
      "NEVER read an arbitrary file this way. Pass `{ file }` relative to the log root (e.g. " +
      "'auth.log' or 'nginx/access.log') and optionally `{ lines }` (default 200, hard-capped at " +
      "2000). Use this to inspect access/auth activity — failed logins, source IPs, request " +
      "patterns — when analyzing a server's security posture.",
    io: {
      input: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description:
              "Log file to read, RELATIVE to the allowlisted log root, e.g. 'auth.log' or " +
              "'nginx/access.log'. Absolute paths, `..`, and symlink escapes are rejected.",
          },
          lines: {
            type: "number",
            description: "How many trailing lines to return. Default 200; clamped to 1..2000.",
          },
        },
        required: ["file"],
      },
      output: {
        type: "object",
        properties: {
          file: { type: "string", description: "The log root-relative path that was read." },
          lines: { type: "number", description: "Number of lines returned." },
          truncated: {
            type: "boolean",
            description: "True if the file had more lines than were returned (older lines omitted).",
          },
          content: { type: "string", description: "The trailing lines, newline-joined." },
        },
        required: ["file", "lines", "content"],
      },
    },
    grants: ["read"],
    transport: "ipc",
    skills: [{ id: SYSINFO_HOW_TO_USE_ID, label: "How to use sysinfo" }],
    version: VERSION,
    extras: { firstParty: true, route: { op: OP_LOG_READ } },
  };
}

/** The how-to-use SKILL (read-as-context usage knowledge). */
function howToUseSkill(): CapabilityEntry {
  return {
    id: SYSINFO_HOW_TO_USE_ID,
    source: SYSINFO_SOURCE_ID,
    kind: "skill",
    label: "How to use sysinfo",
    describe:
      "Usage guidance for the sysinfo capabilities: list busy processes (read), read a cpu/mem/" +
      "disk snapshot (read), and read the tail of a system/security/access log (read — path-" +
      "jailed to an allowlisted log root, tail-bounded). All read-only. Read-as-context; not " +
      "invoked over a wire.",
    grants: [],
    transport: "skill",
    body: { format: "markdown", markdown: loadHowToSkill() },
    version: VERSION,
    extras: { firstParty: true },
  };
}

/**
 * The sysinfo entry set: three READ capabilities (processes / resources / log) + the
 * how-to-use skill. UNGATED — availability (are `ps`/`df` present? does the log root
 * exist?) is reported via HEALTH, not by hiding entries.
 */
export function sysinfoEntries(): CapabilityEntry[] {
  return [processesList(), resourcesRead(), logRead(), howToUseSkill()];
}
