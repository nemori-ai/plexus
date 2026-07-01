/**
 * Encryption policy — MANDATORY channel encryption (encryption-policy design §1).
 * `PLEXUS_MESH_REQUIRE_ENCRYPTION=1` makes the primary REFUSE a plain-`ws` proxy at the
 * handshake (typed `encryption_required`, before any admit/pin — so the one-time join token
 * is NOT consumed) while a `wss` proxy authenticates + forwards normally. Identity ⟂
 * encryption (mesh §7 Q2): this gates the CHANNEL, not the Ed25519 identity.
 *
 *   (1) require-encryption ON ⇒ a `wss` proxy enrolls + forwards; a plain-`ws` proxy is
 *       REFUSED (never enrolled, its token stays UNCONSUMED for a wss retry).
 *   (2) FAIL-FAST: `PLEXUS_MESH_REQUIRE_ENCRYPTION` with no TLS material throws at config load.
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

const WORKLOAD_WSS = "enc-ok"; // dials wss:// (allowed)
const WORKLOAD_WS = "enc-bad"; // dials ws://  (refused)
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

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: BIND_HOST, fetch: () => new Response("x") });
  const p = s.port ?? 0;
  s.stop(true);
  return p;
}

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

/** Build + start a proxy for `workload` dialing `url`, presenting `token`. Returns it + the token hash. */
function startProxy(
  base: GatewayConfig,
  workload: string,
  primaryPubKey: string,
  url: string,
  token: string,
  caPem?: string,
): ReturnType<typeof createAppWithState> {
  const sources = testRegistry([mockSourceModule]);
  const caps = createCapabilityRegistry(sources);
  const config: GatewayConfig = { ...base, mode: "proxy", upstream: { url, primaryPubKey }, workload };
  return createAppWithState(config, {
    sources,
    capabilities: caps,
    mesh: { identity: generateMeshIdentity(), joinToken: token, ...(caPem ? { upstreamTls: { ca: caPem } } : {}) },
  });
}

let home: string;
let certDir: string;
let wsPort: number;
let wssPort: number;
let certPem: string;
let primary: ReturnType<typeof createAppWithState>;
let proxyWss: ReturnType<typeof createAppWithState>;
let proxyWs: ReturnType<typeof createAppWithState>;
let wsTokenHash: string;
let primaryPubKey: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-reqenc-home-"));
  certDir = mkdtempSync(join(tmpdir(), "plexus-mesh-reqenc-cert-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();

  const cert = makeCert(certDir);
  certPem = cert.certPem;
  wsPort = freePort();
  do {
    wssPort = freePort();
  } while (wssPort === wsPort);

  // require-encryption ON, with the wss listener configured.
  process.env.PLEXUS_MESH_TUNNEL_HOST = BIND_HOST;
  process.env.PLEXUS_MESH_WS_PORT = String(wsPort);
  process.env.PLEXUS_MESH_WSS_PORT = String(wssPort);
  process.env.PLEXUS_MESH_TLS_CERT = cert.certPath;
  process.env.PLEXUS_MESH_TLS_KEY = cert.keyPath;
  process.env.PLEXUS_MESH_REQUIRE_ENCRYPTION = "1";

  const base = loadConfig();
  expect(base.tunnel?.requireEncryption).toBe(true);

  const primaryId = generateMeshIdentity();
  primaryPubKey = primaryId.publicKeyPem;
  primary = createAppWithState(base, { authorizer: new AutoApproveAuthorizer(), mesh: { identity: primaryId } });
  await primary.state.mesh.start();

  const enrollment = primary.state.mesh.enrollment!;
  const wssMinted = enrollment.mintJoinToken();
  const wsMinted = enrollment.mintJoinToken();
  wsTokenHash = wsMinted.tokenHash;

  // wss proxy (allowed) trusts the in-test CA; ws proxy (refused) dials plain ws.
  proxyWss = startProxy(base, WORKLOAD_WSS, primaryPubKey, `wss://${BIND_HOST}:${wssPort}`, wssMinted.token, certPem);
  proxyWs = startProxy(base, WORKLOAD_WS, primaryPubKey, `ws://${BIND_HOST}:${wsPort}`, wsMinted.token);
  await proxyWss.state.capabilities.start();
  await proxyWs.state.capabilities.start();
  await Promise.all([proxyWss.state.mesh.start(), proxyWs.state.mesh.start()]);
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
    "PLEXUS_MESH_REQUIRE_ENCRYPTION",
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

describe("encryption policy — mandatory channel encryption", () => {
  it("(1) a wss proxy ENROLLS + forwards; a plain-ws proxy is REFUSED with its token UNCONSUMED", async () => {
    const enrollment = primary.state.mesh.enrollment!;

    // The wss (encrypted) proxy authenticates + enrolls.
    await until(() => enrollment.isActive(WORKLOAD_WSS));
    expect(enrollment.isActive(WORKLOAD_WSS)).toBe(true);

    // The plain-ws proxy is refused at the handshake (encryption_required). Give it ample time to
    // (fail to) enroll — it must NEVER become active, and its one-time token stays UNCONSUMED
    // (refused BEFORE admit), so the operator can retry the same token over wss.
    await sleep(800);
    expect(enrollment.isActive(WORKLOAD_WS)).toBe(false);
    expect(enrollment.hasPendingToken(wsTokenHash)).toBe(true); // token NOT burned

    // The wss tunnel forwards a real invoke (channel encryption ON, bare id on the wire).
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD_WSS).status === "ok");
    const address = primary.state.capabilities.mountRemoteWorkload(WORKLOAD_WSS, [echoEntry()], { tenant: TENANT }).mounted[0]!;
    primary.state.exposure.setEnabled(address, true);
    const transport = primary.state.sources.getTransport("mesh") as MeshTransport;
    const res = await transport.dispatch(primary.state.capabilities.get(address)!, { text: "sealed" });
    expect(res.ok).toBe(true);
    expect(String(res.data).trim()).toBe("sealed");
    expect(proxyWss.state.mesh.lastForwardedInvoke?.id).toBe(BARE_ID);

    // The refused plain-ws proxy never forwarded anything.
    expect(proxyWs.state.mesh.lastForwardedInvoke).toBeUndefined();
  });
});

describe("encryption policy — fail-fast misconfig", () => {
  it("(2) PLEXUS_MESH_REQUIRE_ENCRYPTION with no TLS material throws at config load", () => {
    const saved = {
      cert: process.env.PLEXUS_MESH_TLS_CERT,
      key: process.env.PLEXUS_MESH_TLS_KEY,
      wss: process.env.PLEXUS_MESH_WSS_PORT,
      req: process.env.PLEXUS_MESH_REQUIRE_ENCRYPTION,
    };
    delete process.env.PLEXUS_MESH_TLS_CERT;
    delete process.env.PLEXUS_MESH_TLS_KEY;
    delete process.env.PLEXUS_MESH_WSS_PORT;
    process.env.PLEXUS_MESH_REQUIRE_ENCRYPTION = "1";
    try {
      expect(() => loadConfig()).toThrow(/REQUIRE_ENCRYPTION requires/);
    } finally {
      if (saved.cert !== undefined) process.env.PLEXUS_MESH_TLS_CERT = saved.cert;
      if (saved.key !== undefined) process.env.PLEXUS_MESH_TLS_KEY = saved.key;
      if (saved.wss !== undefined) process.env.PLEXUS_MESH_WSS_PORT = saved.wss;
      if (saved.req !== undefined) process.env.PLEXUS_MESH_REQUIRE_ENCRYPTION = saved.req;
    }
  });
});
