/**
 * Extension RESTART-SURVIVAL — admin-installed extensions persist across a reboot.
 *
 * THE BUG THIS GUARDS: `registerExtension` only held the materialized module in an
 * in-memory Map, so an admin-installed extension (and the caps + grants hanging off
 * it) vanished from `.well-known` on the next `bun run start`. First-party CONFIG
 * sources persisted (`sources.json`); extension SOURCES did not.
 *
 * Asserts:
 *   1. STORE round-trip: upsert → a NEW store on the same home lists it; remove drops it.
 *   2. SIMULATED RESTART: install via `POST /admin/api/extensions` (the real persist
 *      hook) → build a FRESH gateway state on the SAME home + `bootScanCapabilities` →
 *      the extension's capability is present in the registry AND in `.well-known`.
 *   3. REMOVE survives too: `DELETE /admin/api/extensions/:source` → a subsequent fresh
 *      boot no longer has the capability.
 *   4. FAIL-OPEN: a corrupt `extensions.json` does not brick boot (empty replay).
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createGatewayState, bootScanCapabilities } from "@plexus/runtime/core/state.ts";
import { createExtensionStore, EXTENSIONS_FILE } from "@plexus/runtime/core/extension-store.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import type { ExtensionManifest } from "@plexus/protocol";

const config = loadConfig();
const HOST = expectedHost(config);
const homes: string[] = [];

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-ext-persist-"));
  homes.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  return dir;
}

/** A loopback local-rest WRITE extension (transport-backed) — the worked example. */
function vaultManifest(): ExtensionManifest {
  return {
    manifest: "plexus-extension/0.1",
    source: "user-profile",
    label: "My user profile",
    transport: "local-rest",
    secrets: [{ name: "user-profile-key", attach: "bearer" }],
    capabilities: [
      {
        name: "profile.read",
        kind: "capability",
        label: "Read my profile",
        describe: "Read the profile field {field}.",
        io: {
          input: {
            type: "object",
            properties: { field: { type: "string" } },
            required: ["field"],
          },
        },
        grants: ["read"],
        transport: "local-rest",
        route: {
          baseUrl: "http://127.0.0.1:27191",
          allowedHosts: ["127.0.0.1:27191"],
          method: "GET",
          path: "/profile/{field}",
          secret: { name: "user-profile-key", attach: "bearer" },
        },
      },
    ],
  };
}

const CAP_ID = "user-profile.profile.read";

/** Install an extension through the REAL admin endpoint (which persists it). */
async function adminInstall(app: ReturnType<typeof createAppWithState>["app"], key: string) {
  return app.request("http://" + HOST + "/admin/api/extensions", {
    method: "POST",
    headers: { host: HOST, "X-Plexus-Connection-Key": key },
    body: JSON.stringify({ manifest: vaultManifest() }),
  });
}

async function adminRemove(app: ReturnType<typeof createAppWithState>["app"], key: string) {
  return app.request("http://" + HOST + "/admin/api/extensions/user-profile", {
    method: "DELETE",
    headers: { host: HOST, "X-Plexus-Connection-Key": key },
  });
}

/** Read the `.well-known` capability-summary ids (the discovery surface). */
async function wellKnownIds(app: ReturnType<typeof createAppWithState>["app"]) {
  const res = await app.request("http://" + HOST + "/.well-known/plexus", {
    headers: { host: HOST },
  });
  const doc = (await res.json()) as { capabilities?: { id: string }[] };
  return (doc.capabilities ?? []).map((c) => c.id);
}

/** Simulate a gateway RESTART on the same home: a brand-new state + boot scan. */
async function reboot() {
  _resetSecretCacheForTests();
  const built = createAppWithState(config);
  await bootScanCapabilities(built.state);
  return built;
}

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of homes.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("extension-store: round-trips through a fresh store", () => {
  it("upsert persists; a NEW store on the same home lists it; remove drops it", () => {
    freshHome();
    const store = createExtensionStore();
    expect(store.list()).toHaveLength(0);

    store.upsert(vaultManifest(), { allowCrossSource: false });
    expect(existsSync(join(process.env.PLEXUS_HOME!, EXTENSIONS_FILE))).toBe(true);

    // A brand-new store (simulated restart) reads the same file back.
    const store2 = createExtensionStore();
    expect(store2.list().map((e) => e.manifest.source)).toContain("user-profile");
    expect(store2.list()[0]?.installedAt).toBeString();

    store2.remove("user-profile");
    const store3 = createExtensionStore();
    expect(store3.list()).toHaveLength(0);
  });
});

describe("extension restart-survival: install → reboot → still present", () => {
  it("an admin-installed extension survives a simulated gateway restart", async () => {
    freshHome();

    // Install through the real admin endpoint (the persist hook fires on success).
    const first = createAppWithState(config);
    const key = first.state.connectionKey.current();
    const installRes = await adminInstall(first.app, key);
    expect(installRes.status).toBe(200);
    expect(first.state.capabilities.getEntry(CAP_ID)).toBeDefined();
    expect(await wellKnownIds(first.app)).toContain(CAP_ID);

    // It was written to disk.
    expect(existsSync(join(process.env.PLEXUS_HOME!, EXTENSIONS_FILE))).toBe(true);

    // RESTART: a fresh state + registry on the SAME home. The cap is replayed at boot.
    const second = await reboot();
    expect(second.state.capabilities.getEntry(CAP_ID)).toBeDefined();
    expect(await wellKnownIds(second.app)).toContain(CAP_ID);
  });

  it("a removed extension does NOT come back after a restart", async () => {
    freshHome();

    const first = createAppWithState(config);
    const key = first.state.connectionKey.current();
    await adminInstall(first.app, key);
    expect(first.state.capabilities.getEntry(CAP_ID)).toBeDefined();

    // Remove via the admin endpoint (drops it from the durable store).
    const delRes = await adminRemove(first.app, key);
    expect(delRes.status).toBe(200);
    expect(first.state.capabilities.getEntry(CAP_ID)).toBeUndefined();

    // RESTART: the removed extension stays gone (no replay).
    const second = await reboot();
    expect(second.state.capabilities.getEntry(CAP_ID)).toBeUndefined();
    expect(await wellKnownIds(second.app)).not.toContain(CAP_ID);
  });
});

describe("extension restart-survival: fail-open on a corrupt store", () => {
  it("a corrupt extensions.json does not brick boot", async () => {
    freshHome();
    // Hand-write a garbage file where the store expects JSON.
    writeFileSync(join(process.env.PLEXUS_HOME!, EXTENSIONS_FILE), "{not json at all", "utf8");

    // Boot must complete cleanly with an empty replay (no throw).
    const booted = await reboot();
    expect(booted.state.capabilities.getEntry(CAP_ID)).toBeUndefined();
    // The store itself reports empty rather than throwing.
    expect(createExtensionStore().list()).toHaveLength(0);
    // Sanity: the raw corrupt bytes are still what we wrote (load was read-only).
    expect(readFileSync(join(process.env.PLEXUS_HOME!, EXTENSIONS_FILE), "utf8")).toContain("not json");
  });
});
