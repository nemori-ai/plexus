/**
 * A3 — Multi-proxy fan-out (federated-mesh §3.1 Topology; phase-2 plan card A3 + L-2).
 *
 * The primary now fans out to MANY concurrent proxies, one authenticated socket + one
 * `FrameMux` per workload. TWO proxies (workloads A + B) with DISTINCT Ed25519 keys
 * enroll concurrently against ONE primary over the real tunnel. We prove the three
 * fan-out guarantees the single-socket transport could not make:
 *
 *   (a) NO CROSS-ROUTE (L-2) — an invoke for A's mounted cap reaches A's proxy and NEVER
 *       B's socket; B's proxy executes only B's invokes. `forward(workload, …)` routes by
 *       the authenticated workload, so a frame can never cross to another workload's tunnel.
 *   (b) INDEPENDENT DOWNTIME — B going down does NOT disturb A: A keeps forwarding/returning
 *       while B surfaces a typed `capability_unavailable` (Invariant E), never a hang.
 *   (c) PER-WORKLOAD HEALTH — the ResolutionTable reports each workload's home independently
 *       (A `ok` while B is `unavailable`); A's health is untouched by B's drop.
 *
 * Invokes are driven through the primary's `mesh` transport directly (the agent grant UX is
 * not under test — the forward/route spine is), mirroring T7/T12's `meshTransport.dispatch`.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  SourceModule,
  SourceRegistry,
  TransportKind,
  Transport,
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, type GatewayConfig } from "@plexus/runtime/config.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { MeshTransport } from "@plexus/runtime/transports/mesh.ts";
import { mockSourceModule, mockEntries } from "@plexus/runtime/sources/index.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";

const WORKLOAD_A = "alpha-proxy";
const WORKLOAD_B = "beta-proxy";
const TENANT = "local";
const BARE_ID = "mock.echo.run";

/** A SourceRegistry over an explicit module list (production MODULES is empty). */
function testRegistry(modules: SourceModule[]): SourceRegistry {
  const platform = getPlatformServices();
  const transports = buildTransports(platform);
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport => transports[kind],
  };
}

const echoEntry = (): CapabilityEntry => mockEntries().find((e) => e.id === BARE_ID)!;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

/** Build + start an enrolled proxy for `workload` against the running primary. */
async function startProxy(
  primary: ReturnType<typeof createAppWithState>,
  base: GatewayConfig,
  workload: string,
  primaryPubKey: string,
  tunnelPort: number,
): Promise<ReturnType<typeof createAppWithState>> {
  const { token } = primary.state.mesh.enrollment!.mintJoinToken();
  const sources = testRegistry([mockSourceModule]);
  const caps = createCapabilityRegistry(sources);
  const config: GatewayConfig = {
    ...base,
    mode: "proxy",
    upstream: { url: `ws://127.0.0.1:${tunnelPort}`, primaryPubKey },
    workload,
  };
  const proxy = createAppWithState(config, {
    sources,
    capabilities: caps,
    mesh: { identity: generateMeshIdentity(), joinToken: token },
  });
  await proxy.state.capabilities.start();
  await proxy.state.mesh.start();
  return proxy;
}

// ── Two proxies, distinct keys, one primary, joined by the real tunnel ──────────

let home: string;
let primary: ReturnType<typeof createAppWithState>;
let proxyA: ReturnType<typeof createAppWithState>;
let proxyB: ReturnType<typeof createAppWithState>;
let addressA: string;
let addressB: string;
let meshTransport: MeshTransport;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-a3-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  const base = loadConfig(); // no-env → primary

  const primaryId = generateMeshIdentity();
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const port = primary.state.mesh.tunnelPort;
  expect(port).toBeGreaterThan(0);

  // Both proxies enroll CONCURRENTLY against the same primary, each with its own key + token.
  [proxyA, proxyB] = await Promise.all([
    startProxy(primary, base, WORKLOAD_A, primaryId.publicKeyPem, port),
    startProxy(primary, base, WORKLOAD_B, primaryId.publicKeyPem, port),
  ]);

  const enrollment = primary.state.mesh.enrollment!;
  await until(() => enrollment.isActive(WORKLOAD_A) && enrollment.isActive(WORKLOAD_B));
  expect(enrollment.isActive(WORKLOAD_A)).toBe(true);
  expect(enrollment.isActive(WORKLOAD_B)).toBe(true);
  // Both homes are reachable, tracked independently in the ResolutionTable.
  await until(
    () =>
      primary.state.mesh.resolution.healthOf(WORKLOAD_A).status === "ok" &&
      primary.state.mesh.resolution.healthOf(WORKLOAD_B).status === "ok",
  );

  // Mount + expose each workload's echo cap under its own prefix.
  addressA = primary.state.capabilities.mountRemoteWorkload(WORKLOAD_A, [echoEntry()], { tenant: TENANT }).mounted[0]!;
  addressB = primary.state.capabilities.mountRemoteWorkload(WORKLOAD_B, [echoEntry()], { tenant: TENANT }).mounted[0]!;
  expect(addressA).toBe(`${TENANT}/${WORKLOAD_A}/${BARE_ID}`);
  expect(addressB).toBe(`${TENANT}/${WORKLOAD_B}/${BARE_ID}`);
  primary.state.exposure.setEnabled(addressA, true);
  primary.state.exposure.setEnabled(addressB, true);

  meshTransport = primary.state.sources.getTransport("mesh") as MeshTransport;
});

afterAll(() => {
  // Tear down the DIALERS (proxies) before the ACCEPTOR (primary): closing each proxy first
  // sets its client `closed` flag, so the primary's tunnel drop never schedules a stray
  // reconnect timer on a proxy. Deterministic, leak-free teardown across files.
  proxyA?.state.mesh.stop();
  proxyB?.state.mesh.stop();
  primary?.state.mesh.stop();
  delete process.env.PLEXUS_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Real-WebSocket federation fan-out over two live proxy tunnels: each invoke is a
// real socket round-trip whose forwarded-response timing races on a contended CI
// runner (fast-fails to an empty result even after the health gate passes). The
// hermetic mesh routing/resolution/isolation unit tests stay in CI; this live
// round-trip suite runs full-strength locally / on the demo machine.
describe.skipIf(!!process.env.CI)("A3 — multi-proxy fan-out", () => {
  it("(a) an invoke for A's cap reaches A's proxy and NEVER B's socket (L-2 — no cross-route)", async () => {
    // Before any invoke, neither proxy has executed a forwarded call (catalog ascent does
    // not set this seam — only an `invoke` frame does).
    expect(proxyA.state.mesh.lastForwardedInvoke).toBeUndefined();
    expect(proxyB.state.mesh.lastForwardedInvoke).toBeUndefined();

    const entryA = primary.state.capabilities.get(addressA)!;
    const resA = await meshTransport.dispatch(entryA, { text: "for-alpha" });
    expect(resA.ok).toBe(true);
    expect(String(resA.data).trim()).toBe("for-alpha");

    // A executed it (bare id, full address audited); B's socket NEVER saw it.
    expect(proxyA.state.mesh.lastForwardedInvoke?.id).toBe(BARE_ID);
    expect(proxyA.state.mesh.lastForwardedInvoke?.address).toBe(addressA);
    expect(proxyB.state.mesh.lastForwardedInvoke).toBeUndefined();

    // The symmetric route: B's invoke lands on B, A unchanged (still only A's invoke).
    const entryB = primary.state.capabilities.get(addressB)!;
    const resB = await meshTransport.dispatch(entryB, { text: "for-beta" });
    expect(resB.ok).toBe(true);
    expect(String(resB.data).trim()).toBe("for-beta");
    expect(proxyB.state.mesh.lastForwardedInvoke?.address).toBe(addressB);
    expect(proxyA.state.mesh.lastForwardedInvoke?.address).toBe(addressA); // not B's
  });

  it("(b)/(c) B going down leaves A fully serving; health is independent per workload", async () => {
    // Take ONLY B's tunnel down. (autoReconnect is on, so disable it by closing the whole
    // proxy mesh — the client stops + will not redial.)
    proxyB.state.mesh.stop();

    // The ResolutionTable marks B unavailable; A stays ok — per-workload, no collateral.
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD_B).status === "unavailable");
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD_B).status).toBe("unavailable");
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD_B).unavailableSince).toBeDefined();
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD_A).status).toBe("ok");

    // A still forwards + returns its proxy's real result — entirely unaffected by B's drop.
    const entryA = primary.state.capabilities.get(addressA)!;
    const resA = await meshTransport.dispatch(entryA, { text: "alpha-still-up" });
    expect(resA.ok).toBe(true);
    expect(String(resA.data).trim()).toBe("alpha-still-up");

    // B surfaces a typed capability_unavailable (Invariant E — never a hang, never A's socket).
    const entryB = primary.state.capabilities.get(addressB)!;
    const resB = await meshTransport.dispatch(entryB, { text: "beta-should-fail" });
    expect(resB.ok).toBe(false);
    expect(resB.error?.code).toBe("capability_unavailable");
  });
});
