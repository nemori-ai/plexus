/**
 * ============================================================================
 * Runtime port-file + machine-readable ready line (REDESIGN-ARCHITECTURE §3.3)
 * ============================================================================
 *
 * When the runtime is started by a supervisor (the Electron-main process, a
 * systemd unit, or `plexus serve` by hand), the supervisor must learn the
 * ACTUAL bound port — especially when the default 7077 is taken and an ephemeral
 * port is used. Two cooperating mechanisms (§3.3 "parse-then-confirm"):
 *
 *   1. A machine-readable READY LINE on stdout the supervisor can parse:
 *        PLEXUS_READY {"port":54321,"pid":1234,"lraVersion":"1.0"}
 *
 *   2. A `~/.plexus/runtime.json` PORT FILE so the CLI/agents can discover a
 *      non-default port without env vars:  {"port":N,"pid":N,"lraVersion":"1.0"}
 *
 * This module owns both, plus the LRA version constant. It is intentionally tiny
 * and side-effect-light so the listen path stays obvious.
 */

import { existsSync, rmSync } from "node:fs";
import { homePath } from "../core/paths.ts";
import { atomicWrite } from "../core/paths.ts";

/**
 * Local Runtime API version (REDESIGN-ARCHITECTURE §2.4) — independent of the
 * agent protocol version (`PLEXUS_PROTOCOL_VERSION`). Carried in the ready line +
 * port file so a supervisor/client can negotiate. Additive within a major.
 */
export const LRA_VERSION = "1.0" as const;

/** The machine-readable stdout sentinel a supervisor greps for. */
export const READY_LINE_PREFIX = "PLEXUS_READY" as const;

/** Name of the port file under `~/.plexus/`. */
export const RUNTIME_FILE = "runtime.json" as const;

/** The shape written to `~/.plexus/runtime.json` and embedded in the ready line. */
export interface RuntimeInfo {
  /** The actual bound loopback port. */
  readonly port: number;
  /** The runtime process pid (for supervision / orphan cleanup). */
  readonly pid: number;
  /** The Local Runtime API version this process speaks. */
  readonly lraVersion: string;
}

/** Absolute path to the runtime port file. */
export function runtimeFilePath(): string {
  return homePath(RUNTIME_FILE);
}

/**
 * Compose the machine-readable ready line, e.g.
 *   `PLEXUS_READY {"port":54321,"pid":1234,"lraVersion":"1.0"}`
 */
export function readyLine(info: RuntimeInfo): string {
  return `${READY_LINE_PREFIX} ${JSON.stringify(info)}`;
}

/**
 * Atomically write `~/.plexus/runtime.json`. Best-effort (a read-only FS must not
 * crash the runtime); authoritative truth is the live process + the ready line.
 */
export function writeRuntimeFile(info: RuntimeInfo): void {
  try {
    atomicWrite(runtimeFilePath(), JSON.stringify(info) + "\n");
  } catch {
    /* best-effort: durability only — the ready line still announced the port */
  }
}

/** Remove the port file on graceful shutdown (best-effort). */
export function clearRuntimeFile(): void {
  try {
    const p = runtimeFilePath();
    if (existsSync(p)) rmSync(p);
  } catch {
    /* best-effort */
  }
}
