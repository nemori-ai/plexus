/**
 * T8 — Proxy tunnel-trust ingress (federated-mesh §3.4 Invocation/tunnel-trust, §5 Inv C/E,
 * §7 Q1/Q2; phase-1 plan risk #2 — SECURITY-CRITICAL).
 *
 * THE ONE GUARDED AUTH-SKIP. An `invoke` arriving on the proxy's Ed25519-mutual-auth tunnel
 * is ALREADY authorized — authority terminated at the primary (Inv E). The proxy enters its
 * OWN invoke pipeline under a SYNTHETIC TRUSTED context that carries the pipeline's
 * module-private tunnel-trust brand (`mintTunnelTrustContext`), which — and ONLY which —
 * makes `invokeById` skip the grant/scope/session gates. We prove:
 *
 *   (unit) the brand authorizes a call with NO scopes, AND it is UNFORGEABLE from any
 *          non-tunnel path (a hand-built or wire-serialized context is denied) — so the
 *          auth-skip is reachable ONLY for calls that provably arrived over the tunnel.
 *   (a)    a forwarded invoke executes end-to-end through the proxy pipeline + records the
 *          authoritative proxy-LOCAL audit event (the record T9 bubbles upstream).
 *   (b)    a locally-disabled proxy capability is DENIED even via the tunnel — the exposure
 *          veto is evaluated at the resource-owning gateway (Inv C), and the primary sees it.
 *   (c)    the agent-facing HTTP surface is UNAFFECTED — it is still fully authorized; the
 *          tunnel-trust skip is NOT reachable from it.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuditEvent,
  CapabilityEntry,
  HandshakeResponse,
  InvokeContext,
  InvokeResponse,
  ScopedToken,
  SourceModule,
  SourceRegistry,
  TransportKind,
  Transport,
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { InvokePipeline, PipelineError, mintTunnelTrustContext } from "@plexus/runtime/core/pipeline.ts";
import type { JsonlAuditWriterLike } from "@plexus/runtime/audit/index.ts";
import { loadConfig, expectedHost, type GatewayConfig } from "@plexus/runtime/config.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { mockSourceModule, mockEntries } from "@plexus/runtime/sources/index.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";

const WORKLOAD = "proxylap";
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

const echoEntry = (): CapabilityEntry => mockEntries().find((e) => e.id === BARE_ID)!;

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
let mountedAddress: string;
/** Authoritative proxy-LOCAL audit events, captured off the proxy's single write path. */
const proxyAudits: AuditEvent[] = [];

async function req(path: string, init?: RequestInit): Promise<Response> {
  return primary.app.request("http://" + host + path, {
    ...init,
    headers: { host, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-t8-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  base = loadConfig();
  host = expectedHost(base);

  // DISTINCT mesh identities (T12) for the in-process primary + proxy.
  const primaryId = generateMeshIdentity();
  const proxyId = generateMeshIdentity();

  // PRIMARY — authority root + tunnel acceptor.
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const tunnelPort = primary.state.mesh.tunnelPort;
  expect(tunnelPort).toBeGreaterThan(0);

  // Mint the one-time join token the proxy presents at enrollment (live T12 flow).
  const enrollment = primary.state.mesh.enrollment!;
  const { token } = enrollment.mintJoinToken();

  // PROXY — dials the primary, owns the executable `mock` source. Carries the pinned
  // primary key (M1) + join token, and authenticates the tunnel on connect.
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
  await proxy.state.capabilities.start();
  await proxy.state.mesh.start();

  // Capture the proxy's authoritative local audit events (the records T9 bubbles up).
  (proxy.state.audit as JsonlAuditWriterLike).setOnAppend((e) => proxyAudits.push(e));

  // The live handshake admits the proxy as a PINNED forward destination.
  await until(() => enrollment.isActive(WORKLOAD));
  expect(enrollment.isActive(WORKLOAD)).toBe(true);

  // MOUNT + EXPOSE the proxy's bare cap in the primary directory.
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

async function handshake(): Promise<HandshakeResponse> {
  const res = await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: primary.state.connectionKey.current(),
      client: { name: "t8", agentId: "agent-t8" },
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

// ── (unit) the synthetic trusted-context construction + unforgeability ───────────────

describe("T8 — synthetic trusted context (unit)", () => {
  it("a minted tunnel-trust context authorizes a call with NO scopes (skips grant/scope/session)", async () => {
    // The proxy's OWN pipeline — exactly what the tunnel ingress runs the call through.
    const pipeline = new InvokePipeline(proxy.state);
    // `mock.echo.run` requires the `read` verb; the minted context carries NO scopes and
    // names a session that was never opened — yet it executes, because the brand skips the
    // grant/scope/session gates (Inv E). This is the ONLY way a no-scope call succeeds.
    const minted = mintTunnelTrustContext({
      jti: "mesh-tunnel",
      sessionId: "mesh-tunnel",
      agentId: "mesh:primary",
    });
    expect(minted.scopes).toEqual([]);

    const res = await pipeline.invokeById({ id: BARE_ID, input: { text: "trusted" } }, minted);
    expect(res.ok).toBe(true);
    expect(String(res.output).trim()).toBe("trusted");
  });

  it("the brand is UNFORGEABLE from any non-tunnel path — hand-built / wire-serialized contexts are denied", async () => {
    const pipeline = new InvokePipeline(proxy.state);

    // (1) A context fabricated by hand exactly like the agent HTTP /invoke handler builds it
    //     (jti/sessionId/agentId/scopes — NO brand). It must NOT be trusted: with no scopes it
    //     is DENIED by the gates that the tunnel path skips (default-deny holds for HTTP).
    const forged: InvokeContext = {
      jti: "mesh-tunnel",
      sessionId: "mesh-tunnel",
      agentId: "mesh:primary",
      scopes: [],
    };
    const forgedErr = await pipeline
      .invokeById({ id: BARE_ID, input: { text: "forged" } }, forged)
      .then(() => undefined)
      .catch((e) => e);
    expect(forgedErr).toBeInstanceOf(PipelineError);
    // An authorization gate fired (session/scope) — i.e. the call was NOT auto-trusted.
    expect(["session_expired", "grant_required", "token_revoked"]).toContain(
      (forgedErr as PipelineError).body.code,
    );

    // (2) A GENUINELY minted context that then crosses a JSON boundary (what happens to any
    //     value on the wire) loses its non-serializable symbol brand ⇒ no longer trusted.
    //     Proves a JSON `invoke` frame off the tunnel cannot carry the brand either.
    const minted = mintTunnelTrustContext({ jti: "mesh-tunnel", sessionId: "mesh-tunnel" });
    const overWire = JSON.parse(JSON.stringify(minted)) as InvokeContext;
    const wireErr = await pipeline
      .invokeById({ id: BARE_ID, input: { text: "wire" } }, overWire)
      .then(() => undefined)
      .catch((e) => e);
    expect(wireErr).toBeInstanceOf(PipelineError);
  });
});

// ── (a)/(b)/(c) end-to-end via the real tunnel ──────────────────────────────────────

describe("T8 — tunnel-trust ingress (integration)", () => {
  it("(a) a forwarded invoke executes through the proxy pipeline + records a local audit event", async () => {
    proxyAudits.length = 0;
    const hs = await handshake();
    const token = await grantAllow(hs.sessionId, mountedAddress);

    const res = await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: mountedAddress, input: { text: "hello-tunnel" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(true);
    expect(String(body.output).trim()).toBe("hello-tunnel");

    // The PROXY recorded the authoritative local invoke audit — keyed by the BARE id, with
    // outcome + redacted input/output captured (the record T9 bubbles upstream).
    const local = proxyAudits.find((e) => e.type === "invoke" && e.capabilityId === BARE_ID);
    expect(local).toBeDefined();
    expect(local!.outcome).toBe("ok");
    expect(local!.input).toBeDefined();
    expect(local!.output).toBeDefined();
  });

  it("(b) a locally-disabled proxy capability is DENIED via the tunnel — exposure veto holds (Inv C)", async () => {
    proxyAudits.length = 0;
    // The PROXY operator disables the bare local capability. Exposure is evaluated at the
    // resource-owning gateway, so this must deny EVEN over the tunnel (join/forward ≠ access).
    // The mounted address stays exposed at the PRIMARY — proving the veto is the proxy's.
    proxy.state.exposure.setEnabled(BARE_ID, false);
    try {
      const hs = await handshake();
      const token = await grantAllow(hs.sessionId, mountedAddress);

      const res = await req("/invoke", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ id: mountedAddress, input: { text: "should-not-run" } }),
      });
      const body = (await res.json()) as InvokeResponse;
      // The primary SEES the proxy's denial as a normal invoke-result (never a hang — Inv E).
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("capability_unexposed");

      // The proxy recorded the denial in its own authoritative log (outcome="denied").
      const denied = proxyAudits.find(
        (e) => e.capabilityId === BARE_ID && e.outcome === "denied",
      );
      expect(denied).toBeDefined();
    } finally {
      proxy.state.exposure.setEnabled(BARE_ID, true); // restore for subsequent tests
    }
  });

  it("(c) the agent-facing HTTP surface is unaffected — still fully authorized (no token ⇒ denied)", async () => {
    // The tunnel-trust skip is NOT reachable from the agent surface: an unauthenticated
    // /invoke is denied at the edge. There is no header/body that grants the tunnel brand.
    const res = await req("/invoke", {
      method: "POST",
      body: JSON.stringify({ id: mountedAddress, input: { text: "no-token" } }),
    });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");

    // And a properly-authorized call still works (the HTTP path is fully authorized, not broken).
    const hs = await handshake();
    const token = await grantAllow(hs.sessionId, mountedAddress);
    const okRes = await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: mountedAddress, input: { text: "with-token" } }),
    });
    const okBody = (await okRes.json()) as InvokeResponse;
    expect(okBody.ok).toBe(true);
    expect(String(okBody.output).trim()).toBe("with-token");
  });
});
