/**
 * HEALTH — per-source health protocol (agent-facing + admin).
 *
 * A SOURCE reports health; each of its capabilities INHERITS that one value
 * (per-source granularity). These tests assert the full contract:
 *
 *   1. DERIVE-FROM-checkRequirements when `health()` is absent — ok→"ok",
 *      not-ok→"unavailable" (with the reason as detail).
 *   2. A source's `health()` override wins (and can report "degraded").
 *   3. `.well-known` summaries carry the inherited per-source `health`.
 *   4. Handshake manifest entries carry the inherited per-source `health`.
 *   5. GET /admin/api/health returns the per-source report shape.
 *   6. GET /admin/api/sources includes `health` on each SourceView.
 *   7. An unavailable source's invoke returns `source_unavailable` with a detail.
 *
 * Throwaway PLEXUS_HOME per app — never touches the real ~/.plexus.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilitySource,
  HandshakeResponse,
  InvokeRequest,
  InvokeResponse,
  Manifest,
  ScopedToken,
  SourceHealth,
  SourceModule,
  SourceRegistry,
  SourceRequirementResult,
  Transport,
  TransportKind,
  WellKnownDocument,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import {
  createCapabilityRegistry,
  type SourceHealthReport,
} from "@plexus/runtime/core/capability-registry.ts";
import {
  createSourceHealthCache,
  probeSourceHealth,
} from "@plexus/runtime/core/source-health.ts";
import { BaseCapabilitySource, BaseCapabilityBridge } from "@plexus/runtime/sources/base.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { sourcesConfigPath } from "@plexus/runtime/sources/config/store.ts";
import { OBSIDIAN_SOURCE_ID } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import type { ConfiguredSource } from "@plexus/runtime/sources/config/types.ts";

const config = loadConfig();
const HOST = expectedHost(config);
const dirs: string[] = [];

// Use the reserved first-party id "mock" so a READ grant AUTO-APPROVES (first-party
// read posture) — these invoke tests are about HEALTH, not the authorizer pend path.
const HEALTH_SOURCE_ID = "mock" as const;
const HEALTH_CAP_ID = "mock.note.read" as const;

/** The single entry the health-mock source always contributes (so it stays live). */
function healthEntry(): CapabilityEntry {
  return {
    id: HEALTH_CAP_ID,
    source: HEALTH_SOURCE_ID,
    kind: "capability",
    label: "Read a mock note",
    describe: "Read a note. Use when you need note text.",
    grants: ["read"],
    transport: "local-rest",
  };
}

/** Knobs to drive the source's health/requirements behavior per test. */
interface HealthKnobs {
  /** Force `checkRequirements()`; default ok:true. */
  requirements?: SourceRequirementResult;
  /** When set, the source IMPLEMENTS `health()` returning this (overrides derivation). */
  health?: SourceHealth;
}

/**
 * A live source that ALWAYS contributes one entry (so it stays live + discoverable)
 * but whose `checkRequirements()` / `health()` are injectable. When `knobs.health` is
 * undefined the source does NOT override `health()`, so the gateway DERIVES health
 * from `checkRequirements()`.
 */
class HealthMockSource extends BaseCapabilitySource {
  readonly id = HEALTH_SOURCE_ID;
  readonly label = "Health mock source";
  readonly transport = "local-rest" as const;

  constructor(private readonly knobs: HealthKnobs) {
    super();
  }

  override async checkRequirements(): Promise<SourceRequirementResult> {
    return this.knobs.requirements ?? { ok: true };
  }

  // Only define a custom health() when the test asked for an override — otherwise the
  // BaseCapabilitySource default (derive-from-checkRequirements) is exercised.
  override async health(): Promise<SourceHealth> {
    if (this.knobs.health) return this.knobs.health;
    return super.health();
  }

  async scan(): Promise<CapabilityEntry[]> {
    return [healthEntry()];
  }
}

/** A bridge that succeeds (only reached when the source is healthy + granted). */
class HealthMockBridge extends BaseCapabilityBridge {}

function healthRegistry(knobs: HealthKnobs): SourceRegistry {
  const transports: Partial<Record<TransportKind, Transport>> = {};
  const module: SourceModule = {
    id: HEALTH_SOURCE_ID,
    label: "Health mock source",
    transport: "local-rest",
    createSource: (): CapabilitySource => new HealthMockSource(knobs),
    createBridge: (deps: BridgeDeps, sessionId: string): CapabilityBridge =>
      new HealthMockBridge(HEALTH_SOURCE_ID, deps, sessionId, [healthEntry()]),
  };
  return {
    all: () => [module],
    get: (id) => (id === HEALTH_SOURCE_ID ? module : undefined),
    getTransport: (kind: TransportKind): Transport =>
      transports[kind] ?? ({ kind, dispatch: async () => ({ ok: true, data: {} }) } as Transport),
  };
}

function freshApp(knobs: HealthKnobs) {
  const dir = mkdtempSync(join(tmpdir(), "plexus-health-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = healthRegistry(knobs);
  const capabilities = createCapabilityRegistry(sources);
  const built = createAppWithState(config, { sources, capabilities });
  return { ...built, dir, key: built.state.connectionKey.current() };
}

async function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Drive the registry's start() (boot scan) + let the background health warm-up settle. */
async function boot(state: ReturnType<typeof freshApp>["state"]) {
  await state.capabilities.start();
  // The warm-up probes are fire-and-forget; await refreshHealth so the first read is
  // a real snapshot rather than the lazy "unknown" placeholder.
  await state.capabilities.refreshHealth(HEALTH_SOURCE_ID);
}

afterAll(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── 1. DERIVE-FROM-checkRequirements (no health() override) ──────────────────────
describe("HEALTH: derive from checkRequirements when health() is absent", () => {
  it("ok requirements ⇒ status 'ok'", async () => {
    const src = new (class extends BaseCapabilitySource {
      readonly id = "x";
      readonly label = "x";
      readonly transport = "cli" as const;
      override async checkRequirements(): Promise<SourceRequirementResult> {
        return { ok: true, resolved: "/usr/bin/x" };
      }
      async scan(): Promise<CapabilityEntry[]> {
        return [];
      }
    })();
    // The BaseCapabilitySource default health() derives from checkRequirements.
    const h = await src.health();
    expect(h.status).toBe("ok");
  });

  it("not-ok requirements ⇒ status 'unavailable' carrying the reason as detail", async () => {
    const src = new (class extends BaseCapabilitySource {
      readonly id = "y";
      readonly label = "y";
      readonly transport = "cli" as const;
      override async checkRequirements(): Promise<SourceRequirementResult> {
        return { ok: false, reason: "`claude` not found on PATH" };
      }
      async scan(): Promise<CapabilityEntry[]> {
        return [];
      }
    })();
    const h = await src.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toBe("`claude` not found on PATH");
  });

  it("probeSourceHealth maps a source with no health() via checkRequirements", async () => {
    // A bare object with ONLY checkRequirements (no health()) ⇒ derived.
    const bareOk = { checkRequirements: async () => ({ ok: true }) } as unknown as CapabilitySource;
    expect((await probeSourceHealth(bareOk)).status).toBe("ok");
    const bareDown = {
      checkRequirements: async () => ({ ok: false, reason: "down" }),
    } as unknown as CapabilitySource;
    const down = await probeSourceHealth(bareDown);
    expect(down.status).toBe("unavailable");
    expect(down.detail).toBe("down");
  });
});

// ── 2. health() override wins (incl. "degraded") ─────────────────────────────────
describe("HEALTH: a source's health() override is authoritative", () => {
  it("override returns 'degraded' even though checkRequirements is ok", async () => {
    const src = new HealthMockSource({
      requirements: { ok: true },
      health: { status: "degraded", detail: "slow upstream" },
    });
    const h = await src.health();
    expect(h.status).toBe("degraded");
    expect(h.detail).toBe("slow upstream");
  });

  it("the cache stamps checkedAt and serves stale-while-revalidate", async () => {
    let live: CapabilitySource | undefined = new HealthMockSource({ requirements: { ok: true } });
    const cache = createSourceHealthCache(() => live, { ttlMs: 50 });
    // First sync read: never probed ⇒ "unknown", kicks off a background probe.
    expect(cache.cached(HEALTH_SOURCE_ID).status).toBe("unknown");
    // Awaitable refresh resolves to a stamped snapshot.
    const fresh = await cache.refresh(HEALTH_SOURCE_ID);
    expect(fresh.status).toBe("ok");
    expect(typeof fresh.checkedAt).toBe("string");
    // A source that drops out of the live set reads "unavailable".
    live = undefined;
    const gone = await cache.refresh(HEALTH_SOURCE_ID);
    expect(gone.status).toBe("unavailable");
  });
});

// ── 3. .well-known summaries carry inherited health ──────────────────────────────
describe("HEALTH: .well-known summaries carry the inherited per-source health", () => {
  it("ok source ⇒ summary.health.status === 'ok'", async () => {
    const { app, state } = freshApp({ requirements: { ok: true } });
    await boot(state);
    const res = await req(app, "/.well-known/plexus");
    const wk = (await res.json()) as WellKnownDocument;
    const summary = wk.capabilities.find((c) => c.id === HEALTH_CAP_ID);
    expect(summary).toBeDefined();
    expect(summary?.health?.status).toBe("ok");
    expect(typeof summary?.health?.checkedAt).toBe("string");
  });

  it("unavailable source ⇒ summary.health carries status + detail", async () => {
    const { app, state } = freshApp({ requirements: { ok: false, reason: "service down" } });
    await boot(state);
    const res = await req(app, "/.well-known/plexus");
    const wk = (await res.json()) as WellKnownDocument;
    const summary = wk.capabilities.find((c) => c.id === HEALTH_CAP_ID);
    expect(summary?.health?.status).toBe("unavailable");
    expect(summary?.health?.detail).toBe("service down");
  });
});

// ── 4. Handshake manifest entries carry inherited health ─────────────────────────
describe("HEALTH: handshake manifest entries carry the inherited per-source health", () => {
  it("manifest entry.health is stamped per-source", async () => {
    const { app, state } = freshApp({ health: { status: "degraded", detail: "warming up" } });
    await boot(state);
    const hsRes = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({ connectionKey: state.connectionKey.current(), client: { name: "h" } }),
    });
    const hs = (await hsRes.json()) as HandshakeResponse;
    const entry = hs.manifest.entries.find((e) => e.id === HEALTH_CAP_ID);
    expect(entry).toBeDefined();
    expect(entry?.health?.status).toBe("degraded");
    expect(entry?.health?.detail).toBe("warming up");
    // GET /manifest mirrors it.
    const mRes = await req(app, "/manifest", {
      headers: { "X-Plexus-Session": hs.sessionId },
    });
    const m = ((await mRes.json()) as { manifest: Manifest }).manifest;
    expect(m.entries.find((e) => e.id === HEALTH_CAP_ID)?.health?.status).toBe("degraded");
  });
});

// ── 5. GET /admin/api/health shape ───────────────────────────────────────────────
describe("HEALTH: GET /admin/api/health returns the per-source report", () => {
  it("reports one row per source with its inherited capabilities", async () => {
    const { app, state } = freshApp({ requirements: { ok: false, reason: "endpoint unreachable" } });
    await boot(state);
    // FEAT configurable-binding re-gating: /admin/api/* reads are now key-gated.
    const res = await req(app, "/admin/api/health", {
      headers: { "X-Plexus-Connection-Key": state.connectionKey.current() },
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as SourceHealthReport;
    expect(typeof report.revision).toBe("number");
    const row = report.sources.find((s) => s.id === HEALTH_SOURCE_ID);
    expect(row).toBeDefined();
    expect(row?.status).toBe("unavailable");
    expect(row?.detail).toBe("endpoint unreachable");
    expect(typeof row?.checkedAt).toBe("string");
    expect(row?.capabilities).toContain(HEALTH_CAP_ID);
  });
});

// ── 6. GET /admin/api/sources includes SourceView.health ─────────────────────────
describe("HEALTH: SourceView.health is present on /admin/api/sources", () => {
  it("a managed source row carries a health snapshot", async () => {
    // Use the real default registry + add a managed obsidian-fs source (deterministically
    // live: in-process handler, no external service). Its SourceView must carry health.
    const dir = mkdtempSync(join(tmpdir(), "plexus-health-sv-"));
    dirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    _resetSecretCacheForTests();
    const built = createAppWithState(config);
    const key = built.state.connectionKey.current();
    const cfg: ConfiguredSource = {
      id: OBSIDIAN_SOURCE_ID,
      kind: "obsidian-fs",
      label: "Obsidian vault (test)",
      enabled: true,
      transport: "ipc",
      route: { vaultPath: join(tmpdir(), "vault-health-test") },
    };
    const add = await built.app.request("http://" + HOST + "/admin/api/sources", {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json", "X-Plexus-Connection-Key": key },
      body: JSON.stringify(cfg),
    });
    expect(add.status).toBe(200);
    // Confirm sources.json persisted (sanity the managed flow ran).
    expect(sourcesConfigPath().length).toBeGreaterThan(0);

    const list = await built.app.request("http://" + HOST + "/admin/api/sources", {
      headers: { host: HOST, "X-Plexus-Connection-Key": key },
    });
    const body = (await list.json()) as {
      sources: { id: string; health?: { status: string } }[];
    };
    const view = body.sources.find((s) => s.id === OBSIDIAN_SOURCE_ID);
    expect(view).toBeDefined();
    expect(view?.health).toBeDefined();
    expect(typeof view?.health?.status).toBe("string");
  });
});

// ── 7. Unavailable source invoke ⇒ source_unavailable with a detail ──────────────
describe("HEALTH: an unavailable source's invoke returns source_unavailable + detail", () => {
  it("a granted invoke against an unavailable source fails source_unavailable", async () => {
    const { app, state } = freshApp({
      requirements: { ok: false, reason: "`claude` not on PATH" },
    });
    await boot(state);

    // Handshake + grant the read scope (so the denial is HEALTH, not grant_required).
    const hsRes = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({
        connectionKey: state.connectionKey.current(),
        client: { name: "inv", agentId: "agent-health" },
      }),
    });
    const hs = (await hsRes.json()) as HandshakeResponse;
    const grantRes = await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { [HEALTH_CAP_ID]: "allow" } }),
    });
    const token = (await grantRes.json()) as ScopedToken;

    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: HEALTH_CAP_ID, input: {} } satisfies InvokeRequest),
    });
    // source_unavailable maps to HTTP 503.
    expect(res.status).toBe(503);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.id).toBe(HEALTH_CAP_ID);
    expect(body.error?.code).toBe("source_unavailable");
    // The precise health detail is reconciled into the error message (not opaque).
    expect(body.error?.message).toContain("`claude` not on PATH");
    // It was audited (non-empty audit id).
    expect(typeof body.auditId).toBe("string");
    expect(body.auditId.length).toBeGreaterThan(0);
  });

  it("a healthy source's granted invoke dispatches normally (ok)", async () => {
    const { app, state } = freshApp({ requirements: { ok: true } });
    await boot(state);
    const hsRes = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({
        connectionKey: state.connectionKey.current(),
        client: { name: "inv2", agentId: "agent-ok" },
      }),
    });
    const hs = (await hsRes.json()) as HandshakeResponse;
    const grantRes = await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { [HEALTH_CAP_ID]: "allow" } }),
    });
    const token = (await grantRes.json()) as ScopedToken;
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: HEALTH_CAP_ID, input: {} } satisfies InvokeRequest),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(true);
  });
});
