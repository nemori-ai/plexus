/**
 * B7 / P4-0 — Cross-host tunnel SPINE: dual ws+wss listeners + routable bind + TLS.
 *
 * The tunnel used to bind `127.0.0.1` + an ephemeral port over a SINGLE plain-`ws` listener —
 * unreachable from any container/VM, and unencrypted. B7 opens it: a configurable bind host +
 * FIXED ports + an optional TLS (`wss`) listener bound ALONGSIDE the `ws` one, both sharing the
 * SAME enroll/forward/audit connection model (A3 fan-out). Identity ⟂ encryption (mesh §7 Q2):
 * the Ed25519 handshake authenticates either way; `wss` only adds confidentiality underneath, so
 * a self-signed cert is a fine channel-encryption layer.
 *
 * This spec drives the WHOLE spine through the real runtime, configured by the B7 env keys:
 *
 *   (1) DUAL BIND — the primary binds BOTH listeners on the configured host + fixed ports; status
 *       reports both endpoints (`ws` + `wss`) + the primary pubkey.
 *   (2) CONCURRENT enc-ON + enc-OFF — proxy-A dials `wss://` trusting the test CA (enc-ON) and
 *       proxy-B dials `ws://` (enc-OFF), CONCURRENTLY; BOTH authenticate, enroll, and forward an
 *       invoke that returns the proxy's real result. The bare id (never the prefix) crosses each.
 *   (3) TLS IS REAL — an UNTRUSTED-CA `wss` client (no CA trust) fails the TLS handshake outright,
 *       so a green run cannot hide a TLS misconfig (the `wss` listener genuinely demands TLS).
 *
 * Ephemeral (discovered-free) ports + a temp PLEXUS_HOME keep it isolation-safe (no hardcoded ports).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
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

const WORKLOAD_WSS = "proxy-enc-on"; // dials wss:// (channel encryption ON)
const WORKLOAD_WS = "proxy-enc-off"; // dials ws://  (channel encryption OFF)
const TENANT = "local";
const BARE_ID = "mock.echo.run";
const BIND_HOST = "127.0.0.1";

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
async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

/** Grab a currently-free TCP port (bind :0, read it, release) — no hardcoded port. */
function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: BIND_HOST, fetch: () => new Response("x") });
  const p = s.port ?? 0;
  s.stop(true);
  return p;
}

/** Generate a fresh self-signed cert for the loopback host (in-test CA — never a real cert). */
function makeCert(dir: string): { certPath: string; keyPath: string; certPem: string } {
  const keyPath = join(dir, "tunnel-key.pem");
  const certPath = join(dir, "tunnel-cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "2",
      "-subj", `/CN=${BIND_HOST}`, "-addext", `subjectAltName=IP:${BIND_HOST}`,
    ],
    { stdio: "ignore" },
  );
  return { certPath, keyPath, certPem: readFileSync(certPath, "utf8") };
}

/** Build + start an enrolled proxy for `workload`, dialing the given upstream URL (+ optional CA trust). */
async function startProxy(
  primary: ReturnType<typeof createAppWithState>,
  base: GatewayConfig,
  workload: string,
  primaryPubKey: string,
  url: string,
  caPem?: string,
): Promise<ReturnType<typeof createAppWithState>> {
  const { token } = primary.state.mesh.enrollment!.mintJoinToken();
  const sources = testRegistry([mockSourceModule]);
  const caps = createCapabilityRegistry(sources);
  const config: GatewayConfig = { ...base, mode: "proxy", upstream: { url, primaryPubKey }, workload };
  const proxy = createAppWithState(config, {
    sources,
    capabilities: caps,
    mesh: {
      identity: generateMeshIdentity(),
      joinToken: token,
      ...(caPem ? { upstreamTls: { ca: caPem } } : {}),
    },
  });
  await proxy.state.capabilities.start();
  await proxy.state.mesh.start();
  return proxy;
}

let home: string;
let certDir: string;
let wsPort: number;
let wssPort: number;
let certPem: string;
let primary: ReturnType<typeof createAppWithState>;
let proxyWss: ReturnType<typeof createAppWithState>;
let proxyWs: ReturnType<typeof createAppWithState>;
let addressWss: string;
let addressWs: string;
let meshTransport: MeshTransport;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-b7-home-"));
  certDir = mkdtempSync(join(tmpdir(), "plexus-mesh-b7-cert-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  // In-test self-signed TLS material + two discovered-free FIXED ports for the dual listeners.
  const cert = makeCert(certDir);
  certPem = cert.certPem;
  wsPort = freePort();
  do {
    wssPort = freePort();
  } while (wssPort === wsPort);

  // The B7 boot env: routable bind host + FIXED ws/wss ports + TLS material paths.
  process.env.PLEXUS_MESH_TUNNEL_HOST = BIND_HOST;
  process.env.PLEXUS_MESH_WS_PORT = String(wsPort);
  process.env.PLEXUS_MESH_WSS_PORT = String(wssPort);
  process.env.PLEXUS_MESH_TLS_CERT = cert.certPath;
  process.env.PLEXUS_MESH_TLS_KEY = cert.keyPath;

  const base = loadConfig(); // no PLEXUS_MODE → primary, with the tunnel config parsed in
  const primaryId = generateMeshIdentity();
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();

  // Both proxies enroll CONCURRENTLY — one over wss (enc-ON, CA-trusted), one over ws (enc-OFF).
  [proxyWss, proxyWs] = await Promise.all([
    startProxy(primary, base, WORKLOAD_WSS, primaryId.publicKeyPem, `wss://${BIND_HOST}:${wssPort}`, certPem),
    startProxy(primary, base, WORKLOAD_WS, primaryId.publicKeyPem, `ws://${BIND_HOST}:${wsPort}`),
  ]);

  const enrollment = primary.state.mesh.enrollment!;
  await until(() => enrollment.isActive(WORKLOAD_WSS) && enrollment.isActive(WORKLOAD_WS));
  await until(
    () =>
      primary.state.mesh.resolution.healthOf(WORKLOAD_WSS).status === "ok" &&
      primary.state.mesh.resolution.healthOf(WORKLOAD_WS).status === "ok",
  );

  addressWss = primary.state.capabilities.mountRemoteWorkload(WORKLOAD_WSS, [echoEntry()], { tenant: TENANT }).mounted[0]!;
  addressWs = primary.state.capabilities.mountRemoteWorkload(WORKLOAD_WS, [echoEntry()], { tenant: TENANT }).mounted[0]!;
  primary.state.exposure.setEnabled(addressWss, true);
  primary.state.exposure.setEnabled(addressWs, true);

  meshTransport = primary.state.sources.getTransport("mesh") as MeshTransport;
});

afterAll(() => {
  primary?.state.mesh.stop();
  proxyWss?.state.mesh.stop();
  proxyWs?.state.mesh.stop();
  for (const k of [
    "PLEXUS_HOME",
    "PLEXUS_MESH_TUNNEL_HOST",
    "PLEXUS_MESH_WS_PORT",
    "PLEXUS_MESH_WSS_PORT",
    "PLEXUS_MESH_TLS_CERT",
    "PLEXUS_MESH_TLS_KEY",
  ]) {
    delete process.env[k];
  }
  for (const d of [home, certDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("B7 / P4-0 — dual ws+wss tunnel spine", () => {
  it("(1) binds BOTH listeners on the configured host + fixed ports; status reports both endpoints", () => {
    // The plain-ws acceptor bound on the FIXED port we configured (no longer ephemeral).
    expect(primary.state.mesh.tunnelPort).toBe(wsPort);

    const endpoints = primary.state.mesh.tunnelEndpoints;
    const ws = endpoints.find((e) => e.scheme === "ws");
    const wss = endpoints.find((e) => e.scheme === "wss");
    expect(ws).toEqual({ scheme: "ws", host: BIND_HOST, port: wsPort });
    expect(wss).toEqual({ scheme: "wss", host: BIND_HOST, port: wssPort });
    expect(primary.state.mesh.meshPublicKey).toBeDefined();
  });

  it("(2) concurrent enc-ON (wss) + enc-OFF (ws) proxies BOTH authenticate, enroll, and forward", async () => {
    const enrollment = primary.state.mesh.enrollment!;
    expect(enrollment.isActive(WORKLOAD_WSS)).toBe(true);
    expect(enrollment.isActive(WORKLOAD_WS)).toBe(true);

    // The enc-ON proxy genuinely dialed wss:// (channel encryption ON).
    expect(proxyWss.state.config.upstream?.url.startsWith("wss://")).toBe(true);
    expect(proxyWs.state.config.upstream?.url.startsWith("ws://")).toBe(true);

    // Forward over the wss tunnel — the proxy's real result returns; the bare id crossed.
    const resWss = await meshTransport.dispatch(primary.state.capabilities.get(addressWss)!, { text: "over-tls" });
    expect(resWss.ok).toBe(true);
    expect(String(resWss.data).trim()).toBe("over-tls");
    expect(proxyWss.state.mesh.lastForwardedInvoke?.id).toBe(BARE_ID);
    expect(proxyWss.state.mesh.lastForwardedInvoke?.address).toBe(addressWss);

    // Forward over the plain ws tunnel — independently correct (fan-out, no cross-route).
    const resWs = await meshTransport.dispatch(primary.state.capabilities.get(addressWs)!, { text: "over-plain" });
    expect(resWs.ok).toBe(true);
    expect(String(resWs.data).trim()).toBe("over-plain");
    expect(proxyWs.state.mesh.lastForwardedInvoke?.id).toBe(BARE_ID);
    expect(proxyWs.state.mesh.lastForwardedInvoke?.address).toBe(addressWs);

    // The wss invoke never landed on the ws proxy's socket and vice-versa.
    expect(proxyWss.state.mesh.lastForwardedInvoke?.address).toBe(addressWss);
    expect(proxyWs.state.mesh.lastForwardedInvoke?.address).toBe(addressWs);
  });

  it("(3) an UNTRUSTED-CA wss client fails the TLS handshake — the listener really demands TLS", async () => {
    // No CA trust + no relaxation ⇒ Bun rejects the self-signed cert at the TLS handshake. A green
    // run cannot hide a TLS misconfig: if the listener were plain ws, this would connect instead.
    const url = `wss://${BIND_HOST}:${wssPort}`;
    const outcome = await new Promise<"error" | "open">((resolve) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve("error"); // never opened within the window ⇒ rejected
      }, 2_000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve("open");
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        resolve("error");
      });
    });
    expect(outcome).toBe("error");

    // Sanity: the SAME endpoint accepts a CA-TRUSTING client — proving the failure above was the
    // missing trust, not a dead port (real TLS negotiated, not a coincidental refusal).
    const trusted = await new Promise<"error" | "open">((resolve) => {
      const ws = new WebSocket(url, { tls: { ca: certPem } } as unknown as string[]);
      const t = setTimeout(() => resolve("error"), 2_000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve("open");
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        resolve("error");
      });
    });
    expect(trusted).toBe("open");
  });
});
