/**
 * Networking resilience — proxy AUTO-RECONNECT after a transient tunnel drop, with the
 * mounted capabilities + grants SURVIVING the blip (networking-resilience design §1/§4;
 * mesh §5 Invariant B; phase-2-impl-plan Risk 1 "no-unmount-on-transient-disconnect").
 *
 * ONE in-process primary + proxy joined by the real tunnel. We mount + expose the proxy's
 * cap, grant it ONCE (a standing grant → a reusable scoped token), then FORCE a transient
 * socket drop from the PRIMARY side (`dropProxyConnections()` — NOT a proxy restart). We
 * assert the proxy heals the tunnel on its own (resolution unavailable → ok with no manual
 * `start()`), and that across the whole blip:
 *   • the mounted address stays in the directory (Risk 1 — never unmounted on a transient drop),
 *   • the SAME grant/token still authorizes (Invariant B — a route change touches no grant),
 *   • an invoke resumes end-to-end.
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
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost, type GatewayConfig } from "@plexus/runtime/config.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { mockSourceModule } from "@plexus/runtime/sources/index.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";

const WORKLOAD = "edge-1";
const TENANT = "local";
const BARE_ID = "mock.echo.run";

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
async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

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

async function handshake(): Promise<HandshakeResponse> {
  const res = await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: primary.state.connectionKey.current(),
      client: { name: "resilience", agentId: "agent-resilience" },
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

async function invokeWith(token: string, input: Record<string, unknown>): Promise<{ status: number; body: InvokeResponse }> {
  const res = await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: mountedAddress, input }),
  });
  return { status: res.status, body: (await res.json()) as InvokeResponse };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-resilience-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  base = loadConfig(); // no-env ⇒ primary
  host = expectedHost(base);

  const primaryId = generateMeshIdentity();
  const proxyId = generateMeshIdentity();

  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const tunnelUrl = `ws://127.0.0.1:${primary.state.mesh.tunnelPort}`;

  const minted = primary.state.mesh.enrollment!.mintJoinToken();
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

  mountedAddress = `${TENANT}/${WORKLOAD}/${BARE_ID}`;
  await until(() => primary.state.mesh.connected && primary.state.capabilities.get(mountedAddress) !== undefined);
  primary.state.exposure.setEnabled(mountedAddress, true);
  await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok");
});

afterAll(() => {
  proxy?.state.mesh.stop();
  primary?.state.mesh.stop();
  delete process.env.PLEXUS_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("networking resilience — auto-reconnect + grant/mount survival", () => {
  it("the proxy surfaces a connection state", () => {
    expect(proxy.state.mesh.proxyConnectionState).toBe("connected");
    expect(primary.state.mesh.proxyConnectionState).toBeUndefined(); // a primary dials no one
  });

  it("a transient socket drop AUTO-recovers; the mounted cap + grant SURVIVE; invoke resumes", async () => {
    // Grant ONCE — a standing grant yields a reusable scoped token.
    const hs = await handshake();
    const token = (await grantAllow(hs.sessionId, mountedAddress)).token;

    const before = await invokeWith(token, { text: "before-drop" });
    expect(before.status).toBe(200);
    expect(String(before.body.output).trim()).toBe("before-drop");

    // The mounted address exists pre-drop.
    expect(primary.state.capabilities.get(mountedAddress)).toBeDefined();

    // FORCE a transient drop from the PRIMARY (a network blip) — NOT a proxy restart. The proxy's
    // MeshClient must heal it on its own (auto-reconnect, capped backoff + re-auth + catalog re-push).
    primary.state.mesh.dropProxyConnections();

    // Resolution flips unavailable (route changed) — but the ADDRESS + grant are untouched (Inv B).
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "unavailable");
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD).status).toBe("unavailable");
    // RISK 1 — the mounted cap is NOT unmounted on a transient drop (mounted-but-unavailable).
    expect(primary.state.capabilities.get(mountedAddress)).toBeDefined();

    // AUTO-RECONNECT — with NO manual `proxy.start()`, the tunnel comes back and resolution recovers.
    await until(() => primary.state.mesh.connected && primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok");
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD).status).toBe("ok");
    expect(proxy.state.mesh.proxyConnectionState).toBe("connected");

    // The SAME grant/token still authorizes (Invariant B — a route change touched no grant), and the
    // mount is intact, so the invoke resumes end-to-end with NO re-grant and NO re-mount.
    expect(primary.state.capabilities.get(mountedAddress)).toBeDefined();
    const after = await invokeWith(token, { text: "after-reconnect" });
    expect(after.status).toBe(200);
    expect(after.body.ok).toBe(true);
    expect(String(after.body.output).trim()).toBe("after-reconnect");
  });
});
