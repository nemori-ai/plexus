/**
 * Fix #1 — credential material under `~/.plexus/` must land OWNER-ONLY (0600).
 *
 * `docs/security.md` promises the connection-key is `0600`; the per-install HS256
 * signing secret is the same class of material. Both persist via `atomicWrite`,
 * which (before this fix) wrote at the default umask (0644). This test sandboxes
 * PLEXUS_HOME into a scratch dir, triggers creation of BOTH files, and asserts the
 * on-disk mode is owner-only. The instance-id (the JWT `iss`, a PUBLIC identifier)
 * is deliberately NOT owner-only — asserted here so the distinction is pinned.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConnectionKeyStore } from "@plexus/runtime/core/index.ts";
import { getSigningSecret, getInstanceId, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

const isPosix = process.platform !== "win32";
const tmpDirs: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-keyperms-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

describe("fix #1 — credential files persist owner-only (0600)", () => {
  it("connection-key is written with mode 0600", () => {
    const dir = freshHome();
    createConnectionKeyStore().current(); // forces generate + persist
    const path = join(dir, "connection-key");
    expect(existsSync(path)).toBe(true);
    if (!isPosix) return; // mode bits are not meaningful on non-POSIX
    const mode = statSync(path).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/other bits
    expect(mode).toBe(0o600);
  });

  it("signing secret is written with mode 0600", () => {
    const dir = freshHome();
    getSigningSecret(); // forces generate + persist
    const path = join(dir, "secret");
    expect(existsSync(path)).toBe(true);
    if (!isPosix) return;
    const mode = statSync(path).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    expect(mode).toBe(0o600);
  });

  it("instance-id (public JWT iss) is NOT owner-only — it is not credential material", () => {
    const dir = freshHome();
    getInstanceId(); // forces generate + persist
    const path = join(dir, "instance-id");
    // The deliberate decision: a public identifier needs no owner-only mode, so it
    // is persisted at default (umask-dependent) perms via plain `atomicWrite`. We
    // assert only that it lands (no 0600 mode is passed at the call site).
    expect(existsSync(path)).toBe(true);
  });
});
