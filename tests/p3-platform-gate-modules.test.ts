/**
 * P3-1 — Platform-gate MODULES (a Linux gateway exposes only portable sources).
 *
 * A Linux gateway has no backing for the macOS-native sources (Apple Calendar /
 * Reminders / Things via osascript-JXA) nor for the exec sources whose confinement
 * is `sandbox-exec` (codex / claudecode — no Linux primitive yet). Those modules must
 * therefore be GATED OUT of the ACTIVE registry on Linux so `scan()` never advertises
 * dead capabilities — while their ids stay RESERVED cross-platform (anti-squat: a
 * Linux extension must not be able to register `apple-calendar`).
 *
 * This drives the registry-build filter deterministically by injecting a FAKE
 * `PlatformServices{ platform: 'linux' }` (the Linux code paths can never EXECUTE on
 * this macOS dev box — mirrors `xplat-platform-seam.test.ts`). No real subprocess, no
 * real disk, no `process.platform` dependence.
 */

import { describe, it, expect } from "bun:test";
import type { PlatformServices } from "@plexus/protocol";

import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { RESERVED_SOURCE_IDS } from "@plexus/runtime/core/capability-registry.ts";

// The full first-party id roster + the two portable (Linux-active) ids.
const ALL_FIRST_PARTY = [
  "apple-calendar",
  "apple-reminders",
  "apple-notes",
  "things",
  "workspace",
  "claudecode",
  "codex",
  "sysinfo",
  "shortcuts",
  "browser",
] as const;
const LINUX_PORTABLE = ["workspace", "sysinfo"] as const;
const GATED_ON_LINUX = ["apple-calendar", "apple-reminders", "apple-notes", "things", "claudecode", "codex", "shortcuts", "browser"] as const;

/** A fake PlatformServices pinned to the given OS — no real OS access (none used here). */
function fakePlatform(platform: PlatformServices["platform"]): PlatformServices {
  return {
    platform,
    async resolveBinary() {
      return undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("not used in registry-build test");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

describe("P3-1 platform-gate MODULES — Linux active registry", () => {
  it("ACTIVE first-party modules on linux are exactly {workspace, sysinfo}", () => {
    const reg = createSourceRegistry(fakePlatform("linux"));
    const active = new Set(reg.all().map((m) => m.id));
    expect([...active].sort()).toEqual([...LINUX_PORTABLE].sort());
  });

  it("Apple + exec sources are NOT scanned/advertised (not in the active set) on linux", () => {
    const reg = createSourceRegistry(fakePlatform("linux"));
    for (const id of GATED_ON_LINUX) {
      expect(reg.get(id)).toBeUndefined();
    }
  });

  it("gated ids stay RESERVED cross-platform (anti-squat — no Linux extension may register them)", () => {
    // Reservation is static + platform-independent: keyed on the FULL MODULES set.
    for (const id of ALL_FIRST_PARTY) {
      expect(RESERVED_SOURCE_IDS.has(id)).toBe(true);
    }
    // Specifically the ids GATED OUT of the linux active set are still reserved.
    for (const id of GATED_ON_LINUX) {
      expect(RESERVED_SOURCE_IDS.has(id)).toBe(true);
    }
  });
});

describe("P3-1 platform-gate MODULES — darwin parity (unchanged)", () => {
  it("ACTIVE registry on darwin keeps ALL first-party sources", () => {
    const reg = createSourceRegistry(fakePlatform("darwin"));
    const active = new Set(reg.all().map((m) => m.id));
    for (const id of ALL_FIRST_PARTY) {
      expect(active.has(id)).toBe(true);
    }
    expect(active.size).toBe(ALL_FIRST_PARTY.length);
  });

  it("each gated-on-linux source IS resolvable on darwin", () => {
    const reg = createSourceRegistry(fakePlatform("darwin"));
    for (const id of GATED_ON_LINUX) {
      expect(reg.get(id)).toBeDefined();
    }
  });
});
