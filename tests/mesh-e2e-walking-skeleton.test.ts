/**
 * T11 — E2E walking-skeleton (federated-mesh, FULL SPINE in one narrative flow).
 *
 * This is the consolidating end-to-end proof that closes phase 1. ONE in-process
 * PRIMARY + ONE PROXY — DISTINCT Ed25519 identities under a SINGLE PLEXUS_HOME — joined
 * by the real T4 tunnel, walked through the ENTIRE spine in a single ordered flow, with an
 * assertion at every hop:
 *
 *   1. ENROLL + AUTHENTICATE — the primary mints a one-time join token; the proxy dials,
 *      completes the Ed25519 mutual handshake; the proxy is admitted + PINNED and the
 *      one-time token is CONSUMED (replay-dead).
 *   2. MOUNT — the proxy's BARE catalog is mounted under `tenant/workload/`; the prefixed
 *      address exists in the directory but is HIDDEN pre-exposure (zero-exposure, §7 Q3).
 *   3. EXPOSE — the owner enables the mounted address; it now appears in `.well-known`.
 *   4. AGENT INVOKE — an AGENT handshakes the PRIMARY's agent surface, is granted the
 *      mounted address, and `POST /invoke`s it → the PROXY's result comes back; the proxy
 *      executed the BARE id (the prefix never crossed the wire — Q4 / Invariant B).
 *   5. AUDIT CASCADE — that one invoke leaves TWO records: proxy-local (authoritative) +
 *      primary mirror (same redactor, tier:"proxy", shared correlationId that also threads
 *      the primary's edge-span — Invariant D / §7 Q7).
 *   6. DOWNTIME — kill the proxy socket → the same invoke returns typed
 *      `capability_unavailable` + `unavailableSince` (HTTP 503, NO hang); reconnect → resumes.
 *   7. SECURITY — a raw/unauthenticated socket that connects and sends an `invoke` WITHOUT
 *      the Ed25519 handshake is dropped with NO execution; the boundary holds end-to-end.
 *
 * The narrow per-task specs (T5/T6/T7/T8/T9/T10/T12) own the exhaustive branch coverage;
 * THIS spec proves the spine composes — every seam joined, in order, once.
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
  WellKnownDocument,
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

const echoEntry = (): CapabilityEntry => mockEntries().find((e) => e.id === BARE_ID)!;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

/** A minimal raw WebSocket: an attacker speaking the wire directly, past no auth gate. */
class RawSocket {
  readonly ws: WebSocket;
  closed = false;
  private gotMessage = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", () => {
      this.gotMessage = true;
    });
    this.ws.addEventListener("close", () => {
      this.closed = true;
    });
  }
  open(timeoutMs = 1_000): Promise<void> {
    return new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("ws open timeout")), timeoutMs);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        res();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(t);
        rej(new Error("ws error"));
      });
    });
  }
  send(s: string): void {
    this.ws.send(s);
  }
  get sawInvokeResult(): boolean {
    return this.gotMessage;
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ── In-process primary + proxy, distinct identities, ONE PLEXUS_HOME ─────────────

let home: string;
let base: GatewayConfig;
let host: string;
let tunnelUrl: string;
let primary: ReturnType<typeof createAppWithState>;
let proxy: ReturnType<typeof createAppWithState>;
let consumedTokenHash: string;
let mountedAddress: string;

/** Authoritative proxy-LOCAL audit events (off the proxy's single write path). */
const proxyAudits: AuditEvent[] = [];
/** Every audit event the PRIMARY records (edge-span + bubbled proxy mirrors). */
const primaryAudits: AuditEvent[] = [];

async function req(path: string, init?: RequestInit): Promise<Response> {
  return primary.app.request("http://" + host + path, {
    ...init,
    headers: { host, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function wellKnownIds(): Promise<string[]> {
  const res = await req("/.well-known/plexus");
  const doc = (await res.json()) as WellKnownDocument;
  return doc.capabilities.map((c) => c.id);
}

async function handshake(): Promise<HandshakeResponse> {
  const res = await req("/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: primary.state.connectionKey.current(),
      client: { name: "t11", agentId: "agent-t11" },
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

/** A full agent invoke of the mounted address (re-handshakes each call — cheap + isolated). */
async function invokeMounted(input: Record<string, unknown>): Promise<{ status: number; body: InvokeResponse }> {
  const hs = await handshake();
  const token = await grantAllow(hs.sessionId, mountedAddress);
  const res = await req("/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token.token}` },
    body: JSON.stringify({ id: mountedAddress, input }),
  });
  return { status: res.status, body: (await res.json()) as InvokeResponse };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "plexus-mesh-t11-"));
  process.env.PLEXUS_HOME = home;
  _resetSecretCacheForTests();
  base = loadConfig(); // no-env ⇒ primary mode
  host = expectedHost(base);

  // DISTINCT Ed25519 identities (T12) — the in-process primary + proxy hold different keys
  // even though they share ONE PLEXUS_HOME.
  const primaryId = generateMeshIdentity();
  const proxyId = generateMeshIdentity();

  // PRIMARY — authority root + tunnel acceptor + audit aggregation sink. AutoApprove so the
  // grant for the mounted address yields a token deterministically (grant UX is not under test).
  primary = createAppWithState(base, {
    authorizer: new AutoApproveAuthorizer(),
    mesh: { identity: primaryId },
  });
  await primary.state.mesh.start();
  const tunnelPort = primary.state.mesh.tunnelPort;
  expect(tunnelPort).toBeGreaterThan(0);
  tunnelUrl = `ws://127.0.0.1:${tunnelPort}`;
  (primary.state.audit as JsonlAuditWriterLike).setOnAppend((e) => primaryAudits.push(e));

  // The tunnel is NOT "connected" until a proxy AUTHENTICATES (not merely opens a socket).
  expect(primary.state.mesh.connected).toBe(false);

  // STEP 1 setup — mint the one-time join token; remember its hash to prove consumption.
  const enrollment = primary.state.mesh.enrollment!;
  const minted = enrollment.mintJoinToken();
  consumedTokenHash = minted.tokenHash;
  expect(enrollment.hasPendingToken(consumedTokenHash)).toBe(true);
  expect(enrollment.pendingTokenCount).toBe(1);

  // PROXY — dials the primary, owns the executable `mock` source. Carries the pinned primary
  // pubkey (M1) + join token, and AUTHENTICATES the tunnel (enroll → Ed25519 mutual challenge)
  // automatically on connect.
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
  await proxy.state.capabilities.start(); // scan mock ⇒ mock.echo.run invocable
  await proxy.state.mesh.start(); // dial + enroll + mutually authenticate

  // Capture the proxy's authoritative local audit events (ADDITIVE to the internal bubble
  // subscriber — both fire). This is what STEP 5 inspects.
  (proxy.state.audit as JsonlAuditWriterLike).setOnAppend((e) => proxyAudits.push(e));

  // Stash the proxy's pubkey for the STEP-1 pin assertion.
  (globalThis as Record<string, unknown>).__t11ProxyPub = proxyId.publicKeyPem;
});

afterAll(() => {
  primary?.state.mesh.stop();
  proxy?.state.mesh.stop();
  delete process.env.PLEXUS_HOME;
  delete (globalThis as Record<string, unknown>).__t11ProxyPub;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// The seven steps run IN ORDER — each `it` advances the shared primary+proxy through one hop.
describe("T11 — federated-mesh walking skeleton (full spine, one flow)", () => {
  it("STEP 1 — enroll + authenticate: proxy admitted + PINNED, the one-time token is consumed", async () => {
    const enrollment = primary.state.mesh.enrollment!;

    // The live mutual handshake admits the proxy as a PINNED forward destination, and the
    // dialed tunnel attaches as an AUTHENTICATED connection.
    await until(() => primary.state.mesh.connected && enrollment.isActive(WORKLOAD));
    expect(primary.state.mesh.connected).toBe(true);
    expect(enrollment.isActive(WORKLOAD)).toBe(true);

    // PINNED: the ledger record pins exactly the proxy's Ed25519 pubkey.
    const expectedPub = (globalThis as Record<string, unknown>).__t11ProxyPub as string;
    expect(enrollment.get(WORKLOAD)!.pinnedProxyPubKey).toBe(expectedPub);
    expect(enrollment.get(WORKLOAD)!.status).toBe("active");

    // CONSUMED: the one-time join token is gone (replay-dead) — a crash+reload cannot resurrect it.
    expect(enrollment.hasPendingToken(consumedTokenHash)).toBe(false);
    expect(enrollment.pendingTokenCount).toBe(0);
  });

  it("STEP 2 — mount: bare catalog mounts under tenant/workload/, prefixed address HIDDEN pre-exposure", async () => {
    const revBefore = primary.state.capabilities.revision();
    const mount = primary.state.capabilities.mountRemoteWorkload(WORKLOAD, [echoEntry()], { tenant: TENANT });
    mountedAddress = mount.mounted[0]!;

    // ADDRESS ⟂ ROUTE (Invariant B): the directory key is the prefixed URN, not the bare id.
    expect(mountedAddress).toBe(`${TENANT}/${WORKLOAD}/${BARE_ID}`);
    expect(primary.state.capabilities.revision()).toBeGreaterThan(revBefore);

    // The mounted entry EXISTS in the directory (transport: mesh, source: mesh:<workload>)…
    const entry = primary.state.capabilities.get(mountedAddress)!;
    expect(entry).toBeDefined();
    expect(entry.transport).toBe("mesh");
    expect(entry.source).toBe(`mesh:${WORKLOAD}`);
    // …and the BARE id is NEVER a key on the mounted surface.
    expect(primary.state.capabilities.get(BARE_ID)).toBeUndefined();

    // ZERO-EXPOSURE (§7 Q3): mounted ⇒ hidden by default; INVISIBLE in `.well-known` pre-enable.
    expect(primary.state.capabilities.exposureDefaultFor(mountedAddress)).toBe("hidden");
    expect(primary.state.exposure.isEnabled(mountedAddress)).toBe(false);
    expect(await wellKnownIds()).not.toContain(mountedAddress);
  });

  it("STEP 3 — expose: owner enables the mounted cap ⇒ it appears in `.well-known`", async () => {
    expect(await wellKnownIds()).not.toContain(mountedAddress); // still hidden

    primary.state.exposure.setEnabled(mountedAddress, true); // OWNER consent

    expect(primary.state.exposure.isEnabled(mountedAddress)).toBe(true);
    expect(await wellKnownIds()).toContain(mountedAddress); // now discoverable
  });

  it("STEP 4 + 5 — agent invoke returns the PROXY's result (bare id on the wire) + audit cascades", async () => {
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok");
    proxyAudits.length = 0;
    primaryAudits.length = 0;

    // STEP 4 — an AGENT handshakes the PRIMARY's agent surface, is granted the mounted
    // address, and invokes it. A SECRET rides in the input to exercise the redactor at BOTH
    // tiers (STEP 5). The agent talks ONLY to the primary.
    const { status, body } = await invokeMounted({ text: "hello-spine", token: "super-secret" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The reply is keyed by the MOUNTED address (its URN); the value is the proxy's real echo.
    expect(body.id).toBe(mountedAddress);
    expect(String(body.output).trim()).toBe("hello-spine");

    // BARE ON WIRE (Q4 / Invariant B): the proxy executed the bare `source.capability` id —
    // the location prefix translated off exactly once at the forward boundary.
    const forwarded = proxy.state.mesh.lastForwardedInvoke;
    expect(forwarded).toBeDefined();
    expect(forwarded!.id).toBe(BARE_ID);
    expect(forwarded!.id.includes("/")).toBe(false);
    expect(forwarded!.address).toBe(mountedAddress); // the URN rides along, never executed

    // STEP 5 — AUDIT CASCADE. The PROXY recorded the authoritative local invoke (bare id,
    // tier:proxy, correlationId), with the secret masked by the single redactor.
    const local = proxyAudits.find((e) => e.type === "invoke" && e.capabilityId === BARE_ID);
    expect(local).toBeDefined();
    expect(local!.outcome).toBe("ok");
    expect(local!.tier).toBe("proxy");
    expect(typeof local!.correlationId).toBe("string");
    expect(local!.correlationId!.length).toBeGreaterThan(0);
    expect((local!.input as { token?: unknown }).token).toBe("[redacted]");
    expect((local!.input as { text?: unknown }).text).toBe("hello-spine");

    // The bubble is best-effort/async — wait for the primary's MIRROR to land.
    await until(() => primaryAudits.some((e) => e.tier === "proxy" && e.capabilityId === BARE_ID));
    const mirror = primaryAudits.find((e) => e.tier === "proxy" && e.capabilityId === BARE_ID);
    expect(mirror).toBeDefined();

    // SAME correlationId (threads the two records) + SAME redactor (identical redacted I/O;
    // the secret stays masked — the mirror can never reveal more than the proxy's local log).
    expect(mirror!.correlationId).toBe(local!.correlationId);
    expect(mirror!.input).toEqual(local!.input);
    expect(mirror!.output).toEqual(local!.output);
    expect((mirror!.input as { token?: unknown }).token).toBe("[redacted]");
    expect((mirror!.detail as { workload?: unknown } | undefined)?.workload).toBe(WORKLOAD);
    expect(mirror!.id).not.toBe(local!.id); // a DISTINCT record (re-stamped at the primary)

    // The primary's EDGE-SPAN (the forward, keyed by the mounted URN) shares the correlationId,
    // stitching the edge-span (agent↔primary) to the workload-span (primary↔proxy).
    const edge = primaryAudits.find(
      (e) => e.type === "invoke" && e.capabilityId === mountedAddress && e.tier !== "proxy",
    );
    expect(edge).toBeDefined();
    expect(edge!.correlationId).toBe(local!.correlationId);
  });

  it("STEP 6 — downtime: kill the proxy ⇒ typed capability_unavailable (503, no hang); reconnect ⇒ resumes", async () => {
    const before = Date.now();
    proxy.state.mesh.stop(); // drop the proxy's socket (no auto-reconnect)

    // The primary observes the close and stamps the down-time (resolution changes, not address).
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "unavailable");
    const h = primary.state.mesh.resolution.healthOf(WORKLOAD);
    expect(h.status).toBe("unavailable");
    expect(h.unavailableSince).toBeDefined();
    const sinceMs = Date.parse(h.unavailableSince!);
    expect(Number.isNaN(sinceMs)).toBe(false);
    expect(sinceMs).toBeGreaterThanOrEqual(before - 1_000);

    // The invoke for the down cap returns FAST with a typed denial — racing a deadline far
    // below the tunnel's 10s request timeout proves the gate short-circuits (never a hang).
    const started = Date.now();
    const raced = await Promise.race([
      invokeMounted({ text: "hello-down" }),
      sleep(3_000).then(() => "TIMED_OUT" as const),
    ]);
    expect(raced).not.toBe("TIMED_OUT");
    const { status, body } = raced as { status: number; body: InvokeResponse };
    expect(Date.now() - started).toBeLessThan(3_000);

    // 503 Service Unavailable — typed, recoverable, in InvokeResponse shape (not 400/500/hang).
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("capability_unavailable");
    expect(body.error?.capabilityId).toBe(mountedAddress);
    expect(body.error?.unavailableSince).toBeDefined();
    expect(Number.isNaN(Date.parse(body.error!.unavailableSince!))).toBe(false);

    // RECONNECT — the proxy is already enrolled, so this runs the challenge-only re-auth leg;
    // resolution recovers and invokes resume end-to-end.
    await proxy.state.mesh.start();
    await until(() => primary.state.mesh.connected, 4_000);
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "ok", 4_000);
    expect(primary.state.mesh.resolution.healthOf(WORKLOAD).status).toBe("ok");

    const again = await invokeMounted({ text: "hello-again" });
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
    expect(String(again.body.output).trim()).toBe("hello-again");
  });

  it("STEP 7 — security: a raw socket that `invoke`s WITHOUT the handshake is rejected, NO execution", async () => {
    // The legit proxy is connected; the attacker opens its OWN socket and speaks the
    // data-plane language directly, skipping the entire Ed25519 handshake.
    const forwardedBefore = proxy.state.mesh.lastForwardedInvoke; // reference identity sentinel
    const raw = new RawSocket(tunnelUrl);
    await raw.open();
    raw.send(
      JSON.stringify({
        t: "invoke",
        corr: "attack-no-handshake",
        payload: {
          address: mountedAddress,
          id: BARE_ID,
          input: { text: "pwn-no-handshake" },
        },
      }),
    );

    // The primary's auth gate treats a non-handshake frame as fail-closed and DROPS the socket.
    await until(() => raw.closed);
    expect(raw.closed).toBe(true);
    expect(raw.sawInvokeResult).toBe(false); // the attacker is never answered

    // NO EXECUTION: the proxy's last-forwarded invoke is UNCHANGED (same object reference) —
    // the attacker's bare-id call never reached the proxy pipeline. The boundary held.
    expect(proxy.state.mesh.lastForwardedInvoke).toBe(forwardedBefore);

    // The legit, authenticated tunnel is UNAFFECTED — a real agent invoke still works.
    expect(primary.state.mesh.connected).toBe(true);
    const ok = await invokeMounted({ text: "still-secure" });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(String(ok.body.output).trim()).toBe("still-secure");

    raw.close();
  });
});
