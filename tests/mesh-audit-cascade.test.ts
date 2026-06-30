/**
 * T9 — Audit cascade / mirror (federated-mesh §3.5 Audit, §5 Invariant D, §7 Q7;
 * phase-1 plan seam (e)).
 *
 * Audit is LOCAL-AUTHORITATIVE and BUBBLES UP best-effort (Invariant D). One logical
 * mesh invoke therefore leaves TWO records of the proxy's execution:
 *
 *   • PROXY-LOCAL   — the authoritative record the proxy writes for the BARE-id call it
 *                     executed (tier:"proxy", carrying the shared correlationId).
 *   • PRIMARY-MIRROR— a redacted COPY the proxy bubbles up the tunnel; the primary
 *                     re-writes it through the SAME `JsonlAuditWriter` redactor (so the
 *                     mirror never reveals more than the proxy's local log — §7 Q7),
 *                     stamping tier:"proxy" + the originating workload.
 *
 * Plus the primary's own EDGE-SPAN (the forward, keyed by the mounted URN) shares the
 * SAME correlationId — threading the edge-span ↔ workload-span records together (§3.5).
 *
 * We prove:
 *   (a) CASCADE/MIRROR — one invoke yields proxy-local + primary-mirror, same redactor
 *       (a secret in the call input is masked IDENTICALLY in both), tier:"proxy", a
 *       shared correlationId that also matches the primary's edge-span record.
 *   (b) BEST-EFFORT    — a BROKEN bubble (a throwing subscriber on the proxy's write
 *       path) NEVER blocks/fails the invoke: the agent still gets ok and the proxy's
 *       authoritative local record is still written (Invariant D — never the hot path).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuditEvent,
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

/** Authoritative proxy-LOCAL audit events (captured off the proxy's single write path). */
const proxyAudits: AuditEvent[] = [];
/** Every audit event the PRIMARY records (edge-span forward + bubbled mirrors + the rest). */
const primaryAudits: AuditEvent[] = [];

async function req(path: string, init?: RequestInit): Promise<Response> {
  return primary.app.request("http://" + host + path, {
    ...init,
    headers: { host, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-t9-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  base = loadConfig();
  host = expectedHost(base);

  // DISTINCT mesh identities (T12) for the in-process primary + proxy.
  const primaryId = generateMeshIdentity();
  const proxyId = generateMeshIdentity();

  // PRIMARY — authority root + tunnel acceptor + audit aggregation sink.
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const tunnelPort = primary.state.mesh.tunnelPort;
  expect(tunnelPort).toBeGreaterThan(0);
  (primary.state.audit as JsonlAuditWriterLike).setOnAppend((e) => primaryAudits.push(e));

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

  // Capture the proxy's authoritative local audit events (the records bubbled up). This is
  // ADDITIVE to the internal bubble subscriber the proxy's mesh runtime registered — both fire.
  (proxy.state.audit as JsonlAuditWriterLike).setOnAppend((e) => proxyAudits.push(e));

  // The live handshake admits the proxy as a PINNED forward destination + lets the primary
  // attribute its bubbled audits to this workload.
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
      client: { name: "t9", agentId: "agent-t9" },
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

async function meshInvoke(input: Record<string, unknown>): Promise<InvokeResponse> {
  const hs = await handshake();
  const token = await grantAllow(hs.sessionId, mountedAddress);
  const res = await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ id: mountedAddress, input }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as InvokeResponse;
}

describe("T9 — audit cascade / mirror (integration)", () => {
  it("(a) one invoke ⇒ proxy-local + primary-mirror, same redactor, tier:proxy, shared correlationId", async () => {
    proxyAudits.length = 0;
    primaryAudits.length = 0;

    // A SECRET rides in the call input — the single redactor must mask it IDENTICALLY at
    // both tiers (the mirror can never reveal more than the proxy's local log — §7 Q7).
    const body = await meshInvoke({ text: "hello-mirror", token: "super-secret" });
    expect(body.ok).toBe(true);
    expect(String(body.output).trim()).toBe("hello-mirror");

    // The PROXY recorded the authoritative local invoke (BARE id, tier:proxy, correlationId).
    const local = proxyAudits.find((e) => e.type === "invoke" && e.capabilityId === BARE_ID);
    expect(local).toBeDefined();
    expect(local!.outcome).toBe("ok");
    expect(local!.tier).toBe("proxy");
    expect(typeof local!.correlationId).toBe("string");
    expect(local!.correlationId!.length).toBeGreaterThan(0);
    // The secret is masked in the proxy's authoritative log (the bubble carries this masked form).
    expect((local!.input as { token?: unknown }).token).toBe("[redacted]");
    expect((local!.input as { text?: unknown }).text).toBe("hello-mirror");

    // The bubble is best-effort/async — wait for the primary's MIRROR to land.
    await until(() => primaryAudits.some((e) => e.tier === "proxy" && e.capabilityId === BARE_ID));
    const mirror = primaryAudits.find((e) => e.tier === "proxy" && e.capabilityId === BARE_ID);
    expect(mirror).toBeDefined();

    // SAME correlationId across both records (threads the two together).
    expect(mirror!.correlationId).toBe(local!.correlationId);
    // SAME redactor ran on both tiers: the redacted input/output are IDENTICAL, and the
    // secret stays masked in the mirror (it was never un-redacted on the way up).
    expect(mirror!.input).toEqual(local!.input);
    expect(mirror!.output).toEqual(local!.output);
    expect((mirror!.input as { token?: unknown }).token).toBe("[redacted]");
    // The primary stamped the originating workload onto the mirror.
    expect((mirror!.detail as { workload?: unknown } | undefined)?.workload).toBe(WORKLOAD);
    // The mirror is a DISTINCT record from the proxy-local one (re-stamped id at the primary).
    expect(mirror!.id).not.toBe(local!.id);

    // The primary's EDGE-SPAN (the forward, keyed by the MOUNTED URN) shares the correlationId
    // — stitching the edge-span (agent↔primary) to the workload-span (primary↔proxy).
    const edge = primaryAudits.find(
      (e) => e.type === "invoke" && e.capabilityId === mountedAddress && e.tier !== "proxy",
    );
    expect(edge).toBeDefined();
    expect(edge!.correlationId).toBe(local!.correlationId);
  });

  it("(b) a BROKEN bubble never blocks the invoke (best-effort — Invariant D)", async () => {
    proxyAudits.length = 0;

    // FAULT INJECTION: register a throwing subscriber on the proxy's write path, simulating a
    // broken/failing bubble. The audit writer isolates subscribers, and the real bubble is a
    // fully-swallowed fire-and-forget — so neither can block, delay, or fail the invoke.
    const unsub = (proxy.state.audit as JsonlAuditWriterLike).setOnAppend(() => {
      throw new Error("bubble boom — simulated tunnel/subscriber failure");
    });
    try {
      const body = await meshInvoke({ text: "still-ok" });
      // The hot path is UNAFFECTED: the agent still gets the proxy's real result.
      expect(body.ok).toBe(true);
      expect(String(body.output).trim()).toBe("still-ok");

      // And the proxy's authoritative local record was STILL written (the throwing sibling
      // subscriber did not break the write or the capture).
      const local = proxyAudits.find((e) => e.type === "invoke" && e.capabilityId === BARE_ID);
      expect(local).toBeDefined();
      expect(local!.outcome).toBe("ok");
      expect(local!.tier).toBe("proxy");
    } finally {
      unsub();
    }
  });
});
