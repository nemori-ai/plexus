/**
 * A2 — Live catalog ascent (the cross-process mount seam). federated-mesh §3.2 (mount),
 * §5 Invariant B (address⟂route), Invariant F (the prefix is the primary's act, applied
 * exactly once on ascent); phase-2 plan card A2 + Risk 1.
 *
 * The walking skeleton (`mesh-e2e-walking-skeleton`) proves the HAPPY auto-mount end-to-end
 * (a real proxy pushes its catalog on auth → the primary mounts it with no in-process call).
 * THIS spec owns the adversarial + delta branches that need CONTROLLED catalog payloads — it
 * drives an authenticated raw socket by hand (via the real proxy handshake driver) so it can
 * push a forged-workload frame and a withdraw delta the auto-pushing runtime would never emit:
 *
 *   (1) SECURITY — a `catalog` frame whose payload claims ANOTHER workload mounts under the
 *       SOCKET-BOUND authenticated workload ONLY; the forged prefix is ignored (Invariant B —
 *       a proxy can never mount under a workload it did not authenticate as).
 *   (2) WITHDRAW DELTA — a follow-up push that WITHDRAWS a bare id un-mounts exactly that
 *       address (the only legitimate un-mount path; Risk 1 keeps transient drops mounted).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  EnrollFramePayload,
  Frame,
} from "@plexus/protocol";

import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, type GatewayConfig } from "@plexus/runtime/config.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity, type MeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import { buildEnrollRequest } from "@plexus/runtime/mesh/enrollment.ts";
import { createProxyHandshakeDriver } from "@plexus/runtime/mesh/handshake.ts";
import { buildCatalogPush } from "@plexus/runtime/mesh/catalog.ts";
import { mockEntries } from "@plexus/runtime/sources/index.ts";

const WORKLOAD = "laptop";
const VICTIM = "victim";
const TENANT = "local";
const BARE_ID = "mock.echo.run";

const echoEntry = (): CapabilityEntry => mockEntries().find((e) => e.id === BARE_ID)!;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

/** A raw WebSocket harness with a one-message-at-a-time read queue. */
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

describe("A2 — live catalog ascent (forged-workload + withdraw delta)", () => {
  let home: string;
  let primary: ReturnType<typeof createAppWithState>;
  let tunnelUrl: string;
  let primaryId: MeshIdentity;
  let proxyId: MeshIdentity;
  let raw: RawSocket;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "plexus-mesh-a2-"));
    process.env.PLEXUS_HOME = home;
    _resetSecretCacheForTests();
    const base = loadConfig(); // no-env ⇒ primary mode, tenant "local"

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

    // PIN the workload in the ledger (out-of-band enroll) so the challenge leg has a key.
    const enrollment = primary.state.mesh.enrollment!;
    const { token } = enrollment.mintJoinToken();
    const claim: EnrollFramePayload = {
      workload: WORKLOAD,
      mode: "proxy",
      proxyPubKey: proxyId.publicKeyPem,
      joinToken: token,
    };
    expect(enrollment.admit(buildEnrollRequest(claim, proxyId), primaryId).ok).toBe(true);

    // AUTHENTICATE a raw socket by hand using the REAL proxy handshake driver (challenge
    // leg — already enrolled). Once `done`, the socket carries `Frame`s into onPrimaryInbound.
    raw = new RawSocket(tunnelUrl);
    await raw.open();
    const driver = createProxyHandshakeDriver({
      workload: WORKLOAD,
      identity: proxyId,
      pinnedPrimaryPubKey: primaryId.publicKeyPem,
      upstreamUrl: tunnelUrl,
    });
    raw.send(driver.open()!); // auth-init
    const challenge = await raw.next();
    const afterChallenge = driver.next(challenge);
    raw.send(afterChallenge.send!); // auth-response
    const ok = driver.next(await raw.next());
    expect(ok.done).toBe(true);
    await until(() => primary.state.mesh.connected);
    expect(primary.state.mesh.connected).toBe(true);
  });

  afterAll(() => {
    raw?.close();
    primary?.state.mesh.stop();
    delete process.env.PLEXUS_HOME;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("(1) security — a FORGED-workload catalog mounts under the AUTHENTICATED prefix only", async () => {
    const authedAddress = `${TENANT}/${WORKLOAD}/${BARE_ID}`;
    const forgedAddress = `${TENANT}/${VICTIM}/${BARE_ID}`;

    // A frame that CLAIMS `payload.workload = "victim"` — but this socket authenticated as
    // "laptop". Build a well-formed (bare-id) push, then TAMPER the workload field.
    const honest = buildCatalogPush(WORKLOAD, [echoEntry()]);
    const forged: Frame = { ...honest, payload: { ...honest.payload, workload: VICTIM } };
    raw.send(JSON.stringify(forged));

    // The primary mounts under the SOCKET-BOUND workload, ignoring the forged claim.
    await until(() => primary.state.capabilities.get(authedAddress) !== undefined);
    expect(primary.state.capabilities.get(authedAddress)).toBeDefined();
    // The forged prefix is NEVER mounted — a proxy cannot mount under another workload (Inv B).
    expect(primary.state.capabilities.get(forgedAddress)).toBeUndefined();
    expect(primary.state.capabilities.forwardAddress(authedAddress)?.workload).toBe(WORKLOAD);
    // Hidden by default (§7 Q3 — join ≠ access).
    expect(primary.state.capabilities.exposureDefaultFor(authedAddress)).toBe("hidden");
  });

  it("(2) withdraw delta — a follow-up push that withdraws the bare id UN-mounts that address", async () => {
    const address = `${TENANT}/${WORKLOAD}/${BARE_ID}`;
    expect(primary.state.capabilities.get(address)).toBeDefined(); // mounted from (1)

    // A delta push: no new entries, the bare id WITHDRAWN. This is the ONLY legitimate
    // un-mount path (Risk 1 — a transient tunnel drop must NOT unmount; grants survive).
    const withdraw = buildCatalogPush(WORKLOAD, [], { withdrawn: [BARE_ID] });
    raw.send(JSON.stringify(withdraw));

    await until(() => primary.state.capabilities.get(address) === undefined);
    expect(primary.state.capabilities.get(address)).toBeUndefined();
    expect(primary.state.capabilities.forwardAddress(address)).toBeUndefined();
  });
});
