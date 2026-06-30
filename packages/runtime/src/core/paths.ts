/**
 * Local-first state layout (§5, ADR-009). ALL gateway state lives under
 * `~/.plexus/` — grant store, audit JSONL, token-revocation set, per-install
 * signing secret, connection-key. No pointer files in user cwds.
 *
 * This module centralizes the directory layout + small best-effort, atomic
 * read/write helpers the auth/audit/grant subsystems share. A `PLEXUS_HOME` env
 * override exists ONLY so tests can sandbox state into a scratch dir (the default
 * is the real `~/.plexus`).
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";

/** Root of all gateway state. Override with `PLEXUS_HOME` (tests sandbox here). */
export function plexusHome(): string {
  return process.env.PLEXUS_HOME ?? join(homedir(), ".plexus");
}

/** Ensure a directory exists (best-effort; recursive). Returns the path. */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Resolve a path under the plexus home, ensuring the home dir exists. */
export function homePath(...segments: string[]): string {
  ensureDir(plexusHome());
  return join(plexusHome(), ...segments);
}

/** Best-effort read of a UTF-8 file; undefined if absent/unreadable. */
export function readFileBestEffort(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Atomic write: write to a temp sibling then rename over the target. Best-effort —
 * a write failure (e.g. read-only FS) is swallowed by callers that persist for
 * durability but keep authoritative state in memory.
 *
 * `mode` (when given) writes the temp file with those perms AND best-effort
 * re-chmods the target after rename — for credential material (connection-key,
 * signing secret) that must land owner-only (`0o600`) regardless of umask.
 */
export function atomicWrite(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, data, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  renameSync(tmp, path);
  if (mode !== undefined) {
    try {
      chmodSync(path, mode);
    } catch {
      /* best-effort tighten (e.g. umask-relaxed create) */
    }
  }
}

/**
 * DURABLE atomic write: write to a temp sibling, `fsync` its contents to stable
 * storage, rename over the target, then `fsync` the parent directory so the rename
 * itself is durable. Unlike `atomicWrite` this DOES NOT swallow failures — it THROWS
 * on any write/sync error, so a caller that needs a write to be observably persisted
 * (e.g. consuming a one-time token — mesh L1) can surface a lost write as a failure
 * rather than reporting a phantom success that a later crash would silently undo.
 */
export function atomicWriteFsync(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w", mode ?? 0o666);
  try {
    writeFileSync(fd, data, "utf8");
    // Flush the file's bytes to the device before we expose them under the real name.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (mode !== undefined) {
    try {
      chmodSync(path, mode);
    } catch {
      /* best-effort tighten (e.g. umask-relaxed create) */
    }
  }
  // Make the directory entry (the rename) durable too — best-effort, since some
  // platforms/filesystems disallow opening a directory for fsync.
  try {
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* best-effort dir sync — the file fsync above is the load-bearing durability */
  }
}

/** Append a line to a file (creates it if absent). */
export function appendLine(path: string, line: string): void {
  // Node's appendFile via writeFileSync flag — small, single-writer process.
  writeFileSync(path, line.endsWith("\n") ? line : `${line}\n`, { flag: "a" });
}
