/**
 * m5fix — FIRST-RUN BOOT SCAN regression.
 *
 * The bug: a plain `bun run start` (no `--vault`, no extension) booted the gateway
 * but `GET /.well-known/plexus` returned `capabilities: []` — EMPTY — because
 * nothing at boot started/scanned the capability registry. A user opening `/admin`
 * saw no capabilities to manage. Root cause: `src/index.ts` / the launcher called
 * `createApp(WithState)` but never `state.capabilities.start()` / a scan, so the
 * registry stayed empty until something (e.g. `--vault` → a refresh) triggered a
 * scan.
 *
 * The fix: `bootScanCapabilities(state)` (start + bounded-await initial scan) runs
 * at boot in BOTH `src/index.ts` and `bin/plexus` so available first-party MODULES
 * sources (e.g. claudecode when `claude` is on PATH) populate `.well-known` + the
 * `/admin` manifest immediately on a plain boot.
 *
 * NOTE: the public `.well-known` no longer carries a capability catalog
 * (authorized-subset model §3.3) — it advertises `capabilitiesVia` instead. The
 * boot-scan RESULT is now observed on the management catalog
 * (`GET /admin/api/capabilities`, connection-key gated), which reflects the same
 * registry the scan populates.
 *
 * These tests assert (against an injected availability-GATED source module — the
 * same shape a first-party source whose scan degrades to [] on a missing binary has):
 *   1. A plain boot (no vault, no extension) + bootScanCapabilities yields a
 *      management catalog that is NON-EMPTY when the source's requirement
 *      (`claude` on PATH) is available; the public doc carries no catalog.
 *   2. It DEGRADES GRACEFULLY to an empty catalog when the requirement is
 *      absent (the source's scan gates to []).
 *   3. SECURITY UNCHANGED: a now-discoverable capability is NOT usable without a
 *      grant — an un-granted invoke still returns `grant_required`
 *      (discoverable ≠ granted).
 *
 * The boot scan NEVER touches real user state: PLEXUS_HOME points at a temp dir.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Hono } from "hono";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { bootScanCapabilities } from "@plexus/runtime/core/state.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { BaseCapabilitySource } from "@plexus/runtime/sources/index.ts";
import type {
  CapabilityBridge,
  CapabilityEntry,
  HandshakeResponse,
  InvokeResponse,
  PlatformServices,
  SourceModule,
  SourceRegistry,
  SourceRequirementResult,
  Transport,
  TransportKind,
  WellKnownDocument,
} from "@plexus/protocol";

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

/** The gated demo capability the injected module exposes. */
const DEMO_RUN_ID = "bootdemo.tool.run";

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "plexus-m5fix-home-"));
  tmpDirs.push(dir);
  return dir;
}

/** A platform whose `resolveBinary("claude")` is forced present/absent. */
function platformStub(claudePath: string | undefined): PlatformServices {
  return {
    platform: "darwin",
    async resolveBinary(name) {
      return name === "claude" ? claudePath : undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("not used");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

/**
 * An availability-GATED first-party-shaped source: `checkRequirements()` needs
 * `claude` on the platform seam; `scan()` degrades to [] when it is absent — the
 * same graceful-degradation shape the original boot-scan bug report exercised.
 */
class GatedDemoSource extends BaseCapabilitySource {
  readonly id = "bootdemo";
  readonly label = "boot-scan demo source";
  readonly transport = "ipc" as const;

  constructor(private readonly platform: PlatformServices) {
    super();
  }

  override async checkRequirements(): Promise<SourceRequirementResult> {
    const claude = await this.platform.resolveBinary("claude");
    return claude ? { ok: true, resolved: claude } : { ok: false, reason: "`claude` not on PATH" };
  }

  async scan(): Promise<CapabilityEntry[]> {
    const req = await this.checkRequirements();
    if (!req.ok) return [];
    return [
      {
        id: DEMO_RUN_ID,
        source: "bootdemo",
        kind: "capability",
        label: "Run the demo tool",
        describe:
          "A demo execute capability used to prove the first-run boot scan populates " +
          "discovery without granting anything (discoverable ≠ granted).",
        grants: ["execute"],
        transport: "ipc",
        version: "0.0.1",
      },
    ];
  }
}

/**
 * A SourceRegistry exposing the single gated module with a forced claude-presence.
 * When `claudePath` is undefined, checkRequirements gates scan() to [] → the
 * registry stays empty (graceful degradation).
 */
function gatedRegistry(claudePath: string | undefined): SourceRegistry {
  const platform = platformStub(claudePath);
  const transports = buildTransports(platform);
  const module: SourceModule = {
    id: "bootdemo",
    label: "boot-scan demo source",
    transport: "ipc",
    createSource: () => new GatedDemoSource(platform),
    // Bridge is irrelevant for these discovery/security assertions; the security
    // test denies BEFORE any bridge dispatch (no grant ⇒ no invoke).
    createBridge: (): CapabilityBridge => {
      throw new Error("bridge must not be reached without a grant");
    },
  };
  return {
    all: () => [module],
    get: (id) => (id === "bootdemo" ? module : undefined),
    getTransport: (kind: TransportKind): Transport => transports[kind],
  };
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.PLEXUS_HOME;
});

async function getWellKnown(app: Hono): Promise<WellKnownDocument> {
  const res = await app.request("http://" + HOST + "/.well-known/plexus", {
    headers: { host: HOST },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as WellKnownDocument;
}

// The public `.well-known` no longer carries a catalog (authorized-subset model §3.3).
// The boot-scan RESULT is now observed on the management catalog (all registered
// entries, no exposure filter), which is connection-key gated.
async function getCatalog(app: Hono, key: string): Promise<CapabilityEntry[]> {
  const res = await app.request("http://" + HOST + "/admin/api/capabilities", {
    headers: { host: HOST, "X-Plexus-Connection-Key": key },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: CapabilityEntry[] }).entries;
}

describe("m5fix: plain boot scan populates .well-known (no vault, no extension)", () => {
  beforeAll(() => {
    process.env.PLEXUS_HOME = freshHome();
  });

  it("NON-EMPTY catalog after bootScanCapabilities when `claude` is available", async () => {
    const sources = gatedRegistry("/usr/local/bin/claude");
    const capabilities = createCapabilityRegistry(sources);
    const { app, state } = createAppWithState(config, { sources, capabilities });
    const key = state.connectionKey.current();

    // The public discovery doc never carries a catalog (authorized-subset §3.3) — it
    // points agents at handshake instead of enumerating capabilities pre-identity.
    const pub = await getWellKnown(app);
    expect(pub.capabilities).toBeUndefined();
    expect(typeof pub.capabilitiesVia).toBe("string");
    expect((pub.capabilitiesVia ?? "").length).toBeGreaterThan(0);

    // BEFORE the boot scan: the registry is empty (this WAS the bug at boot).
    expect(await getCatalog(app, key)).toEqual([]);

    // The boot scan is the fix: start + scan available first-party sources.
    await bootScanCapabilities(state);

    // AFTER: the catalog is NON-EMPTY and includes the demo entry.
    const after = await getCatalog(app, key);
    expect(after.length).toBeGreaterThan(0);

    const demo = after.find((c) => c.id === DEMO_RUN_ID);
    expect(demo).toBeDefined();
    expect(demo?.source).toBe("bootdemo");
    expect(demo?.kind).toBe("capability");
  });

  it("DEGRADES GRACEFULLY to an empty catalog when `claude` is absent", async () => {
    const sources = gatedRegistry(undefined); // no `claude` on PATH
    const capabilities = createCapabilityRegistry(sources);
    const { app, state } = createAppWithState(config, { sources, capabilities });
    const key = state.connectionKey.current();

    await bootScanCapabilities(state); // must not throw / hang

    // checkRequirements gates scan() to [] ⇒ nothing discoverable.
    expect(await getCatalog(app, key)).toEqual([]);
    // The public doc is still structurally valid (no catalog, carries the pointer).
    const pub = await getWellKnown(app);
    expect(pub.capabilities).toBeUndefined();
    expect(typeof pub.capabilitiesVia).toBe("string");
  });

  it("uses the REAL platform too: the gated source is discoverable when `claude` is truly on PATH", async () => {
    // Skip-soft: only assert presence when the host actually has `claude` — this
    // mirrors the real `bun run start` first-run that motivated the fix.
    const claude = await getPlatformServices().resolveBinary("claude");
    const sources = gatedRegistry(claude);
    const capabilities = createCapabilityRegistry(sources);
    const { app, state } = createAppWithState(config, { sources, capabilities });
    const key = state.connectionKey.current();

    await bootScanCapabilities(state);
    const entries = await getCatalog(app, key);

    if (claude) {
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((c) => c.id === DEMO_RUN_ID)).toBe(true);
    } else {
      expect(entries).toEqual([]);
    }
  });
});

describe("m5fix: discoverable ≠ granted — security invariant unchanged", () => {
  beforeAll(() => {
    process.env.PLEXUS_HOME = freshHome();
  });

  it("an un-granted invoke of a now-discoverable capability returns grant_required", async () => {
    const sources = gatedRegistry("/usr/local/bin/claude");
    const capabilities = createCapabilityRegistry(sources);
    const { app, state } = createAppWithState(config, { sources, capabilities });

    // Boot scan makes the demo capability DISCOVERABLE.
    await bootScanCapabilities(state);
    const key = state.connectionKey.current();
    const catalog = await getCatalog(app, key);
    expect(catalog.some((c) => c.id === DEMO_RUN_ID)).toBe(true);

    // Handshake (a valid session/token), but DO NOT grant anything.
    const hsRes = await app.request("http://" + HOST + "/link/handshake", {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ connectionKey: key, client: { name: "m5fix", agentId: "agent-m5" } }),
    });
    const hs = (await hsRes.json()) as HandshakeResponse;
    expect(hs.sessionId).toBeTruthy();

    // Invoke the discoverable-but-ungranted capability → grant_required (not usable).
    const invokeRes = await app.request("http://" + HOST + "/invoke", {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ id: DEMO_RUN_ID, input: {} }),
    });
    const body = (await invokeRes.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");
    expect(body.id).toBe(DEMO_RUN_ID);
  });
});
