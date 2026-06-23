/**
 * msrc Task 0 — Managed sources config layer + ManagedSources core (the seam).
 *
 * Asserts the deliverable contract's crux invariants (DESIGN §1/§3/§4):
 *   1. `sources.json` ROUND-TRIPS: write → read, atomic, secretRef NAME-only, NO
 *      secret value ever persisted.
 *   2. `add()` registers LIVE (the capability appears in the registry) AND persists.
 *   3. PERSIST-FAILURE ROLLS BACK the live register — no orphan capability.
 *   4. `disable` unregisters + persists enabled:false (config retained).
 *   5. BOOT-LOAD registers persisted ENABLED sources on a fresh boot; disabled are
 *      skipped (kept in the file).
 *
 * Uses a throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPlatformServices } from "../src/platform/index.ts";
import { createSourceRegistry } from "../src/core/registry.ts";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import { createGrantStore } from "../src/core/grants.ts";
import { createManagedSources } from "../src/sources/config/manage.ts";
import {
  readSourcesConfig,
  writeSourcesConfig,
  sourcesConfigPath,
  validateConfiguredSource,
} from "../src/sources/config/store.ts";
import type { ConfiguredSource } from "../src/sources/config/types.ts";
import { VAULT_READ_ID, OBSIDIAN_SOURCE_ID } from "../src/sources/obsidian/open-vault.ts";
import { REST_VAULT_WRITE_ID } from "../src/sources/obsidian/open-vault-rest.ts";

const homes: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-msrc-t0-"));
  homes.push(dir);
  process.env.PLEXUS_HOME = dir;
  return dir;
}

/** A fresh capability registry + grants over a real (empty MODULES) source registry. */
function freshDeps() {
  const platform = getPlatformServices();
  const sources = createSourceRegistry(platform);
  const capabilities = createCapabilityRegistry(sources);
  const grants = createGrantStore();
  return { capabilities, grants };
}

/** A read-only obsidian-fs source (in-process handler; no secret needed). */
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

/** A write-capable obsidian-rest source (secret by NAME only). */
function restSource(): ConfiguredSource {
  return {
    id: "obsidian-rest",
    kind: "obsidian-rest",
    label: "Obsidian REST (test)",
    enabled: true,
    transport: "local-rest",
    route: { baseUrl: "https://127.0.0.1:27124" },
    secretRef: "obsidian-local-rest-api-key",
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

describe("msrc-t0: sources.json round-trip + secretRef safety", () => {
  it("write → read round-trips and persists no secret value", () => {
    const cfg = restSource();
    writeSourcesConfig({ version: 1, sources: [cfg] });

    const back = readSourcesConfig();
    expect(back.version).toBe(1);
    expect(back.sources).toHaveLength(1);
    expect(back.sources[0]).toEqual(cfg);

    // secretRef is a NAME; no value field, and the raw file contains no key-looking value.
    expect(back.sources[0]?.secretRef).toBe("obsidian-local-rest-api-key");
    const raw = readFileSync(sourcesConfigPath(), "utf8");
    expect(raw).not.toContain("secretValue");
    expect(raw).not.toContain("Bearer");
  });

  it("rejects an unsafe secretRef (path traversal) on write and drops it on read", () => {
    const bad: ConfiguredSource = { ...restSource(), secretRef: "../../etc/passwd" };
    expect(validateConfiguredSource(bad).length).toBeGreaterThan(0);
    expect(() => writeSourcesConfig({ version: 1, sources: [bad] })).toThrow();

    // A hand-tampered file with an unsafe ref is dropped defensively on read.
    writeFileSync(
      sourcesConfigPath(),
      JSON.stringify({ version: 1, sources: [bad] }),
      "utf8",
    );
    expect(readSourcesConfig().sources).toHaveLength(0);
  });

  it("missing file ⇒ empty config (never throws)", () => {
    expect(readSourcesConfig()).toEqual({ version: 1, sources: [] });
  });
});

describe("msrc-t0: add() registers LIVE AND persists", () => {
  it("makes the capability discoverable in the registry and writes sources.json", async () => {
    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    const res = await managed.add(fsSource("/tmp/does-not-need-to-exist"));
    expect(res.ok).toBe(true);
    expect(res.registered).toContain(VAULT_READ_ID);

    // LIVE: the capability is in the registry.
    expect(capabilities.get(VAULT_READ_ID)).toBeDefined();

    // PERSISTED: sources.json holds the desired state.
    const back = readSourcesConfig();
    expect(back.sources.map((s) => s.id)).toContain(OBSIDIAN_SOURCE_ID);

    // In-memory list mirrors it.
    expect(managed.list().map((s) => s.id)).toContain(OBSIDIAN_SOURCE_ID);
  });

  it("an unknown kind is rejected with NO mutation (no register, no persist)", async () => {
    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    const res = await managed.add({
      id: "weird",
      kind: "not-a-real-kind",
      label: "x",
      enabled: true,
      transport: "ipc",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("unknown source kind");
    expect(managed.list()).toHaveLength(0);
    expect(readSourcesConfig().sources).toHaveLength(0);
  });
});

describe("msrc-t0: persist-failure ROLLS BACK the live register", () => {
  it("no orphan capability remains when sources.json cannot be written", async () => {
    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    // Force the atomic write to fail: make sources.json a DIRECTORY so the
    // temp-write + rename-over cannot replace it.
    mkdirSync(sourcesConfigPath(), { recursive: true });

    const res = await managed.add(fsSource("/tmp/x"));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("rolled back");

    // ROLLBACK: the live register was undone — NO orphan capability.
    expect(capabilities.get(VAULT_READ_ID)).toBeUndefined();
    // In-memory config was restored too.
    expect(managed.list()).toHaveLength(0);
  });
});

describe("msrc-t0: disable unregisters + persists enabled:false (config retained)", () => {
  it("removes the live capability but keeps the source in the file disabled", async () => {
    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    await managed.add(fsSource("/tmp/x"));
    expect(capabilities.get(VAULT_READ_ID)).toBeDefined();

    await managed.disable(OBSIDIAN_SOURCE_ID);

    // LIVE: gone.
    expect(capabilities.get(VAULT_READ_ID)).toBeUndefined();
    // PERSISTED: retained, enabled:false.
    const back = readSourcesConfig();
    const entry = back.sources.find((s) => s.id === OBSIDIAN_SOURCE_ID);
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
  });
});

describe("msrc-t0: boot-load registers persisted ENABLED sources, skips disabled", () => {
  it("a fresh boot re-registers an enabled persisted source", async () => {
    // Persist an enabled source directly (as a prior run would have).
    writeSourcesConfig({ version: 1, sources: [fsSource("/tmp/x")] });

    // Fresh boot: a brand-new registry + managed-sources instance.
    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    // Nothing live yet.
    expect(capabilities.get(VAULT_READ_ID)).toBeUndefined();

    const loaded = await managed.loadPersisted();
    expect(loaded).toContain(OBSIDIAN_SOURCE_ID);
    // LIVE after boot-load.
    expect(capabilities.get(VAULT_READ_ID)).toBeDefined();
  });

  it("a disabled persisted source is kept in the file but NOT registered at boot", async () => {
    writeSourcesConfig({
      version: 1,
      sources: [{ ...fsSource("/tmp/x"), enabled: false }],
    });

    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    const loaded = await managed.loadPersisted();
    expect(loaded).not.toContain(OBSIDIAN_SOURCE_ID);
    expect(capabilities.get(VAULT_READ_ID)).toBeUndefined();
    // Still in the file (desired state retained).
    expect(readSourcesConfig().sources.map((s) => s.id)).toContain(OBSIDIAN_SOURCE_ID);
  });

  it("boot-load of a write-capable obsidian-rest source registers its write capability discoverable-only", async () => {
    writeSourcesConfig({ version: 1, sources: [restSource()] });

    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    const loaded = await managed.loadPersisted();
    expect(loaded).toContain("obsidian-rest");
    // The write capability is DISCOVERABLE (registered) — grants still required to invoke.
    expect(capabilities.get(REST_VAULT_WRITE_ID)).toBeDefined();
    expect(capabilities.get(REST_VAULT_WRITE_ID)?.grants).toContain("write");
  });

  it("W-1/F-4: a write-capable boot-load emits a `source.install` audit event (visibility)", async () => {
    writeSourcesConfig({ version: 1, sources: [restSource()] });
    const { capabilities, grants } = freshDeps();
    const events: { type: string; detail?: Record<string, unknown> }[] = [];
    const audit = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async write(e: { type: string; detail?: Record<string, unknown> }) {
        events.push(e);
        return e as unknown;
      },
    };
    const managed = createManagedSources({ capabilities, grants, audit });
    await managed.loadPersisted();
    const evt = events.find(
      (e) => e.type === "source.install" && e.detail?.outcome === "boot-load",
    );
    expect(evt).toBeDefined();
    expect(evt!.detail?.writeCapable).toBe(true);
    expect(evt!.detail?.source).toBe("obsidian-rest");
  });

  it("W-1: a read-only boot-load does NOT emit a write-capable audit event (no noise)", async () => {
    writeSourcesConfig({ version: 1, sources: [fsSource("/tmp/x")] });
    const { capabilities, grants } = freshDeps();
    const events: { type: string; detail?: Record<string, unknown> }[] = [];
    const audit = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async write(e: { type: string; detail?: Record<string, unknown> }) {
        events.push(e);
        return e as unknown;
      },
    };
    const managed = createManagedSources({ capabilities, grants, audit });
    await managed.loadPersisted();
    expect(events.some((e) => e.detail?.outcome === "boot-load")).toBe(false);
  });
});

describe("msrc-t0: remove purges grants for the removed ids", () => {
  it("drops the source from config and purges its grants", async () => {
    const { capabilities, grants } = freshDeps();
    const managed = createManagedSources({ capabilities, grants });

    await managed.add(fsSource("/tmp/x"));
    // Stage a grant for the live capability id.
    grants.put({
      agentId: "agent-x",
      capabilityId: VAULT_READ_ID,
      verbs: ["read"],
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(grants.get("agent-x", VAULT_READ_ID)).toBeDefined();

    await managed.remove(OBSIDIAN_SOURCE_ID);

    // Config dropped, live gone, grant purged.
    expect(managed.list()).toHaveLength(0);
    expect(capabilities.get(VAULT_READ_ID)).toBeUndefined();
    expect(grants.get("agent-x", VAULT_READ_ID)).toBeUndefined();
  });
});
