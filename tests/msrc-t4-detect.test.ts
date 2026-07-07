/**
 * msrc Task 4 — SCAN / DETECT framework + the Obsidian detector.
 *
 * Asserts the framework's HARD invariants (DESIGN §5):
 *   1. The Obsidian detector returns a `DetectedSource` when a (mock) loopback
 *      Obsidian Local REST endpoint is reachable, and NONE when not reachable.
 *   2. `detect()` is ADVISORY-ONLY — it NEVER adds, persists, registers, or touches a
 *      secret (sources.json + the live registry are byte-for-byte unchanged after a
 *      detect, even when a candidate is found).
 *   3. The Obsidian detector preserves loopback enforcement (it only sees the address
 *      `locateLocalService` returns) and flags `needsSecret` by NAME (no value).
 *
 * Uses a throwaway PLEXUS_HOME + a MOCK reachable endpoint (no real Obsidian / no real
 * network). Loopback enforcement lives in the real `locateLocalService`; here we mock
 * the platform seam so the test is hermetic.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  PlatformServices,
  LocalServiceHint,
  LocalServiceLocation,
} from "@plexus/protocol";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { createGrantStore } from "@plexus/runtime/core/grants.ts";
import { createManagedSources } from "@plexus/runtime/sources/config/manage.ts";
import {
  readSourcesConfig,
  writeSourcesConfig,
  sourcesConfigPath,
} from "@plexus/runtime/sources/config/store.ts";
import {
  detectSources,
  obsidianRestDetector,
  collectDetectors,
  detectConfigView,
  DETECTORS,
  OBSIDIAN_REST_SOURCE_ID,
  OBSIDIAN_REST_SECRET_NAME,
} from "@plexus/runtime/sources/config/detect.ts";
import type { ConfiguredSource } from "@plexus/runtime/sources/config/types.ts";
import { VAULT_READ_ID, OBSIDIAN_SOURCE_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import { REST_VAULT_WRITE_ID } from "@plexus/runtime/sources/obsidian/open-vault-rest.ts";

const homes: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-msrc-t4-"));
  homes.push(dir);
  process.env.PLEXUS_HOME = dir;
  return dir;
}

/**
 * A MOCK PlatformServices whose `locateLocalService` returns a reachable loopback
 * Obsidian endpoint when `reachable` is true, else undefined. Every other method is a
 * no-op stub (the detectors only use `locateLocalService`). This stands in for the
 * real `darwin.ts` probe so the test never opens a socket / requires real Obsidian.
 */
function mockPlatform(opts: {
  reachable: boolean;
  address?: string;
  secretRef?: string;
}): PlatformServices {
  return {
    platform: "darwin",
    async resolveBinary() {
      return undefined;
    },
    async getEnrichedPath() {
      return "";
    },
    async locateLocalService(hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
      if (hint.app !== "obsidian" || !opts.reachable) return undefined;
      return {
        kind: "http",
        // Loopback-only — mirrors what the real probe returns (127.0.0.1).
        address: opts.address ?? "https://127.0.0.1:27124",
        ...(opts.secretRef ? { secretRef: opts.secretRef } : {}),
      };
    },
    spawnProcess() {
      throw new Error("not used in detect tests");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function freshDeps(platform: PlatformServices) {
  const sources = createSourceRegistry(getPlatformServices());
  const capabilities = createCapabilityRegistry(sources);
  const grants = createGrantStore();
  return { capabilities, grants, platform };
}

function fsSource(vaultPath: string): ConfiguredSource {
  return {
    id: OBSIDIAN_SOURCE_ID,
    kind: "obsidian-fs",
    label: "Obsidian vault (test)",
    enabled: true,
    transport: "ipc",
    route: { vaultPath },
  };
}

beforeEach(() => {
  freshHome();
});

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of homes.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("msrc-t4: Obsidian-REST detector — reachability only", () => {
  it("returns a DetectedSource when the loopback endpoint is reachable", async () => {
    const platform = mockPlatform({ reachable: true });
    const found = await obsidianRestDetector.detect(platform, detectConfigView([]));

    expect(found).toHaveLength(1);
    const d = found[0]!;
    expect(d.kind).toBe("obsidian-rest");
    expect(d.reachable).toBe(true);
    expect(d.suggested.id).toBe(OBSIDIAN_REST_SOURCE_ID);
    expect(d.suggested.transport).toBe("local-rest");
    expect(d.suggested.route?.baseUrl).toBe("https://127.0.0.1:27124");
    // Address is loopback (the detector only forwards what locateLocalService returns).
    expect(d.suggested.route?.baseUrl).toContain("127.0.0.1");
    // Needs a secret — by NAME only, never a value.
    expect(d.needsSecret?.name).toBe(OBSIDIAN_REST_SECRET_NAME);
    expect(d.suggested.secretRef).toBe(OBSIDIAN_REST_SECRET_NAME);
    expect(JSON.stringify(d)).not.toContain("Bearer");
    // Not yet configured.
    expect(d.alreadyConfigured).toBe(false);
  });

  it("returns NONE when the endpoint is not reachable", async () => {
    const platform = mockPlatform({ reachable: false });
    const found = await obsidianRestDetector.detect(platform, detectConfigView([]));
    expect(found).toEqual([]);
  });

  it("honors the secretRef the platform reports and flags alreadyConfigured", async () => {
    const platform = mockPlatform({ reachable: true, secretRef: "obsidian-rest-api-key" });
    const already = detectConfigView([
      { id: OBSIDIAN_REST_SOURCE_ID, kind: "obsidian-rest", label: "x", enabled: true, transport: "local-rest" },
    ]);
    const found = await obsidianRestDetector.detect(platform, already);
    expect(found[0]?.needsSecret?.name).toBe("obsidian-rest-api-key");
    expect(found[0]?.alreadyConfigured).toBe(true);
  });
});

describe("msrc-t4: detect() is ADVISORY-ONLY — never adds/persists/registers", () => {
  it("a reachable candidate does NOT mutate sources.json or the live registry", async () => {
    const platform = mockPlatform({ reachable: true });
    const { capabilities, grants } = freshDeps(platform);
    const managed = createManagedSources({ capabilities, grants, platform });

    // Pre-state: no sources.json file, nothing registered.
    expect(existsSync(sourcesConfigPath())).toBe(false);
    expect(capabilities.get(VAULT_READ_ID)).toBeUndefined();
    const revBefore = capabilities.revision();

    const detected = await managed.detect();
    // It FOUND a candidate (proves the path is live, not a stub).
    expect(detected.some((d) => d.kind === "obsidian-rest")).toBe(true);

    // POST-state: nothing was added, persisted, or registered.
    expect(managed.list()).toHaveLength(0);
    expect(existsSync(sourcesConfigPath())).toBe(false); // no file written by detect
    expect(capabilities.revision()).toBe(revBefore); // no register ⇒ no revision bump
    expect(capabilities.get(REST_VAULT_WRITE_ID)).toBeUndefined();
  });

  it("detect() does not disturb an EXISTING sources.json (byte-for-byte unchanged)", async () => {
    const platform = mockPlatform({ reachable: true });
    // Seed an existing, unrelated configured source on disk.
    writeSourcesConfig({ version: 1, sources: [fsSource("/tmp/x")] });
    const before = readSourcesConfig();

    const { capabilities, grants } = freshDeps(platform);
    const managed = createManagedSources({ capabilities, grants, platform });

    await managed.detect();

    const after = readSourcesConfig();
    expect(after).toEqual(before); // detect persisted nothing
    // The reachable obsidian-rest candidate was NOT registered as a capability.
    expect(capabilities.get(REST_VAULT_WRITE_ID)).toBeUndefined();
  });

  it("returns [] when no platform dep is wired (no probe path)", async () => {
    const sources = createSourceRegistry(getPlatformServices());
    const capabilities = createCapabilityRegistry(sources);
    const managed = createManagedSources({ capabilities });
    expect(await managed.detect()).toEqual([]);
  });
});

describe("msrc-t4: detector registry is auto-collected from SOURCE_KINDS", () => {
  it("includes the obsidian-rest detector (wired via kinds.ts)", () => {
    const kinds = collectDetectors().map((d) => d.kind);
    expect(kinds).toContain("obsidian-rest");
    // The public DETECTORS registry exposes the same (lazy) set.
    expect([...DETECTORS].map((d) => d.kind)).toContain("obsidian-rest");
  });

  it("a failing detector never aborts the scan (best-effort isolation)", async () => {
    const platform = mockPlatform({ reachable: true });
    const boom = {
      kind: "boom",
      async detect() {
        throw new Error("detector blew up");
      },
    };
    const out = await detectSources(platform, [], [boom, obsidianRestDetector]);
    // The good detector still contributed despite the throwing one.
    expect(out.some((d) => d.kind === "obsidian-rest")).toBe(true);
  });
});
