/**
 * T7 — Mesh transport + invoke forward (federated-mesh §3.4 Invocation/InvocationRouter,
 * §7 Q1 primary passthrough + Q4 bare-id-on-the-wire, Invariant B; phase-1 plan seam (d)).
 *
 * The first END-TO-END primary→proxy invoke. A PRIMARY and an enrolled PROXY run in ONE
 * process over loopback, joined by the real T4 tunnel. We prove the forward spine:
 *
 *   (a) FORWARD       — `POST /invoke` on the PRIMARY for a MOUNTED address returns the
 *                       proxy's mock result end-to-end (agent talks only to the primary;
 *                       the primary forwards the invoke DOWN the tunnel — §7 Q1).
 *   (b) BARE ON WIRE  — the proxy executes the BARE `source.capability` id, never the
 *                       location prefix (Q4 / Invariant B): the prefix→bare translation
 *                       happens once at the forward boundary; the proxy is workload-agnostic.
 *   (c) PINNED DEST   — the transport REFUSES to forward to an un-enrolled workload
 *                       (no SSRF via a mutable mounted route): a clean capability_unavailable.
 *
 * Tunnel-trust ingress HARDENING (no grant/scope recheck, exposure veto, audit bubble,
 * the guarded auth-skip) is T8 — out of scope here; the proxy does a minimal trusted exec.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  HandshakeResponse,
  InvokeResponse,
  ScopedToken,
  SourceModule,
  SourceRegistry,
  TransportKind,
  Transport,
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost, type GatewayConfig } from "@plexus/runtime/config.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { MeshTransport } from "@plexus/runtime/transports/mesh.ts";
import { mockSourceModule, mockEntries } from "@plexus/runtime/sources/index.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";

const WORKLOAD = "proxylap";
const TENANT = "local";

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

const echoEntry = (): CapabilityEntry => mockEntries().find((e) => e.id === "mock.echo.run")!;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

// ── In-process primary + enrolled proxy, joined by the real tunnel ──────────────

let home: string;
let base: GatewayConfig;
let host: string;
let primary: ReturnType<typeof createAppWithState>;
let proxy: ReturnType<typeof createAppWithState>;
let mountedAddress: string;

async function req(path: string, init?: RequestInit): Promise<Response> {
  return primary.app.request("http://" + host + path, {
    ...init,
    headers: { host, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-t7-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  base = loadConfig(); // no-env → primary
  host = expectedHost(base);

  // ── DISTINCT mesh identities (T12): the in-process primary + proxy must hold
  //    different Ed25519 keys even though they share one PLEXUS_HOME.
  const primaryId = generateMeshIdentity();
  const proxyId = generateMeshIdentity();

  // ── PRIMARY — authority root + tunnel acceptor. AutoApprove so the grant for an
  //    extension-provenance mounted address yields a token deterministically (the grant
  //    UX is not under test here; the forward path is).
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const tunnelPort = primary.state.mesh.tunnelPort;
  expect(tunnelPort).toBeGreaterThan(0);

  // ── Mint the one-time join token the proxy presents at enrollment (T12 live flow).
  const enrollment = primary.state.mesh.enrollment!;
  const { token } = enrollment.mintJoinToken();

  // ── PROXY — dials the primary, owns the executable `mock` source. It carries the
  //    pinned primary pubkey (M1, mandatory) + its join token, and AUTHENTICATES the
  //    tunnel (enroll → Ed25519 mutual challenge) automatically on connect.
  const proxySources = testRegistry([mockSourceModule]);
  const proxyCaps = createCapabilityRegistry(proxySources);
  const proxyConfig: GatewayConfig = {
    ...base,
    mode: "proxy",
    upstream: { url: `ws://127.0.0.1:${tunnelPort}`, primaryPubKey: primaryId.publicKeyPem },
    workload: WORKLOAD,
  };
  proxy = createAppWithState(proxyConfig, {
    sources: proxySources,
    capabilities: proxyCaps,
    mesh: { identity: proxyId, joinToken: token },
  });
  await proxy.state.capabilities.start(); // scan mock → mock.echo.run is invocable
  await proxy.state.mesh.start(); // dial + enroll + mutually authenticate the tunnel

  // The live handshake admits the proxy as a PINNED forward destination.
  await until(() => enrollment.isActive(WORKLOAD));
  expect(enrollment.isActive(WORKLOAD)).toBe(true);

  // ── MOUNT the proxy's bare mock cap into the primary directory (T6) + EXPOSE it.
  const mount = primary.state.capabilities.mountRemoteWorkload(WORKLOAD, [echoEntry()], { tenant: TENANT });
  mountedAddress = mount.mounted[0]!;
  expect(mountedAddress).toBe(`${TENANT}/${WORKLOAD}/mock.echo.run`);
  primary.state.exposure.setEnabled(mountedAddress, true); // mounted caps default hidden (§7 Q3)

  // Wait for the dialed tunnel to attach before forwarding.
  await until(() => primary.state.mesh.connected);
  expect(primary.state.mesh.connected).toBe(true);
});

afterAll(() => {
  // Tear down the DIALER (proxy) before the ACCEPTOR (primary): closing the proxy first
  // sets its client `closed` flag, so the primary's tunnel drop never schedules a stray
  // reconnect timer on the proxy. Deterministic, leak-free teardown across files.
  proxy?.state.mesh.stop();
  primary?.state.mesh.stop();
  delete process.env.PLEXUS_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function handshake(): Promise<HandshakeResponse> {
  const res = await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: primary.state.connectionKey.current(),
      client: { name: "t7", agentId: "agent-t7" },
    }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grantAllow(sessionId: string, id: string): Promise<ScopedToken> {
  const res = await req("/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

describe("T7 — primary→proxy invoke forward", () => {
  it("(a) POST /invoke on the primary for a mounted address returns the proxy's mock result", async () => {
    const hs = await handshake();
    const token = await grantAllow(hs.sessionId, mountedAddress);

    const res = await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: mountedAddress, input: { text: "hello-proxy" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeResponse;

    // The agent's reply is keyed by the MOUNTED address (its URN); the value is the
    // proxy's real `echo` output, forwarded back up the tunnel.
    expect(body.ok).toBe(true);
    expect(body.id).toBe(mountedAddress);
    expect(String(body.output).trim()).toBe("hello-proxy");
  });

  it("(b) the proxy executes the BARE id — the prefix never crosses the wire (Q4 / Inv B)", () => {
    const lastOnProxy = proxy.state.mesh.lastForwardedInvoke;
    expect(lastOnProxy).toBeDefined();
    // The EXECUTABLE id on the wire is bare `source.capability` — no location prefix.
    expect(lastOnProxy!.id).toBe("mock.echo.run");
    expect(lastOnProxy!.id.includes("/")).toBe(false);
    // The full address still rides along as the audited URN (Invariant B), but it is
    // never what the proxy executes.
    expect(lastOnProxy!.address).toBe(mountedAddress);
  });

  it("(c) the transport PINS the enrolled destination — an un-enrolled workload is refused", async () => {
    // Mount a SECOND workload that was never enrolled. Its forward route exists, but the
    // pin (active-enrollment check) must reject it — no SSRF via a mutable mounted route.
    const rogue = primary.state.capabilities.mountRemoteWorkload("rogue", [echoEntry()], { tenant: TENANT });
    const rogueAddress = rogue.mounted[0]!;
    const entry = primary.state.capabilities.get(rogueAddress)!;
    const meshTransport = primary.state.sources.getTransport("mesh") as MeshTransport;

    const result = await meshTransport.dispatch(entry, { text: "should-not-run" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("capability_unavailable");
    expect(result.error?.message).toMatch(/not an enrolled proxy/);
  });
});
