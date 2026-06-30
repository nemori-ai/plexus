/**
 * T10 — Health / downtime signal (federated-mesh §3.1 ResolutionTable, §3.4 Invocation,
 * §5 Invariant B/E; phase-1 plan seam (f)).
 *
 * A capability has EXACTLY ONE home — its workload, reached over that workload's single
 * dialed tunnel (NO replica/failover). When that home goes down, the primary must give an
 * ACCURATE, typed signal — `capability_unavailable` + `unavailableSince` — and NEVER hang.
 *
 *   UNIT        — the ResolutionTable stamps `unavailableSince` on disconnect, keeps the
 *                 original stamp across redundant down signals, and clears it on reconnect
 *                 (health changes the resolution, never the address — Invariant B).
 *
 *   INTEGRATION — boot a primary + an enrolled+authenticated proxy over the real tunnel,
 *                 mount+enable a cap, confirm an invoke works; then DROP the proxy's socket →
 *                 a primary `POST /invoke` returns typed `capability_unavailable` with a
 *                 plausible `unavailableSince` and does NOT hang; reconnect → calls resume.
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
import { mockSourceModule, mockEntries } from "@plexus/runtime/sources/index.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import { ResolutionTable } from "@plexus/runtime/mesh/resolution.ts";

const WORKLOAD = "proxylap";
const TENANT = "local";

// ── UNIT: ResolutionTable downtime stamping ─────────────────────────────────────

describe("T10 — ResolutionTable (unit)", () => {
  it("stamps unavailableSince on disconnect; keeps it across redundant down signals; clears on reconnect", () => {
    let nowMs = 1_700_000_000_000;
    const table = new ResolutionTable(() => nowMs);

    // Never observed ⇒ unknown (no signal — the forward path governs).
    expect(table.healthOf(WORKLOAD).status).toBe("unknown");
    expect(table.healthOf(WORKLOAD).unavailableSince).toBeUndefined();

    // Authenticated socket promoted ⇒ reachable, no down-stamp.
    table.markAvailable(WORKLOAD);
    expect(table.healthOf(WORKLOAD).status).toBe("ok");
    expect(table.healthOf(WORKLOAD).unavailableSince).toBeUndefined();

    // Socket dropped ⇒ unavailable, stamped with WHEN it went down.
    table.markUnavailable(WORKLOAD);
    const down = table.healthOf(WORKLOAD);
    expect(down.status).toBe("unavailable");
    expect(down.unavailableSince).toBe(new Date(nowMs).toISOString());
    const firstStamp = down.unavailableSince;

    // A redundant down signal (e.g. close after a fail) keeps the ORIGINAL stamp —
    // "how long down" stays accurate.
    nowMs += 5_000;
    table.markUnavailable(WORKLOAD);
    expect(table.healthOf(WORKLOAD).unavailableSince).toBe(firstStamp);

    // Reconnect clears the down-stamp (Invariant B: resolution changes, address does not).
    table.markAvailable(WORKLOAD);
    expect(table.healthOf(WORKLOAD).status).toBe("ok");
    expect(table.healthOf(WORKLOAD).unavailableSince).toBeUndefined();
  });

  it("ignores an undefined workload (raw / no-gate transport path)", () => {
    const table = new ResolutionTable();
    table.markAvailable(undefined);
    table.markUnavailable(undefined);
    // Nothing recorded — a real workload still reads unknown.
    expect(table.healthOf(WORKLOAD).status).toBe("unknown");
  });
});

// ── INTEGRATION: in-process primary + enrolled proxy over the real tunnel ────────

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

let home: string;
let base: GatewayConfig;
let host: string;
let primary: ReturnType<typeof createAppWithState>;
let proxy: ReturnType<typeof createAppWithState>;
let proxyId: ReturnType<typeof generateMeshIdentity>;
let proxyConfig: GatewayConfig;
let proxySources: SourceRegistry;
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
      client: { name: "t10", agentId: "agent-t10" },
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

/** A full agent invoke of the mounted address. Re-handshakes each call (cheap + isolated). */
async function invokeMounted(text: string): Promise<{ status: number; body: InvokeResponse }> {
  const hs = await handshake();
  const token = await grantAllow(hs.sessionId, mountedAddress);
  const res = await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ id: mountedAddress, input: { text } }),
  });
  return { status: res.status, body: (await res.json()) as InvokeResponse };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-t10-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  base = loadConfig();
  host = expectedHost(base);

  const primaryId = generateMeshIdentity();
  proxyId = generateMeshIdentity();

  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const tunnelPort = primary.state.mesh.tunnelPort;
  expect(tunnelPort).toBeGreaterThan(0);

  const { token } = primary.state.mesh.enrollment!.mintJoinToken();

  proxySources = testRegistry([mockSourceModule]);
  const proxyCaps = createCapabilityRegistry(proxySources);
  proxyConfig = {
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
  await proxy.state.capabilities.start();
  await proxy.state.mesh.start();

  await until(() => primary.state.mesh.enrollment!.isActive(WORKLOAD));

  const mount = primary.state.capabilities.mountRemoteWorkload(WORKLOAD, [echoEntry()], { tenant: TENANT });
  mountedAddress = mount.mounted[0]!;
  primary.state.exposure.setEnabled(mountedAddress, true);

  await until(() => primary.state.mesh.connected);
  expect(primary.state.mesh.connected).toBe(true);
});

afterAll(() => {
  primary?.state.mesh.stop();
  proxy?.state.mesh.stop();
  delete process.env.PLEXUS_HOME;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("T10 — proxy down ⇒ typed capability_unavailable, never a hang", () => {
  it("(a) a healthy mounted cap reads ok and invokes end-to-end", async () => {
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok");
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD).status).toBe("ok");

    const { status, body } = await invokeMounted("hello-up");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(String(body.output).trim()).toBe("hello-up");
  });

  it("(b) DROP the proxy ⇒ resolution flips to unavailable with a plausible unavailableSince", async () => {
    const before = Date.now();
    proxy.state.mesh.stop(); // kill the proxy's socket (no auto-reconnect)

    // The primary observes the close and stamps the down-time.
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "unavailable");
    const h = primary.state.mesh.resolution.healthOf(WORKLOAD);
    expect(h.status).toBe("unavailable");
    expect(h.unavailableSince).toBeDefined();
    const sinceMs = Date.parse(h.unavailableSince!);
    expect(Number.isNaN(sinceMs)).toBe(false);
    // Plausible: stamped at/after we initiated the drop, and not in the future.
    expect(sinceMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(sinceMs).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("(c) POST /invoke for the down cap returns typed capability_unavailable + unavailableSince, fast (no hang)", async () => {
    const started = Date.now();
    // Race against a deadline FAR below the tunnel's 10s request timeout — proving the gate
    // short-circuits up front instead of waiting on a forward that can never be answered.
    const result = await Promise.race([
      invokeMounted("hello-down"),
      sleep(3_000).then(() => "TIMED_OUT" as const),
    ]);
    expect(result).not.toBe("TIMED_OUT");
    const { status, body } = result as { status: number; body: InvokeResponse };
    expect(Date.now() - started).toBeLessThan(3_000);

    // 503 Service Unavailable — a typed, recoverable denial in InvokeResponse shape (never
    // a 400 client-error, never a 500, never a hang).
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("capability_unavailable");
    expect(body.error?.capabilityId).toBe(mountedAddress);
    expect(body.error?.unavailableSince).toBeDefined();
    expect(Number.isNaN(Date.parse(body.error!.unavailableSince!))).toBe(false);
  });

  it("(d) reconnect the proxy ⇒ resolution recovers and invokes resume", async () => {
    // Re-dial: the proxy is already enrolled, so this runs the challenge-only re-auth leg.
    await proxy.state.mesh.start();

    await until(() => primary.state.mesh.connected, 4_000);
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok", 4_000);
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD).status).toBe("ok");

    const { status, body } = await invokeMounted("hello-again");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(String(body.output).trim()).toBe("hello-again");
  });
});
