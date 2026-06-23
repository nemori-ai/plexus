/**
 * m4-demo — shared result shapes + tiny helpers (logger, temp home, free port).
 * Kept dependency-light so both the headline loop and the unified runner reuse them.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

export function check(ok: boolean, label: string, detail?: string): CheckResult {
  return { ok, label, ...(detail ? { detail } : {}) };
}

export interface Logger {
  line(s?: string): void;
  step(tag: string, s: string): void;
  pass(s: string): void;
  fail(s: string): void;
}

export function consoleLogger(): Logger {
  return {
    line: (s = "") => console.log(s),
    step: (tag, s) => console.log(`\n── ${tag} ${s} ${"─".repeat(Math.max(2, 56 - s.length))}`),
    pass: (s) => console.log(`   ✓ ${s}`),
    fail: (s) => console.log(`   ✗ ${s}`),
  };
}

export function silentLogger(): Logger {
  return { line() {}, step() {}, pass() {}, fail() {} };
}

export interface TempHome {
  sandbox: string;
  plexusHome: string;
}

/** Make an isolated temp PLEXUS_HOME (never touch the real ~/.plexus). */
export function mkTempHome(prefix: string): TempHome {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  const plexusHome = join(sandbox, "plexus-home");
  mkdirSync(plexusHome, { recursive: true });
  return { sandbox, plexusHome };
}

export function cleanupHome(home: TempHome): void {
  try {
    rmSync(home.sandbox, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Find a free TCP port by briefly binding `:0`, then releasing it. */
export async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (!port) throw new Error("could not pick a free loopback port");
  return port;
}
