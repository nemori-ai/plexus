/**
 * A6 — Stock gateway boot enrolls as a PROXY from `PLEXUS_JOIN_TOKEN` (+ upstream env) ALONE.
 *
 * The A4 two-process demo had to use a CUSTOM `examples/mesh-demo/gateway.ts` launcher
 * because the stock binary did not read the one-time join token from env: the token was
 * only injectable through the `createAppWithState({ mesh: { joinToken } })` seam. A6 closes
 * that gap — the SUPERVISED boot path (`runtime/serve.ts` → `startRuntime`, the same seam
 * `bin/plexus` + `src/index.ts` boot through) now reads `PLEXUS_JOIN_TOKEN` and threads it
 * into the mesh runtime, so a real `PLEXUS_MODE=proxy` gateway enrolls from ENV alone.
 *
 * This spec proves it WITHOUT any token injection: it
 *   1. starts an in-test PRIMARY (tunnel acceptor + enrollment ledger) and mints a token,
 *   2. boots a STOCK proxy gateway via the REAL `startRuntime` — env-configured ONLY
 *      (PLEXUS_MODE/UPSTREAM_URL/UPSTREAM_PUBKEY/WORKLOAD/JOIN_TOKEN), NO `createAppWithState`
 *      mesh injection — and asserts:
 *        • the proxy DIALS → Ed25519-authenticates → ENROLLS using the env join token
 *          (primary.connected + enrollment.isActive flip true),
 *        • the pinned proxy key is the proxy's OWN auto-persisted identity (loaded from its
 *          OWN PLEXUS_HOME, distinct from the primary's) — never injected,
 *        • its local catalog AUTO-MOUNTS on the primary under `tenant/workload/` (live ascent).
 *
 * Plus the ADDITIVE / primary-ignores guards: a `primary` boot with `PLEXUS_JOIN_TOKEN` set
 * still resolves to a primary and never dials (the token is inert), and an unset token leaves
 * the boot byte-for-byte unchanged.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { startRuntime, type RunningRuntime } from "@plexus/runtime/runtime/serve.ts";
import { loadConfig } from "@plexus/runtime/config.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import {
  generateMeshIdentity,
  loadMeshIdentity,
  _resetMeshIdentityCacheForTests,
} from "@plexus/runtime/mesh/keys.ts";
import { openVaultExtension, VAULT_READ_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";

const WORKLOAD = "ubuntu-proxy";
const TENANT = "local";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

/** The env keys this spec mutates — snapshot + restore so it never leaks into sibling specs. */
const ENV_KEYS = [
  "PLEXUS_HOME",
  "PLEXUS_MODE",
  "PLEXUS_UPSTREAM_URL",
  "PLEXUS_UPSTREAM_PUBKEY",
  "PLEXUS_WORKLOAD",
  "PLEXUS_JOIN_TOKEN",
  "PLEXUS_PORT",
] as const;

describe("A6 — stock proxy boot enrolls from PLEXUS_JOIN_TOKEN env alone", () => {
  const primaryHome = mkdtempSync(join(tmpdir(), "plexus-a6-primary-"));
  const proxyHome = mkdtempSync(join(tmpdir(), "plexus-a6-proxy-"));
  const primaryIgnoreHome = mkdtempSync(join(tmpdir(), "plexus-a6-primary-ignore-"));
  const vaultDir = mkdtempSync(join(tmpdir(), "plexus-a6-vault-"));
  writeFileSync(join(vaultDir, "note.md"), "# hello mesh\n");

  const savedEnv: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  let primary: ReturnType<typeof createAppWithState> | undefined;
  let proxyRuntime: RunningRuntime | undefined;

  /** Clear the proxy-only env so a fresh `loadConfig()` resolves a clean primary boot. */
  function clearProxyEnv(): void {
    delete process.env.PLEXUS_MODE;
    delete process.env.PLEXUS_UPSTREAM_URL;
    delete process.env.PLEXUS_UPSTREAM_PUBKEY;
    delete process.env.PLEXUS_WORKLOAD;
    delete process.env.PLEXUS_JOIN_TOKEN;
    delete process.env.PLEXUS_PORT;
  }

  afterAll(() => {
    // DIALER (proxy runtime) before ACCEPTOR (primary tunnel): the proxy's client `closed`
    // flag is set first, so the primary's tunnel drop never schedules a stray reconnect.
    proxyRuntime?.stop();
    primary?.state.mesh.stop();
    // This is the only spec that boots through the REAL supervised seam and AUTO-PERSISTS a
    // mesh identity / secret to disk, populating the module-level caches. Reset them on the
    // way out so no resolved-from-disk state leaks into a sibling spec (P4 adds more boots).
    _resetSecretCacheForTests();
    _resetMeshIdentityCacheForTests();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const dir of [primaryHome, proxyHome, primaryIgnoreHome, vaultDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("a PLEXUS_MODE=proxy + upstream + PLEXUS_JOIN_TOKEN boot enrolls + auto-mounts — no launcher, no injection", async () => {
    // ── PRIMARY (in-test): tunnel acceptor + enrollment ledger, mint a one-time token ──
    process.env.PLEXUS_HOME = primaryHome;
    clearProxyEnv();
    _resetSecretCacheForTests();
    _resetMeshIdentityCacheForTests();

    const primaryId = generateMeshIdentity(); // injected ONLY for the primary (distinct key)
    const primaryConfig = loadConfig();
    expect(primaryConfig.mode).toBe("primary");
    primary = createAppWithState(primaryConfig, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: primaryId },
    });
    await primary.state.mesh.start();
    const tunnelPort = primary.state.mesh.tunnelPort;
    expect(tunnelPort).toBeGreaterThan(0);
    expect(primary.state.mesh.connected).toBe(false);

    const enrollment = primary.state.mesh.enrollment!;
    const { token } = enrollment.mintJoinToken();

    // ── STOCK PROXY BOOT — env-configured ONLY, through the REAL supervised seam ──────
    // No `createAppWithState`, no `mesh: { joinToken }` injection: `startRuntime` must read
    // PLEXUS_JOIN_TOKEN itself. The proxy's Ed25519 identity is NOT supplied — it auto-loads/
    // persists under THIS process's PLEXUS_HOME (distinct from the primary's home).
    process.env.PLEXUS_HOME = proxyHome;
    process.env.PLEXUS_MODE = "proxy";
    process.env.PLEXUS_UPSTREAM_URL = `ws://127.0.0.1:${tunnelPort}`;
    process.env.PLEXUS_UPSTREAM_PUBKEY = primaryId.publicKeyPem;
    process.env.PLEXUS_WORKLOAD = WORKLOAD;
    process.env.PLEXUS_JOIN_TOKEN = token;
    process.env.PLEXUS_PORT = "0"; // ephemeral loopback agent socket
    _resetSecretCacheForTests();
    _resetMeshIdentityCacheForTests();

    const proxyConfig = loadConfig();
    expect(proxyConfig.mode).toBe("proxy");

    // The proxy EXPOSES one deterministic local capability (a path-confined Obsidian vault
    // read) so there is a real catalog to ascend. Registered through the stock `beforeListen`
    // seam (the SAME hook `bin/plexus --vault` uses) — before the tunnel dials.
    proxyRuntime = await startRuntime(proxyConfig, {
      emitReadyLine: false,
      writePortFile: false,
      bootScan: false,
      beforeListen: async (state) => {
        const { manifest, handlers } = openVaultExtension(vaultDir);
        const reg = await state.capabilities.registerExtension(manifest, { handlers });
        expect(reg.ok).toBe(true);
      },
    });

    // ── PROOF 1 — the proxy enrolled from the env join token alone ───────────────────
    await until(() => primary!.state.mesh.connected && enrollment.isActive(WORKLOAD));
    expect(primary.state.mesh.connected).toBe(true);
    expect(enrollment.isActive(WORKLOAD)).toBe(true);

    // ── PROOF 2 — the pinned key is the proxy's OWN auto-persisted identity ───────────
    // (loaded from proxyHome on disk — never injected, never the primary's key).
    const persisted = loadMeshIdentity(); // PLEXUS_HOME === proxyHome here
    expect(persisted).toBeDefined();
    const pinned = enrollment.get(WORKLOAD)!.pinnedProxyPubKey;
    expect(pinned).toBe(persisted!.publicKeyPem);
    expect(pinned).not.toBe(primaryId.publicKeyPem);

    // ── PROOF 3 — the proxy's catalog AUTO-MOUNTED on the primary (live ascent) ───────
    const mountedAddress = `${TENANT}/${WORKLOAD}/${VAULT_READ_ID}`;
    await until(() => primary!.state.capabilities.get(mountedAddress) !== undefined);
    expect(primary.state.capabilities.get(mountedAddress)).toBeDefined();
    expect(primary.state.capabilities.forwardAddress(mountedAddress)?.workload).toBe(WORKLOAD);
    // Mounted ⇒ hidden by default (§7 Q3 — join ≠ access).
    expect(primary.state.capabilities.exposureDefaultFor(mountedAddress)).toBe("hidden");
  });

  it("a PRIMARY boot IGNORES PLEXUS_JOIN_TOKEN (the token is inert; it dials no one)", async () => {
    // A `primary` (default) boot with a stray PLEXUS_JOIN_TOKEN set must still resolve to a
    // primary and never treat the token as enrollment material. Additive: the token is inert.
    // A CLEAN home (its own enrollment ledger) so the assertion reflects THIS boot only.
    process.env.PLEXUS_HOME = primaryIgnoreHome;
    clearProxyEnv();
    process.env.PLEXUS_JOIN_TOKEN = "stray-token-should-be-ignored";

    const config = loadConfig();
    expect(config.mode).toBe("primary");

    _resetMeshIdentityCacheForTests();
    const { state } = createAppWithState(config, { mesh: { identity: generateMeshIdentity() } });
    await state.mesh.start();
    try {
      // A primary opens the tunnel acceptor but is NOT "connected" (no proxy dialed in), and
      // it owns an enrollment ledger with zero active enrollments — the stray token did nothing.
      expect(state.mesh.connected).toBe(false);
      expect(state.mesh.enrollment?.list().filter((r) => r.status === "active").length ?? 0).toBe(0);
    } finally {
      state.mesh.stop();
    }
  });
});
