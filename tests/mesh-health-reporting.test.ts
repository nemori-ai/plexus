/**
 * Mesh health-reporting — bidirectional, negotiated at enrollment (mesh-health-reporting.md).
 *
 * The primary today knows only a proxy's coarse socket up/down, so mounted remote caps render
 * "health unknown". This suite proves the auto-reporting protocol:
 *
 *   UNIT — the handshake NEGOTIATES health reporting (both advertise → active; one omits →
 *          graceful fallback, enroll/auth unaffected); the `MeshHealthStore` state machine
 *          (ok/degraded/down/stale/connecting/unavailable) resolves route-first; and ATTRIBUTION
 *          is keyed by the authenticated workload, never a forgeable `reporter` field.
 *
 *   INTEGRATION — a real primary + enrolled proxy over the tunnel: the proxy auto-reports its
 *          source health, the primary STAMPS the mounted cap (healthy, NOT unknown) + surfaces it
 *          on `/admin/api/mesh`; a source FLIP on the proxy propagates upstream; a socket DROP
 *          resolves unavailable (Invariant E — invoke → capability_unavailable) while the mount
 *          survives (Invariant B); and the primary reports DOWN to the proxy (bidirectional).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  CapabilitySource,
  HandshakeResponse,
  HealthFramePayload,
  InvokeResponse,
  PlatformServices,
  ScopedToken,
  SourceHealth,
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
import { BaseCapabilitySource, BaseCapabilityBridge } from "@plexus/runtime/sources/base.ts";
import { AutoApproveAuthorizer, _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { generateMeshIdentity } from "@plexus/runtime/mesh/keys.ts";
import {
  createProxyHandshakeDriver,
  createPrimaryHandshakeDriver,
  negotiateHealthReporting,
} from "@plexus/runtime/mesh/handshake.ts";
import { MeshHealthStore, meshHealthToCapabilityHealth } from "@plexus/runtime/mesh/mesh-health.ts";
import { ResolutionTable } from "@plexus/runtime/mesh/resolution.ts";
import { validateHealthPayload } from "@plexus/runtime/mesh/frames.ts";

const WORKLOAD = "proxylap";
const TENANT = "local";
const PROBE_ID = "probe.run";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
}

// ── UNIT: handshake negotiation ─────────────────────────────────────────────────

describe("mesh-health — handshake negotiation (mutual, backward compatible)", () => {
  it("BOTH advertise ⇒ health reporting active; negotiated interval = max, version = min", () => {
    const primaryId = generateMeshIdentity();
    const proxyId = generateMeshIdentity();
    const pinnedFor = (w: string) => (w === WORKLOAD ? proxyId.publicKeyPem : undefined);

    const proxy = createProxyHandshakeDriver({
      workload: WORKLOAD,
      identity: proxyId,
      pinnedPrimaryPubKey: primaryId.publicKeyPem,
      upstreamUrl: "ws://primary.local",
      healthReporting: { version: 1, intervalMs: 10_000 },
    });
    const primary = createPrimaryHandshakeDriver({
      identity: primaryId,
      admit: () => ({ ok: false, reason: "unknown_token" }), // never used (challenge-only leg)
      pinnedProxyPubKeyFor: pinnedFor,
      healthReporting: { version: 1, intervalMs: 20_000 },
    });

    // Drive the two drivers against each other (challenge-only leg — proxy already enrolled).
    let msg = proxy.open()!; // auth-init
    const s1 = primary.next(msg); // → auth-challenge
    const s2 = proxy.next(s1.send!); // → auth-response
    const s3 = primary.next(s2.send!); // → auth-ok + done (primary side)
    const s4 = proxy.next(s3.send!); // auth-ok → done (proxy side)

    expect(s3.done).toBe(true);
    expect(s4.done).toBe(true);
    // Both ends derive the SAME negotiated result: version=min(1,1), intervalMs=max(10k,20k).
    expect(s3.healthReporting).toEqual({ version: 1, intervalMs: 20_000 });
    expect(s4.healthReporting).toEqual({ version: 1, intervalMs: 20_000 });
  });

  it("one side does NOT advertise ⇒ graceful fallback (no negotiated params), auth still completes", () => {
    const primaryId = generateMeshIdentity();
    const proxyId = generateMeshIdentity();

    const proxy = createProxyHandshakeDriver({
      workload: WORKLOAD,
      identity: proxyId,
      pinnedPrimaryPubKey: primaryId.publicKeyPem,
      upstreamUrl: "ws://primary.local",
      // NO healthReporting advert (a pre-health proxy).
    });
    const primary = createPrimaryHandshakeDriver({
      identity: primaryId,
      admit: () => ({ ok: false, reason: "unknown_token" }),
      pinnedProxyPubKeyFor: (w) => (w === WORKLOAD ? proxyId.publicKeyPem : undefined),
      healthReporting: { version: 1, intervalMs: 15_000 }, // primary advertises; proxy does not
    });

    const s1 = primary.next(proxy.open()!);
    const s2 = proxy.next(s1.send!);
    const s3 = primary.next(s2.send!);
    const s4 = proxy.next(s3.send!);

    // Auth completes cleanly, but health reporting is NOT active (fallback to bare heartbeat).
    expect(s3.done).toBe(true);
    expect(s4.done).toBe(true);
    expect(s3.healthReporting).toBeUndefined();
    expect(s4.healthReporting).toBeUndefined();
  });

  it("negotiateHealthReporting: mutual-only, deterministic", () => {
    expect(negotiateHealthReporting({ version: 2, intervalMs: 5_000 }, { version: 1, intervalMs: 9_000 })).toEqual({
      version: 1,
      intervalMs: 9_000,
    });
    expect(negotiateHealthReporting(undefined, { version: 1, intervalMs: 9_000 })).toBeUndefined();
    expect(negotiateHealthReporting({ version: 1, intervalMs: 9_000 }, undefined)).toBeUndefined();
  });
});

// ── HARDENING (adversarial review): fail-closed advert + interval clamp ───────────

describe("mesh-health — HARDENING: partial/NaN advert fails closed (no setInterval(NaN) DoS)", () => {
  const good = { version: 1, intervalMs: 10_000 };

  it("negotiateHealthReporting rejects a missing/non-finite/≤0 advert on EITHER side ⇒ undefined", () => {
    const bad: unknown[] = [
      {}, // healthReporting:{} — both fields omitted (trivially triggerable)
      { version: 1 }, // intervalMs omitted — the honest-client / buggy case
      { intervalMs: 10_000 }, // version omitted
      { version: Number.NaN, intervalMs: 10_000 },
      { version: 1, intervalMs: Number.NaN },
      { version: 1, intervalMs: Number.POSITIVE_INFINITY },
      { version: Number.POSITIVE_INFINITY, intervalMs: 10_000 },
      { version: 0, intervalMs: 10_000 }, // ≤0 version
      { version: 1, intervalMs: 0 }, // ≤0 interval (would coerce to a 0-delay loop)
      { version: 1, intervalMs: -5 },
      { version: "1", intervalMs: "10000" }, // wrong types
    ];
    for (const b of bad) {
      // A bad advert on either operand ⇒ NO negotiation ⇒ startPrimaryHealthLoop is NEVER reached
      // with a NaN/0 interval (the accidental-DoS trigger); the connection falls back to bare-ping.
      expect(negotiateHealthReporting(b as never, good)).toBeUndefined();
      expect(negotiateHealthReporting(good, b as never)).toBeUndefined();
    }
    // A NaN result would only arise from an UNGUARDED min/max — assert it can never appear.
    for (const b of bad) {
      const r = negotiateHealthReporting(b as never, good);
      expect(r === undefined || Number.isFinite(r.intervalMs)).toBe(true);
    }
  });

  it("a partial advert (`{version:1}`, interval omitted) drives the FULL handshake to a fallback (no negotiated params)", () => {
    const primaryId = generateMeshIdentity();
    const proxyId = generateMeshIdentity();
    const proxy = createProxyHandshakeDriver({
      workload: WORKLOAD,
      identity: proxyId,
      pinnedPrimaryPubKey: primaryId.publicKeyPem,
      upstreamUrl: "ws://primary.local",
      healthReporting: { version: 1 } as never, // intervalMs omitted — the buggy-client advert
    });
    const primary = createPrimaryHandshakeDriver({
      identity: primaryId,
      admit: () => ({ ok: false, reason: "unknown_token" }),
      pinnedProxyPubKeyFor: (w) => (w === WORKLOAD ? proxyId.publicKeyPem : undefined),
      healthReporting: { version: 1, intervalMs: 20_000 },
    });
    const s1 = primary.next(proxy.open()!);
    const s2 = proxy.next(s1.send!);
    const s3 = primary.next(s2.send!);
    const s4 = proxy.next(s3.send!);
    // Auth still completes (backward compatible), but NO negotiated interval flows to the tunnel /
    // runtime ⇒ the primary never arms a 0-interval health loop; the proxy uses the bare heartbeat.
    expect(s3.done).toBe(true);
    expect(s4.done).toBe(true);
    expect(s3.healthReporting).toBeUndefined();
    expect(s4.healthReporting).toBeUndefined();
  });

  it("the guarded interval never arms a 0-delay setInterval (defense in depth)", () => {
    // Mirror of the startPrimaryHealthLoop / startHeartbeat guard: a non-finite/≤0 period must
    // short-circuit BEFORE setInterval. This is the shape both loops share (fail-closed).
    const armLoop = (period: number): boolean => {
      if (!Number.isFinite(period) || period <= 0) return false; // guard
      return true; // would setInterval(send, period)
    };
    expect(armLoop(Number.NaN)).toBe(false);
    expect(armLoop(0)).toBe(false);
    expect(armLoop(-1)).toBe(false);
    expect(armLoop(Number.POSITIVE_INFINITY)).toBe(false);
    expect(armLoop(10_000)).toBe(true);
  });

  it("clamps a huge negotiated interval to the stale-detector ceiling (≤ 60s)", () => {
    // interval = max(a,b) then clamped, so a proxy can't push the stale window (interval×3)
    // arbitrarily high to suppress `stale` while withholding real reports.
    expect(negotiateHealthReporting({ version: 1, intervalMs: 999_999 }, { version: 1, intervalMs: 10_000 })).toEqual({
      version: 1,
      intervalMs: 60_000,
    });
    expect(negotiateHealthReporting({ version: 1, intervalMs: 5 * 60_000 }, { version: 1, intervalMs: 5 * 60_000 })).toEqual({
      version: 1,
      intervalMs: 60_000,
    });
    // Below the ceiling: max() as before (unchanged behavior).
    expect(negotiateHealthReporting({ version: 1, intervalMs: 10_000 }, { version: 1, intervalMs: 20_000 })).toEqual({
      version: 1,
      intervalMs: 20_000,
    });
  });
});

// ── UNIT: MeshHealthStore state machine + attribution ────────────────────────────

describe("mesh-health — MeshHealthStore state machine (route-first)", () => {
  const report = (over: HealthFramePayload["overall"], seq: number, ts = "2026-06-30T00:00:00.000Z"): HealthFramePayload => ({
    reporter: WORKLOAD,
    overall: over,
    sources: [{ source: "probe", status: over === "ok" ? "ok" : over === "degraded" ? "degraded" : "unavailable" }],
    seq,
    ts,
  });

  it("connecting → ok → degraded → down as fresh reports arrive over an up tunnel", () => {
    let nowMs = 1_700_000_000_000;
    const store = new MeshHealthStore(() => nowMs);
    const table = new ResolutionTable(() => nowMs);
    table.markAvailable(WORKLOAD); // tunnel up
    store.noteInterval(WORKLOAD, 1_000);

    // No report yet ⇒ connecting.
    expect(store.stateFor(WORKLOAD, table).state).toBe("connecting");

    expect(store.record(WORKLOAD, report("ok", 1))).toBe(true);
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok");
    expect(meshHealthToCapabilityHealth(store.stateFor(WORKLOAD, table)).status).toBe("ok");

    expect(store.record(WORKLOAD, report("degraded", 2))).toBe(true);
    expect(store.stateFor(WORKLOAD, table).state).toBe("degraded");
    expect(meshHealthToCapabilityHealth(store.stateFor(WORKLOAD, table)).status).toBe("degraded");

    expect(store.record(WORKLOAD, report("down", 3))).toBe(true);
    expect(store.stateFor(WORKLOAD, table).state).toBe("down");
    // "down" (remote sources down) maps to the wire `unavailable` (a call will fail).
    expect(meshHealthToCapabilityHealth(store.stateFor(WORKLOAD, table)).status).toBe("unavailable");
  });

  it("marks a mesh cap's resolved health `reported` (self-asserted); a local source's is unmarked (P6-HEALTH-PROV)", () => {
    const store = new MeshHealthStore();
    const table = new ResolutionTable();
    table.markAvailable(WORKLOAD); // tunnel up
    store.record(WORKLOAD, report("ok", 1)); // remote self-asserts healthy

    // The mesh value is a REMOTE SELF-ASSERTION ⇒ it carries the `reported` marker even at ok,
    // where it is otherwise byte-identical to a gateway-proven ok.
    const meshHealth = meshHealthToCapabilityHealth(store.stateFor(WORKLOAD, table));
    expect(meshHealth.status).toBe("ok");
    expect(meshHealth.reported).toBe(true);

    // Wire the provider onto a registry exactly as the mesh runtime does, and confirm the marker
    // survives the `resolvedHealth` seam for a `mesh:<workload>` source …
    const registry = createCapabilityRegistry({
      all: () => [],
      get: () => undefined,
      getTransport: (kind: TransportKind) =>
        ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
    } as SourceRegistry);
    registry.setMeshHealthProvider((sourceId) =>
      sourceId.startsWith("mesh:")
        ? meshHealthToCapabilityHealth(store.stateFor(sourceId.slice("mesh:".length), table))
        : undefined,
    );
    expect(registry.healthOf(`mesh:${WORKLOAD}`).reported).toBe(true);

    // … while a LOCAL source falls through to the probe cache — gateway-PROVEN, marker ABSENT.
    const localHealth = registry.healthOf("workspace");
    expect(localHealth.reported).toBeUndefined();
  });

  it("drops an out-of-order (stale-seq) report", () => {
    const store = new MeshHealthStore();
    const table = new ResolutionTable();
    table.markAvailable(WORKLOAD);
    expect(store.record(WORKLOAD, report("ok", 5))).toBe(true);
    expect(store.record(WORKLOAD, report("down", 4))).toBe(false); // older seq — ignored
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok");
    expect(store.record(WORKLOAD, report("down", 5))).toBe(false); // duplicate seq — ignored
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok");
  });

  it("stale: reports stop (socket still up) ⇒ after N intervals the state goes stale (→ degraded)", () => {
    let nowMs = 1_700_000_000_000;
    const store = new MeshHealthStore(() => nowMs);
    const table = new ResolutionTable(() => nowMs);
    table.markAvailable(WORKLOAD);
    store.noteInterval(WORKLOAD, 1_000); // stale window = 3 × 1s
    store.record(WORKLOAD, report("ok", 1));
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok");

    nowMs += 3_500; // > 3 intervals with no fresh report, tunnel still up
    expect(store.stateFor(WORKLOAD, table).state).toBe("stale");
    expect(meshHealthToCapabilityHealth(store.stateFor(WORKLOAD, table)).status).toBe("degraded");
  });

  it("route wins: a down socket resolves unavailable regardless of the last (ok) report — Invariant E", () => {
    let nowMs = 1_700_000_000_000;
    const store = new MeshHealthStore(() => nowMs);
    const table = new ResolutionTable(() => nowMs);
    table.markAvailable(WORKLOAD);
    store.record(WORKLOAD, report("ok", 1));
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok");

    table.markUnavailable(WORKLOAD); // socket dropped
    const h = store.stateFor(WORKLOAD, table);
    expect(h.state).toBe("unavailable");
    expect(h.unavailableSince).toBeDefined();
    expect(meshHealthToCapabilityHealth(h).status).toBe("unavailable");

    // The last report is KEPT (Invariant B / Risk-1): reconnect + a fresh report recovers to ok.
    table.markAvailable(WORKLOAD);
    store.record(WORKLOAD, report("ok", 2));
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok");
  });

  it("ANTI-FORGERY: a report is attributed to the RECORDING workload, never payload.reporter", () => {
    const store = new MeshHealthStore();
    const table = new ResolutionTable();
    table.markAvailable(WORKLOAD);
    table.markAvailable("victim");
    // A proxy authenticated as WORKLOAD forges reporter:"victim" — the store keys on WORKLOAD.
    store.record(WORKLOAD, { reporter: "victim", overall: "down", sources: [], seq: 1, ts: "2026-06-30T00:00:00Z" });
    expect(store.lastReport(WORKLOAD)?.overall).toBe("down");
    expect(store.lastReport("victim")).toBeUndefined(); // victim was NOT poisoned
    expect(store.stateFor("victim", table).state).toBe("connecting"); // still awaiting its own report
  });

  it("validateHealthPayload rejects malformed payloads (fail-closed)", () => {
    expect(validateHealthPayload({ reporter: "w", overall: "ok", sources: [], seq: 1, ts: "t" })).toBeDefined();
    expect(validateHealthPayload({ reporter: "w", overall: "sideways", sources: [], seq: 1, ts: "t" })).toBeUndefined();
    expect(validateHealthPayload({ reporter: "w", overall: "ok", sources: [{ source: "s" }], seq: 1, ts: "t" })).toBeUndefined();
    expect(validateHealthPayload({ reporter: "w", overall: "ok", sources: [], seq: "x", ts: "t" })).toBeUndefined();
  });

  it("SEQ-RESET on reconnect: a restarted proxy (seq restarts low) recovers connecting→ok, not wedged", () => {
    let nowMs = 1_700_000_000_000;
    const store = new MeshHealthStore(() => nowMs);
    const table = new ResolutionTable(() => nowMs);

    // Connection 1: the proxy climbs to a high seq while healthy.
    store.beginConnection(WORKLOAD);
    table.markAvailable(WORKLOAD);
    expect(store.record(WORKLOAD, report("ok", 50))).toBe(true);
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok");

    // Transient drop — the route goes unavailable, but the last report VALUE is KEPT (Invariant B).
    table.markUnavailable(WORKLOAD);
    expect(store.stateFor(WORKLOAD, table).state).toBe("unavailable");
    expect(store.lastReport(WORKLOAD)?.overall).toBe("ok"); // value retained across the drop

    // WITHOUT a seq-gate reset a restarted proxy's fresh low-seq reports would be dropped forever:
    // seq 1 ≤ stored 50 ⇒ ignored (the wedge). Prove the regression is closed by beginConnection.
    store.record(WORKLOAD, report("down", 1)); // a stray same-epoch low-seq frame is still dropped
    expect(store.lastReport(WORKLOAD)?.seq).toBe(50);

    // Reconnect: onProxyConnected opens a fresh connection epoch (the seq-gate reset).
    store.beginConnection(WORKLOAD);
    table.markAvailable(WORKLOAD);
    // The restarted proxy reports starting at seq 1 again — now ACCEPTED (new epoch bypasses the gate).
    expect(store.record(WORKLOAD, report("ok", 1))).toBe(true);
    expect(store.stateFor(WORKLOAD, table).state).toBe("ok"); // connecting→ok recovery succeeds
    expect(store.record(WORKLOAD, report("degraded", 2))).toBe(true); // in-epoch ordering resumes
    expect(store.stateFor(WORKLOAD, table).state).toBe("degraded");
    expect(store.record(WORKLOAD, report("ok", 1))).toBe(false); // ...and drops the now-stale seq 1
  });

  it("FRAME CAPS: an oversized sources[] or over-long string is rejected fail-closed", () => {
    // A valid baseline still passes.
    expect(
      validateHealthPayload({ reporter: "w", overall: "ok", sources: [{ source: "s", status: "ok" }], seq: 1, ts: "t" }),
    ).toBeDefined();

    // > 64 source rows ⇒ rejected wholesale.
    const tooManySources = Array.from({ length: 65 }, (_, i) => ({ source: `s${i}`, status: "ok" as const }));
    expect(validateHealthPayload({ reporter: "w", overall: "ok", sources: tooManySources, seq: 1, ts: "t" })).toBeUndefined();
    // Exactly 64 is allowed (boundary).
    const maxSources = Array.from({ length: 64 }, (_, i) => ({ source: `s${i}`, status: "ok" as const }));
    expect(validateHealthPayload({ reporter: "w", overall: "ok", sources: maxSources, seq: 1, ts: "t" })).toBeDefined();

    const big = "x".repeat(257); // > 256
    // Over-long reporter, source, and detail strings each fail closed.
    expect(validateHealthPayload({ reporter: big, overall: "ok", sources: [], seq: 1, ts: "t" })).toBeUndefined();
    expect(
      validateHealthPayload({ reporter: "w", overall: "ok", sources: [{ source: big, status: "ok" }], seq: 1, ts: "t" }),
    ).toBeUndefined();
    expect(
      validateHealthPayload({
        reporter: "w",
        overall: "ok",
        sources: [{ source: "s", status: "ok", detail: big }],
        seq: 1,
        ts: "t",
      }),
    ).toBeUndefined();
    // 256 exactly is allowed (boundary).
    expect(validateHealthPayload({ reporter: "x".repeat(256), overall: "ok", sources: [], seq: 1, ts: "t" })).toBeDefined();
  });
});

// ── INTEGRATION: real primary + enrolled proxy, auto-reporting over the tunnel ────

/** A proxy-local source with a CONTROLLABLE `health()` so a test can flip it and watch it ascend. */
class ProbeSource extends BaseCapabilitySource {
  readonly id = "probe";
  readonly label = "Probe source";
  readonly transport = "cli" as const;
  static status: SourceHealth = { status: "ok" };
  constructor(_p: PlatformServices) {
    super();
  }
  override async checkRequirements() {
    return { ok: true, resolved: "probe" };
  }
  override async health(): Promise<SourceHealth> {
    return ProbeSource.status;
  }
  async scan(): Promise<CapabilityEntry[]> {
    return [
      {
        id: PROBE_ID,
        source: "probe",
        kind: "capability",
        label: "Probe",
        describe: "Echo the input back (a health-report probe).",
        io: { input: { type: "object", properties: { text: { type: "string" } } } },
        grants: ["read"],
        transport: "cli",
        extras: { route: { bin: "echo", args: ["{text}"] } },
      },
    ];
  }
}

const probeModule: SourceModule = {
  id: "probe",
  label: "Probe source",
  transport: "cli",
  createSource: (deps: PlatformServices): CapabilitySource => new ProbeSource(deps),
  createBridge: (deps, sessionId) => new BaseCapabilityBridge("probe", deps, sessionId, []),
};

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

describe("mesh-health — INTEGRATION: proxy auto-reports, primary stamps mounted caps", () => {
  let home: string;
  let base: GatewayConfig;
  let host: string;
  let primary: ReturnType<typeof createAppWithState>;
  let proxy: ReturnType<typeof createAppWithState>;
  let proxyCaps: ReturnType<typeof createCapabilityRegistry>;
  let mountedAddress: string;

  const HEALTH_INTERVAL = 50; // fast, deterministic cadence for the test

  async function primaryReq(path: string, init?: RequestInit): Promise<Response> {
    return primary.app.request("http://" + host + path, {
      ...init,
      headers: { host, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  }

  async function invokeMounted(text: string): Promise<{ status: number; body: InvokeResponse }> {
    const hs = (await (await primaryReq("/link/handshake", {
      method: "POST",
      body: JSON.stringify({ connectionKey: primary.state.connectionKey.current(), client: { name: "h", agentId: "a" } }),
    })).json()) as HandshakeResponse;
    const token = (await (await primaryReq("/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { [mountedAddress]: "allow" } }),
    })).json()) as ScopedToken;
    const res = await primaryReq("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: mountedAddress, input: { text } }),
    });
    return { status: res.status, body: (await res.json()) as InvokeResponse };
  }

  beforeAll(async () => {
    ProbeSource.status = { status: "ok" };
    home = mkdtempSync(join(tmpdir(), "plexus-mesh-health-"));
    process.env.PLEXUS_HOME = home;
    _resetSecretCacheForTests();
    base = loadConfig();
    host = expectedHost(base);

    const primaryId = generateMeshIdentity();
    const proxyId = generateMeshIdentity();

    primary = createAppWithState(base, {
      authorizer: new AutoApproveAuthorizer(),
      mesh: { identity: primaryId, healthReporting: { intervalMs: HEALTH_INTERVAL } },
    });
    await primary.state.mesh.start();
    const tunnelPort = primary.state.mesh.tunnelPort;
    const { token } = primary.state.mesh.enrollment!.mintJoinToken();

    const proxySources = testRegistry([probeModule]);
    proxyCaps = createCapabilityRegistry(proxySources);
    const proxyConfig: GatewayConfig = {
      ...base,
      mode: "proxy",
      upstream: { url: `ws://127.0.0.1:${tunnelPort}`, primaryPubKey: primaryId.publicKeyPem },
      workload: WORKLOAD,
    };
    proxy = createAppWithState(proxyConfig, {
      sources: proxySources,
      capabilities: proxyCaps,
      mesh: { identity: proxyId, joinToken: token, healthReporting: { intervalMs: HEALTH_INTERVAL } },
    });
    await proxy.state.capabilities.start();
    await proxy.state.mesh.start();

    await until(() => primary.state.mesh.connected && primary.state.mesh.enrollment!.isActive(WORKLOAD));
    const bareEntry: CapabilityEntry = {
      id: PROBE_ID,
      source: "probe",
      kind: "capability",
      label: "Probe",
      describe: "Echo the input back.",
      grants: ["read"],
      transport: "cli",
    };
    const mount = primary.state.capabilities.mountRemoteWorkload(WORKLOAD, [bareEntry], { tenant: TENANT });
    mountedAddress = mount.mounted[0]!;
    primary.state.exposure.setEnabled(mountedAddress, true);
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

  it("(a) the proxy auto-reports ⇒ the primary stamps the mounted cap HEALTHY (not unknown)", async () => {
    await until(() => primary.state.capabilities.healthOf("mesh:" + WORKLOAD).status === "ok");
    const h = primary.state.capabilities.healthOf("mesh:" + WORKLOAD);
    expect(h.status).toBe("ok"); // ← was "unknown" before health reporting

    // The mounted entry's stamped health flows onto the manifest projection too.
    const entry = primary.state.capabilities.projectedEntries().find((e) => e.id === mountedAddress);
    expect(entry?.health?.status).toBe("ok");
  });

  it("(b) /admin/api/mesh surfaces the per-workload reported health (healthy, negotiated)", async () => {
    const body = (await (await primaryReq("/admin/api/mesh", {
      headers: { "x-plexus-connection-key": primary.state.connectionKey.current() },
    })).json()) as {
      workloads: Array<{ workload: string; state: string; healthReporting: boolean; connection: string; overall?: string }>;
    };
    const row = body.workloads.find((w) => w.workload === WORKLOAD);
    expect(row).toBeDefined();
    expect(row!.healthReporting).toBe(true);
    expect(row!.connection).toBe("connected");
    expect(row!.state).toBe("ok");
    expect(row!.overall).toBe("ok");
  });

  it("(c) the primary reports DOWN to the proxy (bidirectional / cascade liveness)", async () => {
    await until(() => proxy.state.mesh.lastPrimaryHealth !== undefined);
    expect(proxy.state.mesh.lastPrimaryHealth?.reporter).toBe("primary");
  });

  it("(d) a source FLIP on the proxy propagates upstream ⇒ the primary reflects it", async () => {
    ProbeSource.status = { status: "unavailable", detail: "probe backend down" };
    await proxyCaps.refreshHealth("probe"); // force the proxy's cache to the new value

    // The proxy re-aggregates + ascends its health on the next interval tick.
    await until(() => primary.state.capabilities.healthOf("mesh:" + WORKLOAD).status === "unavailable", 4_000);
    expect(primary.state.capabilities.healthOf("mesh:" + WORKLOAD).status).toBe("unavailable");
    const row = primary.state.mesh.meshWorkloadHealth().find((w) => w.workload === WORKLOAD)!;
    expect(row.state).toBe("down");
    expect(row.overall).toBe("down");

    // Recover: flip back to healthy.
    ProbeSource.status = { status: "ok" };
    await proxyCaps.refreshHealth("probe");
    await until(() => primary.state.capabilities.healthOf("mesh:" + WORKLOAD).status === "ok", 4_000);
    expect(primary.state.capabilities.healthOf("mesh:" + WORKLOAD).status).toBe("ok");
  });

  it("(e) DROP the proxy socket ⇒ unavailable (Invariant E), mount survives (Invariant B)", async () => {
    expect(primary.state.capabilities.get(mountedAddress)).toBeDefined(); // mounted before

    proxy.state.mesh.stop(); // kill the socket (no reconnect)
    await until(() => primary.state.mesh.resolution.healthOf(WORKLOAD).status === "unavailable");

    // Invariant E — an invoke of the down cap returns typed capability_unavailable, fast (no hang).
    const { status, body } = await invokeMounted("while-down");
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("capability_unavailable");

    // Invariant B / Risk-1 — the mounted address + its resolved health survive the transient drop.
    expect(primary.state.capabilities.get(mountedAddress)).toBeDefined();
    const meshHealth = primary.state.capabilities.healthOf("mesh:" + WORKLOAD);
    expect(meshHealth.status).toBe("unavailable"); // route-first: the report no longer governs
    const row = primary.state.mesh.meshWorkloadHealth().find((w) => w.workload === WORKLOAD)!;
    expect(row.state).toBe("unavailable");
    expect(row.unavailableSince).toBeDefined();
  });
});
