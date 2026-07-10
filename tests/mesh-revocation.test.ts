/**
 * B6 — Revocation across the mesh (federated-mesh §6.4 / Invariant E).
 *
 * ONE in-process PRIMARY + ONE PROXY (distinct Ed25519 identities, one PLEXUS_HOME), joined
 * by the real T4 tunnel, enrolled + mounted + exposed. Then we drive the TWO revocation
 * surfaces and pin their distinct semantics:
 *
 *   PER-GRANT  (existing `POST /admin/api/revoke {agentId, capabilityId}`) — removes ONE
 *      standing grant for a single mounted address; the ENROLLMENT, the mount, and the live
 *      tunnel are ALL untouched (a grant is not a workload).
 *
 *   WHOLE-WORKLOAD (`POST /admin/api/mesh/revoke {workload}`) — TERMINAL. It:
 *      (a) un-mounts every address the workload owns (gone from `.well-known` + the registry),
 *      (b) refuses a forward to it (typed `capability_unavailable`, never a hang),
 *      (c) drops its live tunnel socket,
 *      (d) tombstones its enrollment so a RECONNECT with the old pinned key fails closed
 *          (`not_enrolled`),
 *      and purges the grants bound to its addresses (Invariant C: effective access ⇒ ¬revoked).
 *
 * Throwaway PLEXUS_HOME — never touches the real ~/.plexus.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  HandshakeResponse,
  InvokeResponse,
  ScopedToken,
  SourceModule,
  SourceRegistry,
  TransportKind,
  Transport,
  WellKnownDocument,
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost, type GatewayConfig } from "@plexus/runtime/config.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { mockSourceModule } from "@plexus/runtime/sources/index.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";

const WORKLOAD = "laptop";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

let home: string;
let base: GatewayConfig;
let host: string;
let tunnelUrl: string;
let mgmtKey: string;
let primary: ReturnType<typeof createAppWithState>;
let proxy: ReturnType<typeof createAppWithState>;
const mountedAddress = `${TENANT}/${WORKLOAD}/${BARE_ID}`;

async function req(path: string, init?: RequestInit): Promise<Response> {
  return primary.app.request("http://" + host + path, {
    ...init,
    headers: { host, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** An admin (mgmt-key) request against the primary's `/admin/api/*` surface. */
async function admin(path: string, body?: unknown, method = "POST"): Promise<Response> {
  return primary.app.request("http://" + host + path, {
    method,
    headers: {
      host,
      "content-type": "application/json",
      "X-Plexus-Connection-Key": mgmtKey,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// The exposure-aware discoverable id set — what the public `.well-known` used to carry
// before the catalog moved post-handshake (authorized-subset model §3.3). Reads the
// primary's registry minus disabled/hidden entries, preserving the exposure filter the
// hidden-cap (revocation → unmounted) assertions depend on.
async function wellKnownIds(): Promise<string[]> {
  return primary.state.capabilities
    .summaries()
    .filter((s) => !primary.state.exposure?.isDisabled(s.id))
    .map((s) => s.id);
}

async function handshake(agentId: string): Promise<HandshakeResponse> {
  const res = await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: primary.state.connectionKey.current(),
      client: { name: "b6", agentId },
    }),
  });
  return (await res.json()) as HandshakeResponse;
}

/** Grant the mounted address to `agentId`; returns the persisted grant's agent key. */
async function grantMounted(agentId: string): Promise<string> {
  const hs = await handshake(agentId);
  const res = await req("/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId: hs.sessionId, grants: { [mountedAddress]: "allow" } }),
  });
  (await res.json()) as ScopedToken;
  const grant = primary.state.grants.all().find((g) => g.capabilityId === mountedAddress);
  expect(grant).toBeDefined();
  return grant!.agentId;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-b6-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  base = loadConfig(); // no-env ⇒ primary mode
  host = expectedHost(base);

  const primaryId = generateMeshIdentity();
  const proxyId = generateMeshIdentity();

  // PRIMARY — authority root + tunnel acceptor. AutoApprove so a grant for the mounted
  // address yields deterministically (grant UX is not under test here).
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  mgmtKey = primary.state.connectionKey.current();
  const tunnelPort = primary.state.mesh.tunnelPort;
  expect(tunnelPort).toBeGreaterThan(0);
  tunnelUrl = `ws://127.0.0.1:${tunnelPort}`;

  // Mint the one-time join token for the proxy.
  const minted = primary.state.mesh.enrollment!.mintJoinToken();

  // PROXY — dials the primary, owns the executable `mock` source, authenticates the tunnel.
  const proxySources = testRegistry([mockSourceModule]);
  const proxyCaps = createCapabilityRegistry(proxySources);
  const proxyConfig: GatewayConfig = {
    ...base,
    mode: "proxy",
    upstream: { url: tunnelUrl, primaryPubKey: primaryId.publicKeyPem },
    workload: WORKLOAD,
  };
  proxy = createAppWithState(proxyConfig, {
    sources: proxySources,
    capabilities: proxyCaps,
    mesh: { identity: proxyId, joinToken: minted.token },
  });
  await proxy.state.capabilities.start();
  await proxy.state.mesh.start();

  // ENROLL + MOUNT + EXPOSE — the precondition for revocation.
  const enrollment = primary.state.mesh.enrollment!;
  await until(() => primary.state.mesh.connected && enrollment.isActive(WORKLOAD));
  await until(() => primary.state.capabilities.get(mountedAddress) !== undefined);
  primary.state.exposure.setEnabled(mountedAddress, true);
  await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok");
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

// The two `it`s run IN ORDER: per-grant revoke must observe an INTACT enrollment, so it runs
// BEFORE the terminal whole-workload revoke.
describe("B6 — revocation across the mesh", () => {
  it("(e) per-grant `POST /api/revoke` removes ONE grant; enrollment + mount + tunnel stay intact", async () => {
    const agentId = await grantMounted("agent-pergrant");
    expect(primary.state.grants.get(agentId, mountedAddress)).toBeDefined();

    const res = await admin("/admin/api/revoke", { agentId, capabilityId: mountedAddress });
    expect(res.status).toBe(200);

    // The grant is gone …
    expect(primary.state.grants.get(agentId, mountedAddress)).toBeUndefined();

    // … but the workload is fully OPERATIONAL: the enrollment is still active, the socket is
    // still up, the address is still mounted + exposed + a legal forward target. A grant is
    // not a workload — revoking one never tears down the mesh enrollment.
    expect(primary.state.mesh.enrollment!.isActive(WORKLOAD)).toBe(true);
    expect(primary.state.mesh.connected).toBe(true);
    expect(primary.state.capabilities.get(mountedAddress)).toBeDefined();
    expect(primary.state.mesh.forwarder.isEnrolledDestination(WORKLOAD)).toBe(true);
    expect(await wellKnownIds()).toContain(mountedAddress);
  });

  it("(a-d) `POST /api/mesh/revoke` unmounts + purges grants + drops socket + tombstones (reconnect fails closed)", async () => {
    // A standing grant to PURGE, and proof the workload is live before we pull the trigger.
    const agentId = await grantMounted("agent-revoke");
    expect(primary.state.grants.get(agentId, mountedAddress)).toBeDefined();
    expect(primary.state.mesh.connected).toBe(true);

    // REVOKE the whole workload through the admin route (exercises the route end-to-end).
    const res = await admin("/admin/api/mesh/revoke", { workload: WORKLOAD });
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      workload: string;
      tombstoned: boolean;
      unmounted: string[];
      purgedGrants: number;
    };
    expect(result.workload).toBe(WORKLOAD);
    expect(result.tombstoned).toBe(true);
    expect(result.unmounted).toContain(mountedAddress);
    expect(result.purgedGrants).toBeGreaterThanOrEqual(1);

    // (a) ADDRESSES GONE — out of the registry AND out of `.well-known`.
    expect(primary.state.capabilities.get(mountedAddress)).toBeUndefined();
    expect(await wellKnownIds()).not.toContain(mountedAddress);

    // grants purged — no standing grant for the un-mounted address survives.
    expect(primary.state.grants.get(agentId, mountedAddress)).toBeUndefined();
    expect(primary.state.grants.all().some((g) => g.capabilityId === mountedAddress)).toBe(false);

    // (b) FORWARD REFUSED — the workload is no longer an enrolled destination, and a forward
    // attempt returns a typed `capability_unavailable` (never a hang — Invariant E).
    expect(primary.state.mesh.forwarder.isEnrolledDestination(WORKLOAD)).toBe(false);
    const forwarded = await primary.state.mesh.forwarder.forwardInvoke(
      { workload: WORKLOAD, bareId: BARE_ID },
      mountedAddress,
      { text: "after-revoke" },
      "corr-after-revoke",
    );
    expect(forwarded.ok).toBe(false);
    expect((forwarded as InvokeResponse).error?.code).toBe("capability_unavailable");

    // (c) LIVE SOCKET DROPPED — and the resolution stamped unavailable.
    await until(() => !primary.state.mesh.connected);
    expect(primary.state.mesh.connected).toBe(false);
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD).status).toBe("unavailable");

    // TOMBSTONE — the enrollment record is terminal `"revoked"`, never deleted.
    const rec = primary.state.mesh.enrollment!.get(WORKLOAD);
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("revoked");
    expect(primary.state.mesh.enrollment!.isActive(WORKLOAD)).toBe(false);

    // (d) RECONNECT FAILS CLOSED — force a fresh dial; the proxy still holds its old pinned key
    // and is internally "enrolled" (challenge-only leg), but the tombstoned ledger has no pin
    // for it → `not_enrolled`. It can NEVER re-promote.
    proxy.state.mesh.stop();
    await proxy.state.mesh.start();
    await sleep(600); // give the (auto-)reconnect attempts time to be rejected
    expect(primary.state.mesh.connected).toBe(false);
    expect(primary.state.mesh.enrollment!.isActive(WORKLOAD)).toBe(false);
  });
});
