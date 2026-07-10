/**
 * T6 — Catalog push + primary mount (address rewrite) — federated-mesh §3.2, §7 Q3/Q4,
 * Invariant B (address⟂route) + Invariant F (mount/ascent-rewrite). Phase-1 plan seam (d),
 * risk #4 (zero-exposure default) + risk #5 (translate exactly once per hop).
 *
 *   UNIT (the address-rewrite seam):
 *     - mountAddress → forwardTranslate ROUND-TRIP (the prefix applied at mount is
 *       translated back to the bare id at the forward boundary — exactly once).
 *     - PROXY pushes BARE ids only (workload-agnostic on the wire); a prefixed id throws.
 *     - PRIMARY mount re-addresses: address carries the prefix, source = mesh:<workload>,
 *       transport = "mesh"; the BARE id never appears on the mounted surface; revision bumps.
 *     - `registry.forwardAddress(addr)` is the authoritative inverse (address → workload+bare).
 *     - `deriveSource` still recovers the source from a full address (`/` never corrupts it).
 *     - ZERO-EXPOSURE: the per-id `defaultFor` hook hides a mounted address by default, keeps
 *       `exposure.json` minimal, and does NOT regress local default-exposed semantics.
 *
 *   INTEGRATION (zero-exposure honored end-to-end):
 *     - a mounted entry is INVISIBLE in `.well-known` pre-enable, VISIBLE post-enable.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  SourceRegistry,
  SourceModule,
  Transport,
  TransportKind,
  BridgeDeps,
  WellKnownDocument,
} from "@plexus/protocol";

import {
  createCapabilityRegistry,
  RESERVED_SOURCE_IDS,
} from "@plexus/runtime/core/capability-registry.ts";
import { riskyGrantReason } from "@plexus/runtime/auth/authorizer.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createExposureStore } from "@plexus/runtime/core/exposure.ts";
import { deriveSource } from "@plexus/runtime/core/registry-helpers.ts";
import {
  mountAddress,
  forwardTranslate,
  parseAddress,
  isMountedAddress,
  DEFAULT_TENANT,
} from "@plexus/runtime/mesh/addressing.ts";
import { buildCatalogPush, applyCatalog } from "@plexus/runtime/mesh/catalog.ts";
import { mockEntries, MOCK_SOURCE_ID } from "@plexus/runtime/sources/mock/manifest.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

const WORKLOAD = "laptop";

// A trivial SourceRegistry — `mountRemoteWorkload` never scans sources, so the body is
// irrelevant; we only need a shape to construct the capability registry.
function trivialRegistry(): SourceRegistry {
  return {
    all: () => [],
    get: () => undefined,
    getTransport: (kind: TransportKind) =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const tmpDirs: string[] = [];
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

// ── UNIT: the address grammar round-trip (Invariant F, risk #5) ────────────────

describe("mesh addressing — mount ⇄ forward round-trip", () => {
  it("forwardTranslate inverts mountAddress for every bare id", () => {
    for (const entry of mockEntries()) {
      const bareId = entry.id;
      const address = mountAddress(DEFAULT_TENANT, WORKLOAD, bareId);
      expect(address).toBe(`${DEFAULT_TENANT}/${WORKLOAD}/${bareId}`);
      // exactly-once round-trip: the prefix applied at mount comes back off at forward.
      expect(forwardTranslate(address)).toBe(bareId);
      const parsed = parseAddress(address);
      expect(parsed).toEqual({ tenant: DEFAULT_TENANT, workloadPath: [WORKLOAD], bareId });
    }
  });

  it("refuses to mount an already-prefixed id (no double-prefix)", () => {
    const once = mountAddress(DEFAULT_TENANT, WORKLOAD, "mock.echo.run");
    expect(() => mountAddress(DEFAULT_TENANT, WORKLOAD, once)).toThrow();
  });
});

// ── UNIT: proxy pushes BARE ids; prefixed address never on the wire (Q4) ───────

describe("catalog push — proxy is workload-agnostic on the wire", () => {
  it("emits a catalog frame whose entries all carry BARE ids", () => {
    const frame = buildCatalogPush(WORKLOAD, mockEntries(), { revision: 1 });
    expect(frame.t).toBe("catalog");
    expect(frame.payload.workload).toBe(WORKLOAD);
    expect(frame.payload.revision).toBe(1);
    // The wire NEVER carries a location-prefixed address: every pushed id is bare.
    for (const e of frame.payload.entries) {
      expect(isMountedAddress(e.id)).toBe(false);
      expect(e.id.includes("/")).toBe(false);
    }
  });

  it("rejects a push that tries to embed a prefixed address (fail-closed)", () => {
    const prefixed: CapabilityEntry = {
      ...mockEntries()[0]!,
      id: mountAddress(DEFAULT_TENANT, WORKLOAD, "mock.echo.run"),
    };
    expect(() => buildCatalogPush(WORKLOAD, [prefixed])).toThrow();
  });
});

// ── UNIT: primary mount re-addresses + inverse-translates (Invariant B/F) ──────

describe("primary mount — address rewrite + inverse translate", () => {
  it("mounts bare entries as prefixed addresses, source mesh:<workload>, transport mesh", () => {
    const registry = createCapabilityRegistry(trivialRegistry());
    const before = registry.revision();
    const result = registry.mountRemoteWorkload(WORKLOAD, mockEntries());

    expect(result.revision).toBeGreaterThan(before); // revision bumped
    expect(result.mounted.length).toBe(mockEntries().length);

    for (const entry of mockEntries()) {
      const bareId = entry.id;
      const address = mountAddress(DEFAULT_TENANT, WORKLOAD, bareId);

      // The mounted surface is keyed by the ADDRESS (the grant/audit key, Invariant B).
      const mounted = registry.get(address);
      expect(mounted).toBeDefined();
      expect(mounted!.id).toBe(address);
      expect(mounted!.source).toBe(`mesh:${WORKLOAD}`);
      expect(mounted!.transport).toBe("mesh");

      // BARE id never appears as a key on the mounted surface.
      expect(registry.get(bareId)).toBeUndefined();

      // INVERSE TRANSLATE (the forward boundary, T7): address → { workload, bareId }.
      expect(registry.forwardAddress(address)).toEqual({ workload: WORKLOAD, bareId });
      // and the pure grammar inverse agrees.
      expect(forwardTranslate(address)).toBe(bareId);

      // ZERO-EXPOSURE marker present on the registry (drives the exposure default).
      expect(registry.exposureDefaultFor(address)).toBe("hidden");
      expect(registry.exposureDefaultFor(bareId)).toBeUndefined();
    }
  });

  it("applyCatalog withdraws an un-mounted address", () => {
    const registry = createCapabilityRegistry(trivialRegistry());
    applyCatalog(registry, { workload: WORKLOAD, entries: mockEntries() });
    const addr = mountAddress(DEFAULT_TENANT, WORKLOAD, "mock.echo.run");
    expect(registry.get(addr)).toBeDefined();

    const result = applyCatalog(registry, {
      workload: WORKLOAD,
      entries: [],
      withdrawn: ["mock.echo.run"],
    });
    expect(result.withdrawn).toContain(addr);
    expect(registry.get(addr)).toBeUndefined();
    expect(registry.forwardAddress(addr)).toBeUndefined();
  });

  it("deriveSource recovers the source from a full mounted address (`/` does not corrupt it)", () => {
    const address = mountAddress(DEFAULT_TENANT, WORKLOAD, "mock.echo.run");
    // The bare tail derives to its own source, regardless of the location prefix.
    expect(deriveSource("mock.echo.run")).toBe(MOCK_SOURCE_ID);
    expect(deriveSource(address)).toBe(MOCK_SOURCE_ID);
    // and an MCP-convention tail (`mcp.<server>.<noun>.<verb>`) still maps to its `mcp:`
    // source through a location prefix.
    expect(deriveSource("mcp.github.issue.create")).toBe("mcp:github");
    expect(deriveSource("acme/m1/mcp.github.issue.create")).toBe("mcp:github");
  });
});

// ── UNIT: mount trust-boundary defense (P6-MOUNT-PROV) ─────────────────────────

describe("primary mount — trust-boundary defense against a spoofing proxy", () => {
  it("strips remote-stamped trust fields and re-derives provenance `extension` (would PEND)", () => {
    const registry = createCapabilityRegistry(trivialRegistry());
    // A MALICIOUS proxy pushes a read cap that stamps first-party provenance + a low sensitivity
    // + a long trust-window + an `ok` health — every locally-derived trust fact it must not own.
    const echo = mockEntries()[0]!; // mock.echo.run — grants: ["read"] (would auto-allow if first-party)
    const hostile: CapabilityEntry = {
      ...echo,
      provenance: "first-party",
      sensitivity: "low",
      recommendedTrustWindow: { kind: "until-revoked" },
      health: { status: "ok" },
    };
    registry.mountRemoteWorkload(WORKLOAD, [hostile]);
    const address = mountAddress(DEFAULT_TENANT, WORKLOAD, echo.id);

    // The STORED mounted entry has NONE of the claimed trust fields — they never persist from wire.
    const stored = registry.get(address)!;
    expect(stored.source).toBe(`mesh:${WORKLOAD}`);
    expect(stored.provenance).toBeUndefined();
    expect(stored.sensitivity).toBeUndefined();
    expect(stored.recommendedTrustWindow).toBeUndefined();
    expect(stored.health).toBeUndefined();

    // EFFECTIVE posture re-derives LOCALLY from the `mesh:<workload>` source → `extension`
    // (strictest), even though the proxy claimed `first-party`.
    const stamped = registry.stampPosture(stored);
    expect(stamped.provenance).toBe("extension");

    // Therefore a READ grant on it PENDS (extension-sourced ⇒ any verb needs a human), instead of
    // the auto-allow a spoofed `first-party` read would have gotten — the trust boundary holds.
    const reason = riskyGrantReason(stamped, ["read"], RESERVED_SOURCE_IDS);
    expect(reason).toBeDefined();
    expect(reason).toContain("extension");
  });
});

// ── UNIT: zero-exposure default hook (plan risk #4) ────────────────────────────

describe("exposure store — per-id default resolver (mesh zero-exposure)", () => {
  it("hides a mounted address by default without bloating the file, keeps local exposed", () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-mesh-exposure-"));
    tmpDirs.push(dir);
    process.env.PLEXUS_HOME = dir;

    const registry = createCapabilityRegistry(trivialRegistry());
    registry.mountRemoteWorkload(WORKLOAD, mockEntries());
    const address = mountAddress(DEFAULT_TENANT, WORKLOAD, "mock.echo.run");

    const exposure = createExposureStore();
    exposure.setDefaultResolver((id) => registry.exposureDefaultFor(id));

    // MOUNTED address: default HIDDEN (zero-exposure) with NO explicit policy entry.
    expect(exposure.isEnabled(address)).toBe(false);
    expect(exposure.isDisabled(address)).toBe(true);
    expect(exposure.disabledIds()).not.toContain(address); // file stays minimal

    // LOCAL id (resolver returns undefined): unchanged default-EXPOSED semantics.
    expect(exposure.isEnabled("mock.echo.run")).toBe(true);
    expect(exposure.isDisabled("mock.echo.run")).toBe(false);

    // OWNER enables the mounted address → an explicit `true` persists (default is false).
    exposure.setEnabled(address, true);
    expect(exposure.isEnabled(address)).toBe(true);
    expect(exposure.all()[address]).toBe(true);

    // Toggling it back to its (hidden) default DROPS the key — minimal in both directions.
    exposure.setEnabled(address, false);
    expect(exposure.isEnabled(address)).toBe(false);
    expect(address in exposure.all()).toBe(false);

    // A local cap disabled below its default still persists an explicit `false` (no regression).
    exposure.setEnabled("mock.echo.run", false);
    expect(exposure.disabledIds()).toContain("mock.echo.run");
  });
});

// ── INTEGRATION: mounted entry hidden pre-enable, visible post-enable ──────────

function localMockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: MOCK_SOURCE_ID,
    label: "Mock",
    transport: "cli",
    createSource: () => {
      throw new Error("scan not used in this test");
    },
    createBridge: (_deps: BridgeDeps, _sessionId: string) => {
      throw new Error("bridge not used in this test");
    },
  };
  return {
    all: () => [module],
    get: (id) => (id === MOCK_SOURCE_ID ? module : undefined),
    getTransport: (kind: TransportKind) =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

describe("zero-exposure honored in discovery (.well-known)", () => {
  const config = loadConfig();
  const HOST = expectedHost(config);

  function freshApp() {
    const dir = mkdtempSync(join(tmpdir(), "plexus-mesh-disc-"));
    tmpDirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    _resetSecretCacheForTests();
    const sources = localMockRegistry();
    const capabilities = createCapabilityRegistry(sources);
    // Seed a LOCAL entry so the directory is non-empty (default-exposed control).
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(
      "mock.echo.run",
      mockEntries()[0]!,
    );
    const { app, state } = createAppWithState(config, { sources, capabilities });
    return { app, state };
  }

  async function wellKnown(app: ReturnType<typeof freshApp>["app"]): Promise<WellKnownDocument> {
    const res = await app.request("http://" + HOST + "/.well-known/plexus", {
      headers: { host: HOST },
    });
    return (await res.json()) as WellKnownDocument;
  }

  it("a mounted entry is hidden pre-enable and visible post-enable; revision bumps", async () => {
    const { app, state } = freshApp();
    const address = mountAddress(DEFAULT_TENANT, WORKLOAD, "mock.note.write");

    const revBefore = state.capabilities.revision();
    // Mount with the enrollment's zero-exposure default (§7 Q3).
    state.capabilities.mountRemoteWorkload(WORKLOAD, [mockEntries()[1]!], {
      exposureDefault: "hidden",
    });
    expect(state.capabilities.revision()).toBeGreaterThan(revBefore);

    // The exposure-aware discoverable id set — what the public `.well-known` used to
    // carry before the catalog moved post-handshake (authorized-subset model §3.3).
    const discoverableIds = () =>
      state.capabilities
        .summaries()
        .filter((s) => !state.exposure?.isDisabled(s.id))
        .map((s) => s.id);

    // PRE-ENABLE: the mounted address is INVISIBLE in discovery; the local cap is visible.
    const idsBefore = discoverableIds();
    expect(idsBefore).toContain("mock.echo.run"); // local default-exposed control
    expect(idsBefore).not.toContain(address); // mounted ⇒ zero-exposure ⇒ hidden

    // OWNER enables it.
    state.exposure.setEnabled(address, true);

    // POST-ENABLE: now VISIBLE in discovery.
    const idsAfter = discoverableIds();
    expect(idsAfter).toContain(address);
  });
});
