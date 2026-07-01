/**
 * T12 — Authenticated tunnel + wire enrollment handshake (SECURITY-CRITICAL).
 * federated-mesh §7 Q2 (Ed25519 mutual auth, pubkeys pinned at enrollment), Invariant E.
 *
 * These tests prove the hole the security review found is CLOSED: the tunnel-trust
 * ingress (which skips grant/scope/session) can no longer be reached by an
 * unauthenticated socket. The four proofs:
 *
 *   (a) A raw socket that connects and sends an `invoke` WITHOUT completing the Ed25519
 *       handshake is REJECTED (dropped) — no frame is ever honored, nothing executes.
 *   (b) A socket presenting a WRONG / unpinned key (auth-response signed by a key other
 *       than the ledger-pinned one) is rejected.
 *   (c) A MITM substituting the primary's key is rejected by the proxy (mandatory pin, M1).
 *   (d) The full happy path enroll → authenticated tunnel → invoke still works end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  EnrollFramePayload,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost, type GatewayConfig } from "@plexus/runtime/config.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { MeshTransport } from "@plexus/runtime/transports/mesh.ts";
import { mockSourceModule, mockEntries } from "@plexus/runtime/sources/index.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity, type MeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import { buildEnrollRequest } from "@plexus/runtime/mesh/enrollment.ts";
import {
  createProxyHandshakeDriver,
  authSignedBytes,
  AUTH_PRIMARY_DOMAIN,
  AUTH_PROXY_DOMAIN,
} from "@plexus/runtime/mesh/handshake.ts";

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

/** A minimal raw WebSocket harness: an attacker speaking the wire directly (no auth gate). */
class RawSocket {
  readonly ws: WebSocket;
  private readonly queue: string[] = [];
  private readonly waiters: Array<(m: string) => void> = [];
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (ev: MessageEvent) => {
      const m =
        typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
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

  next(timeoutMs = 1_000): Promise<string> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        res(m);
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ── (a)/(b) — raw socket attacks against the PRIMARY's authenticated tunnel ─────────

describe("T12 — primary tunnel rejects unauthenticated / wrong-key sockets", () => {
  let home: string;
  let primary: ReturnType<typeof createAppWithState>;
  let tunnelUrl: string;
  let proxyId: MeshIdentity;
  let primaryId: MeshIdentity;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "plexus-mesh-t12a-"));
    process.env.PLEXUS_HOME = home;
    _resetSecretCacheForTests();
    const base = loadConfig();

    primaryId = generateMeshIdentity();
    proxyId = generateMeshIdentity();

    primary = createAppWithState(base, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: primaryId },
    });
    await primary.state.mesh.start();
    const port = primary.state.mesh.tunnelPort;
    expect(port).toBeGreaterThan(0);
    tunnelUrl = `ws://127.0.0.1:${port}`;

    // PIN WORKLOAD in the ledger (out-of-band enroll) so there is a key to verify against.
    const enrollment = primary.state.mesh.enrollment!;
    const { token } = enrollment.mintJoinToken();
    const claim: EnrollFramePayload = {
      workload: WORKLOAD,
      mode: "proxy",
      proxyPubKey: proxyId.publicKeyPem,
      joinToken: token,
    };
    expect(enrollment.admit(buildEnrollRequest(claim, proxyId), primaryId).ok).toBe(true);
  });

  afterAll(() => {
    primary?.state.mesh.stop();
    delete process.env.PLEXUS_HOME;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("(a) a raw socket that sends an `invoke` WITHOUT the handshake is dropped — nothing executes", async () => {
    const raw = new RawSocket(tunnelUrl);
    await raw.open();

    // Speak the DATA-PLANE language directly, skipping the entire Ed25519 handshake.
    raw.send(
      JSON.stringify({
        t: "invoke",
        corr: "attack-1",
        payload: { address: `${TENANT}/${WORKLOAD}/${BARE_ID}`, id: BARE_ID, input: { text: "pwn" } },
      }),
    );

    // The primary's auth gate treats a non-handshake message as a fail-closed event and
    // drops the socket. No `invoke-result` is ever returned, and the tunnel never becomes
    // an authenticated/active connection.
    await until(() => raw.closed);
    expect(raw.closed).toBe(true);
    expect(primary.state.mesh.connected).toBe(false);
    raw.close();
  });

  it("(b) a socket presenting a WRONG / unpinned key is rejected at the challenge", async () => {
    const raw = new RawSocket(tunnelUrl);
    await raw.open();

    // Begin a legitimate-looking challenge for the enrolled workload…
    const cnonce = "client-nonce-b";
    raw.send(JSON.stringify({ h: "auth-init", workload: WORKLOAD, cnonce }));

    const challengeRaw = await raw.next();
    const challenge = JSON.parse(challengeRaw) as { h: string; snonce: string };
    expect(challenge.h).toBe("auth-challenge");

    // …but sign the response with an ATTACKER key, not the ledger-pinned proxy key.
    const attacker = generateMeshIdentity();
    const sig = attacker
      .sign(authSignedBytes(AUTH_PROXY_DOMAIN, WORKLOAD, cnonce, challenge.snonce))
      .toString("base64");
    raw.send(JSON.stringify({ h: "auth-response", sig }));

    const reply = JSON.parse(await raw.next()) as { h: string; reason?: string };
    expect(reply.h).toBe("auth-fail");
    expect(reply.reason).toBe("bad_signature");
    expect(primary.state.mesh.connected).toBe(false);
    raw.close();
  });

  it("(b') an auth-init for an UNENROLLED workload (no pin) is rejected", async () => {
    const raw = new RawSocket(tunnelUrl);
    await raw.open();

    const cnonce = "client-nonce-ghost";
    raw.send(JSON.stringify({ h: "auth-init", workload: "ghost", cnonce }));
    const challenge = JSON.parse(await raw.next()) as { snonce: string };

    // Even a correctly-formed response cannot authenticate a workload that was never
    // enrolled — there is no pinned key to verify against.
    const sig = generateMeshIdentity()
      .sign(authSignedBytes(AUTH_PROXY_DOMAIN, "ghost", cnonce, challenge.snonce))
      .toString("base64");
    raw.send(JSON.stringify({ h: "auth-response", sig }));

    const reply = JSON.parse(await raw.next()) as { h: string; reason?: string };
    expect(reply.h).toBe("auth-fail");
    expect(reply.reason).toBe("not_enrolled");
    raw.close();
  });
});

// ── (c) — the PROXY rejects a substituted primary key (MITM), pin is mandatory ──────

describe("T12 — proxy rejects a MITM primary key (mandatory pin, M1)", () => {
  it("the proxy handshake driver refuses to construct WITHOUT a pinned primary key (M1)", () => {
    expect(() =>
      createProxyHandshakeDriver({
        workload: "w",
        identity: generateMeshIdentity(),
        pinnedPrimaryPubKey: "", // ← no pin ⇒ no bare-TOFU; must throw
        upstreamUrl: "ws://primary.local",
      }),
    ).toThrow(/primaryPubKey/);
  });

  it("the proxy aborts when the challenge is signed by a key other than the pinned primary", () => {
    const realPrimary = generateMeshIdentity();
    const attacker = generateMeshIdentity();

    const driver = createProxyHandshakeDriver({
      workload: "w",
      identity: generateMeshIdentity(),
      pinnedPrimaryPubKey: realPrimary.publicKeyPem, // pinned to the REAL primary
      upstreamUrl: "ws://primary.local",
    });
    const init = JSON.parse(driver.open()!) as { h: string; cnonce: string };
    expect(init.h).toBe("auth-init");

    const snonce = "server-nonce-c";

    // A MITM signs the challenge with ITS OWN key → the proxy's mandatory pin check fails.
    const mitmSig = attacker
      .sign(authSignedBytes(AUTH_PRIMARY_DOMAIN, "w", init.cnonce, snonce))
      .toString("base64");
    const bad = driver.next(JSON.stringify({ h: "auth-challenge", snonce, sig: mitmSig }));
    expect(bad.fail).toBeDefined();
    expect(bad.done).toBeUndefined();
  });

  it("the proxy proceeds when the challenge is signed by the genuine pinned primary (control)", () => {
    const realPrimary = generateMeshIdentity();
    const driver = createProxyHandshakeDriver({
      workload: "w",
      identity: generateMeshIdentity(),
      pinnedPrimaryPubKey: realPrimary.publicKeyPem,
      upstreamUrl: "ws://primary.local",
    });
    const init = JSON.parse(driver.open()!) as { cnonce: string };
    const snonce = "server-nonce-ok";
    const goodSig = realPrimary
      .sign(authSignedBytes(AUTH_PRIMARY_DOMAIN, "w", init.cnonce, snonce))
      .toString("base64");
    const step = driver.next(JSON.stringify({ h: "auth-challenge", snonce, sig: goodSig }));
    // Genuine primary ⇒ the proxy answers with its auth-response (no fail).
    expect(step.fail).toBeUndefined();
    expect(step.send).toBeDefined();
    expect((JSON.parse(step.send!) as { h: string }).h).toBe("auth-response");
  });
});

// ── (L-1) — a LOST enroll-result must not brick a legitimately-enrolled proxy ───────

describe("T12 — L-1: a consumed join token (lost enroll-result) does not brick the proxy", () => {
  it("an ENROLLED proxy re-presenting a consumed token AUTHENTICATES via the challenge leg", () => {
    const realPrimary = generateMeshIdentity();
    const proxyId = generateMeshIdentity();

    let enrolledCalls = 0;
    const driver = createProxyHandshakeDriver({
      workload: WORKLOAD,
      identity: proxyId,
      pinnedPrimaryPubKey: realPrimary.publicKeyPem,
      upstreamUrl: "ws://primary.local",
      joinToken: "already-consumed-token", // a token a prior (lost-reply) join consumed
      onEnrolled: () => {
        enrolledCalls += 1;
      },
    });

    // open() emits the enroll request (the proxy still thinks it must join).
    const enroll = JSON.parse(driver.open()!) as { h: string };
    expect(enroll.h).toBe("enroll");

    // The primary already consumed this token on the earlier (lost) accept → it now
    // replies token_consumed. The proxy must NOT fail; it falls through to the challenge.
    const afterReject = driver.next(
      JSON.stringify({ h: "enroll-result", outcome: { ok: false, reason: "token_consumed" } }),
    );
    expect(afterReject.fail).toBeUndefined();
    expect(afterReject.send).toBeDefined();
    const init = JSON.parse(afterReject.send!) as { h: string; workload: string; cnonce: string };
    expect(init.h).toBe("auth-init");
    expect(init.workload).toBe(WORKLOAD);
    expect(enrolledCalls).toBe(1); // the runtime is told it is (still) enrolled

    // The genuine pinned primary challenges; the proxy answers (authenticated, not bricked).
    const snonce = "server-nonce-l1";
    const goodSig = realPrimary
      .sign(authSignedBytes(AUTH_PRIMARY_DOMAIN, WORKLOAD, init.cnonce, snonce))
      .toString("base64");
    const challenged = driver.next(JSON.stringify({ h: "auth-challenge", snonce, sig: goodSig }));
    expect(challenged.fail).toBeUndefined();
    expect(challenged.send).toBeDefined();
    const resp = JSON.parse(challenged.send!) as { h: string };
    expect(resp.h).toBe("auth-response");

    const done = driver.next(JSON.stringify({ h: "auth-ok" }));
    expect(done.done).toBe(true);
  });

  it("an IMPOSTER presenting a consumed token (never enrolled, no pin) still fails not_enrolled", async () => {
    const home = mkdtempSync(join(tmpdir(), "plexus-mesh-t12l1-"));
    process.env.PLEXUS_HOME = home;
    _resetSecretCacheForTests();
    const base = loadConfig();

    const primaryId = generateMeshIdentity();
    const primary = createAppWithState(base, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: primaryId },
    });
    try {
      await primary.state.mesh.start();
      const port = primary.state.mesh.tunnelPort;
      const tunnelUrl = `ws://127.0.0.1:${port}`;

      // The primary mints + consumes a token by admitting a LEGITIMATE proxy for WORKLOAD.
      const enrollment = primary.state.mesh.enrollment!;
      const { token } = enrollment.mintJoinToken();
      const realProxy = generateMeshIdentity();
      const claim: EnrollFramePayload = {
        workload: WORKLOAD,
        mode: "proxy",
        proxyPubKey: realProxy.publicKeyPem,
        joinToken: token,
      };
      expect(enrollment.admit(buildEnrollRequest(claim, realProxy), primaryId).ok).toBe(true);

      // An IMPOSTER for a DIFFERENT, never-enrolled workload re-presents the now-consumed
      // token. The primary replies token_consumed; the imposter's driver falls through to
      // the challenge — but the primary has NO pin for "imposter" ⇒ auth-fail not_enrolled.
      const imposter = generateMeshIdentity();
      const driver = createProxyHandshakeDriver({
        workload: "imposter",
        identity: imposter,
        pinnedPrimaryPubKey: primaryId.publicKeyPem,
        upstreamUrl: tunnelUrl,
        joinToken: token, // the consumed token
      });

      const raw = new RawSocket(tunnelUrl);
      await raw.open();

      // Drive the proxy handshake by hand over the raw socket.
      raw.send(driver.open()!); // enroll
      const enrollResult = await raw.next();
      const afterEnroll = driver.next(enrollResult);
      // token_consumed ⇒ fall through to the challenge leg (NOT a fail).
      expect(afterEnroll.fail).toBeUndefined();
      expect(afterEnroll.send).toBeDefined();
      raw.send(afterEnroll.send!); // auth-init

      const challenge = await raw.next();
      const afterChallenge = driver.next(challenge);
      expect(afterChallenge.fail).toBeUndefined();
      raw.send(afterChallenge.send!); // auth-response (signed by imposter key)

      // The primary has no pinned key for "imposter" → fail-closed.
      const reply = JSON.parse(await raw.next()) as { h: string; reason?: string };
      expect(reply.h).toBe("auth-fail");
      expect(reply.reason).toBe("not_enrolled");
      expect(primary.state.mesh.connected).toBe(false);
      raw.close();
    } finally {
      primary?.state.mesh.stop();
      delete process.env.PLEXUS_HOME;
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

// ── (d) — the full happy path still works end-to-end over the authenticated tunnel ──

describe("T12 — full happy path: enroll → authenticated tunnel → invoke", () => {
  let home: string;
  let primary: ReturnType<typeof createAppWithState>;
  let proxy: ReturnType<typeof createAppWithState>;
  let mountedAddress: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "plexus-mesh-t12d-"));
    process.env.PLEXUS_HOME = home;
    _resetSecretCacheForTests();
    const base = loadConfig();

    const primaryId = generateMeshIdentity();
    const proxyId = generateMeshIdentity();

    primary = createAppWithState(base, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: primaryId },
    });
    await primary.state.mesh.start();
    const port = primary.state.mesh.tunnelPort;

    // Tunnel is NOT connected until a proxy authenticates.
    expect(primary.state.mesh.connected).toBe(false);

    const enrollment = primary.state.mesh.enrollment!;
    const { token } = enrollment.mintJoinToken();

    const proxySources = testRegistry([mockSourceModule]);
    const proxyCaps = createCapabilityRegistry(proxySources);
    const proxyConfig: GatewayConfig = {
      ...base,
      mode: "proxy",
      upstream: { url: `ws://127.0.0.1:${port}`, primaryPubKey: primaryId.publicKeyPem },
      workload: WORKLOAD,
    };
    proxy = createAppWithState(proxyConfig, {
      sources: proxySources,
      capabilities: proxyCaps,
      mesh: { identity: proxyId, joinToken: token },
    });
    await proxy.state.capabilities.start();
    await proxy.state.mesh.start();

    // The proxy auto-enrolls (live admit) + mutually authenticates the tunnel.
    await until(() => primary.state.mesh.connected && enrollment.isActive(WORKLOAD));
    expect(primary.state.mesh.connected).toBe(true);
    expect(enrollment.isActive(WORKLOAD)).toBe(true);
    expect(primary.state.mesh.enrollment!.get(WORKLOAD)!.pinnedProxyPubKey).toBe(proxyId.publicKeyPem);

    const mount = primary.state.capabilities.mountRemoteWorkload(WORKLOAD, [echoEntry()], { tenant: TENANT });
    mountedAddress = mount.mounted[0]!;
    primary.state.exposure.setEnabled(mountedAddress, true);
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

  it("(d) an invoke forwards over the authenticated tunnel and returns the proxy's result", async () => {
    const entry = primary.state.capabilities.get(mountedAddress)!;
    const meshTransport = primary.state.sources.getTransport("mesh") as MeshTransport;

    const result = await meshTransport.dispatch(entry, { text: "authenticated" });
    expect(result.ok).toBe(true);
    expect(String(result.data).trim()).toBe("authenticated");

    // The bare id (never the prefix) reached the proxy over the authenticated tunnel.
    expect(proxy.state.mesh.lastForwardedInvoke?.id).toBe(BARE_ID);
  });
});
