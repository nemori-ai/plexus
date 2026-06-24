/**
 * ADR-018 — UNIFIED TRUST MODEL (Phase A backend spine).
 *
 * Asserts the backend contract the UI + docs build on:
 *   - 3-class provenance + the auto-allow boundary (managed read auto-allows;
 *     extension read pends; first-party/managed write/exec pends);
 *   - the per-class default trust-window table (read 7d/7d/1d; write 1d/1d/once);
 *   - "once" semantics: non-renewable, persisted standing:false, does NOT
 *     short-circuit `hasPriorApproval` (re-requests next time);
 *   - the `anon:*` cap (no durable standing grant — capped at once);
 *   - `GET /grants` lists the caller's standing grants with provenance + window;
 *   - the admin TARGET-AGENT grant (decoy fix) pre-authorizes the REAL agent so its
 *     next request hits `hasPriorApproval` (auto-allows, mints a token).
 *
 * Driven through the published wire + the admin channel — no fake-green.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapabilityEntry,
  CapabilityId,
  SourceRegistry,
  SourceModule,
  Transport,
  TransportKind,
  CapabilityBridge,
  BridgeDeps,
  InvokeRequest,
  InvokeContext,
  InvokeResponse,
  HandshakeResponse,
  GrantResponse,
  GrantPendingResponse,
  GrantStatusResponse,
  GrantsListResponse,
  ScopedToken,
  StandingGrant,
} from "@plexus/protocol";
import { createAppWithState } from "../src/core/server.ts";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import { loadConfig, expectedHost } from "../src/config.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "../src/auth/index.ts";
import {
  provenanceFor,
  sensitivityFor,
  recommendedTrustWindowFor,
} from "../src/core/capability-registry.ts";
import { resolveWindowExpiry, UNTIL_REVOKED_EXPIRY_MS } from "../src/core/grants.ts";

// ── Entries: first-party (source "mock", reserved) + a "managed" source + an
//    "extension" source. The capability-registry derives `managed` from the LIVE
//    managedSources list; for this test we seed entries directly and inject the
//    managed-source-id provider via setPostureInputs (the state wiring does the same).
const FP_READ: CapabilityEntry = {
  id: "mock.note.read",
  source: "mock",
  kind: "capability",
  label: "Read a mock note",
  describe: "Read a note.",
  grants: ["read"],
  transport: "local-rest",
};
const FP_WRITE: CapabilityEntry = {
  id: "mock.note.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock note",
  describe: "Write a note.",
  grants: ["write"],
  transport: "local-rest",
};
const MANAGED_READ: CapabilityEntry = {
  id: "obsidian-rest.vault.read",
  source: "obsidian-rest",
  kind: "capability",
  label: "Read the Obsidian vault (REST)",
  describe: "Read a vault note over the local REST API.",
  grants: ["read"],
  transport: "local-rest",
};
const MANAGED_WRITE: CapabilityEntry = {
  id: "obsidian-rest.vault.write",
  source: "obsidian-rest",
  kind: "capability",
  label: "Write the Obsidian vault (REST)",
  describe: "Write a vault note over the local REST API.",
  grants: ["write"],
  transport: "local-rest",
};
const EXT_READ: CapabilityEntry = {
  id: "evil-tool.api.read",
  source: "evil-tool",
  kind: "capability",
  label: "Read a local API",
  describe: "Read a local API.",
  grants: ["read"],
  transport: "local-rest",
};
const ALL_ENTRIES = [FP_READ, FP_WRITE, MANAGED_READ, MANAGED_WRITE, EXT_READ];

class MockBridge implements CapabilityBridge {
  readonly source = "mock";
  getCapabilities(): CapabilityEntry[] {
    return ALL_ENTRIES;
  }
  route(id: CapabilityId) {
    return ALL_ENTRIES.some((e) => e.id === id) ? ("handled" as const) : ("passthrough" as const);
  }
  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    void ctx;
    return { id: req.id, ok: true, output: { ran: req.id }, auditId: "evt_x" };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    createSource: () => ({
      id: "mock",
      label: "Mock",
      transport: "local-rest" as const,
      checkRequirements: async () => ({ ok: true }),
      scan: async () => ALL_ENTRIES,
      start: async () => {},
      stop: async () => {},
    }),
    createBridge: (_deps: BridgeDeps, _sid: string) => new MockBridge(),
  };
  return {
    all: () => [module],
    get: (id) => (id === "mock" ? module : undefined),
    getTransport: (kind: TransportKind) => ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];
let activeKey = "";

/** Build a gateway with the DEFAULT authorizer (UserConfirm) + an injected managed source. */
function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-trust-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of ALL_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  // The default authorizer built inside createAppWithState reads state.managedSources
  // (empty in this fake, since we seed the registry directly rather than via the admin
  // add-source flow), so inject a managed-aware authorizer that knows obsidian-rest is
  // a managed source — matching what the real boot wiring derives.
  const authorizer = defaultAuthorizer({
    managedSources: () => new Set(["obsidian-rest"]),
    defaultTrustWindows: config.auth.defaultTrustWindows,
  });
  const { app, state } = createAppWithState(config, { sources, capabilities, authorizer });
  // Inject the managed-source-id provider AFTER createAppWithState (which wires the
  // registry's posture inputs from the empty fake managedSources). This makes the
  // registry stamp `obsidian-rest` as `managed` — what the real wiring derives from a
  // human-added source. The grant-service / admin views read the registry's stamp.
  capabilities.setPostureInputs({
    managedSourceIds: () => new Set(["obsidian-rest"]),
    defaultTrustWindows: config.auth.defaultTrustWindows,
  });
  activeKey = state.connectionKey.current();
  return { app, state, dir };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
async function handshake(app: ReturnType<typeof freshApp>["app"], state: ReturnType<typeof freshApp>["state"], agentId?: string) {
  const key = state.connectionKey.current();
  const client: Record<string, unknown> = { name: "test" };
  if (agentId) client.agentId = agentId;
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client }),
  });
  return (await res.json()) as HandshakeResponse;
}
async function putGrants(app: ReturnType<typeof freshApp>["app"], sessionId: string, grants: Record<string, unknown>) {
  const res = await req(app, "/grants", { method: "PUT", body: JSON.stringify({ sessionId, grants }) });
  return (await res.json()) as GrantResponse;
}
function invoke(app: ReturnType<typeof freshApp>["app"], token: string, id: string, input?: Record<string, unknown>) {
  return req(app, "/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, ...(input ? { input } : {}) }),
  });
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

// ════════════════════════════════════════════════════════════════════════════
// 1 — PURE posture helpers (3-class provenance, sensitivity, default windows)
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-018: posture derivation helpers", () => {
  it("provenanceFor is 3-class (first-party / managed / extension)", () => {
    const managed = new Set(["obsidian-rest"]);
    expect(provenanceFor("mock", managed)).toBe("first-party"); // reserved id
    expect(provenanceFor("obsidian-rest", managed)).toBe("managed");
    expect(provenanceFor("evil-tool", managed)).toBe("extension");
    expect(provenanceFor("obsidian-rest")).toBe("extension"); // no managed set ⇒ not managed
  });

  it("sensitivityFor: low/elevated/high per derivation", () => {
    expect(sensitivityFor({ ...FP_READ, provenance: "first-party" }, ["read"])).toBe("low");
    expect(sensitivityFor({ ...MANAGED_READ, provenance: "managed" }, ["read"])).toBe("low");
    expect(sensitivityFor({ ...EXT_READ, provenance: "extension" }, ["read"])).toBe("elevated");
    // write on a local-rest transport is high (cli/local-rest write ⇒ high).
    expect(sensitivityFor({ ...FP_WRITE, provenance: "first-party" }, ["write"])).toBe("high");
    expect(sensitivityFor({ ...EXT_READ, provenance: "extension" }, ["write"])).toBe("high");
  });

  it("recommendedTrustWindowFor matches the ratified default table", () => {
    const t = config.auth.defaultTrustWindows;
    expect(recommendedTrustWindowFor("first-party", ["read"], t).kind).toBe("7d");
    expect(recommendedTrustWindowFor("first-party", ["write"], t).kind).toBe("1d");
    expect(recommendedTrustWindowFor("managed", ["read"], t).kind).toBe("7d");
    expect(recommendedTrustWindowFor("managed", ["write"], t).kind).toBe("1d");
    expect(recommendedTrustWindowFor("extension", ["read"], t).kind).toBe("1d");
    expect(recommendedTrustWindowFor("extension", ["write"], t).kind).toBe("once");
  });

  // FIX-2: stampPosture must pass the RESOLVED provenance into sensitivityFor so a
  // managed-source READ stamps `low` (not `elevated` — the bug was the top-level
  // sensitivityFor call seeing the entry as `extension` because the managed set
  // wasn't threaded through).
  it("stampPosture rates managed read low, managed write high, first-party read low", () => {
    const sources = mockRegistry();
    const reg = createCapabilityRegistry(sources);
    for (const e of ALL_ENTRIES)
      (reg as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
    reg.setPostureInputs({
      managedSourceIds: () => new Set(["obsidian-rest"]),
      defaultTrustWindows: config.auth.defaultTrustWindows,
    });

    const managedRead = reg.stampPosture(MANAGED_READ);
    expect(managedRead.provenance).toBe("managed");
    expect(managedRead.sensitivity).toBe("low"); // regression guard for the elevated bug

    const managedWrite = reg.stampPosture(MANAGED_WRITE);
    expect(managedWrite.provenance).toBe("managed");
    expect(managedWrite.sensitivity).toBe("high"); // local-rest write ⇒ high

    const fpRead = reg.stampPosture(FP_READ);
    expect(fpRead.provenance).toBe("first-party");
    expect(fpRead.sensitivity).toBe("low");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — AUTO-ALLOW boundary (managed read auto-allows; extension read pends)
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-018: 3-class auto-allow boundary", () => {
  it("first-party read auto-allows (token minted, window 7d)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-fp");
    const res = await putGrants(app, hs.sessionId, { "mock.note.read": "allow" });
    expect("token" in res).toBe(true);
    const tok = res as ScopedToken;
    expect(tok.scopes).toEqual([{ id: "mock.note.read", verbs: ["read"] }]);
    expect(tok.trustWindow?.kind).toBe("7d");
    expect(tok.grantExpiresAt).toBeDefined();
  });

  it("MANAGED read auto-allows (shares first-party read posture)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-mgd");
    const res = await putGrants(app, hs.sessionId, { "obsidian-rest.vault.read": "allow" });
    expect("token" in res).toBe(true);
    const tok = res as ScopedToken;
    expect(tok.scopes.some((s) => s.id === "obsidian-rest.vault.read")).toBe(true);
    expect(tok.trustWindow?.kind).toBe("7d");
  });

  it("EXTENSION read PENDS (any verb on an extension awaits a human)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-ext");
    const res = (await putGrants(app, hs.sessionId, { "evil-tool.api.read": "allow" })) as GrantPendingResponse;
    expect(res.status).toBe("grant_pending_user");
    expect(res.pending).toContain("evil-tool.api.read");
    // Gateway-authored narration is present + names the verbs/provenance/window.
    expect(res.pendingNarration).toBeDefined();
    const n = res.pendingNarration!.find((p) => p.id === "evil-tool.api.read")!;
    expect(n.provenance).toBe("extension");
    expect(n.defaultTrustWindow.kind).toBe("1d"); // extension read default
    expect(n.summary).toContain("agent-ext");
    expect(n.summary).toContain("revoke");
  });

  it("MANAGED write PENDS (write/exec pends regardless of class)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-mgw");
    const res = (await putGrants(app, hs.sessionId, {
      "obsidian-rest.vault.write": { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    expect(res.status).toBe("grant_pending_user");
    const n = res.pendingNarration!.find((p) => p.id === "obsidian-rest.vault.write")!;
    expect(n.provenance).toBe("managed");
    expect(n.defaultTrustWindow.kind).toBe("1d"); // managed write default
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — "once" semantics: non-renewable, no short-circuit
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-018: once semantics", () => {
  it('a "once" grant persists standing:false (expiresAt = grantedAt) and never re-mints', async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-once");
    // Agent requests read with an advisory "once" window — auto-allows (first-party read),
    // but the window is honored (advisory may shorten the 7d default to once).
    const res = await putGrants(app, hs.sessionId, {
      "mock.note.read": { decision: "allow", verbs: ["read"], trustWindow: { kind: "once" } },
    });
    expect("token" in res).toBe(true);
    const persisted = state.grants.get("agent-once", "mock.note.read")!;
    expect(persisted.standing).toBe(false);
    expect(persisted.trustWindow?.kind).toBe("once");
    expect(persisted.expiresAt).toBe(persisted.grantedAt);
  });

  it('a "once" grant does NOT short-circuit hasPriorApproval (re-request still pends/re-evaluates)', async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-once2");
    // Seed a once grant on an EXTENSION read so a re-request would normally pend.
    // First grant pends (extension), approve it as "once" via admin so standing:false.
    const pend = (await putGrants(app, hs.sessionId, { "evil-tool.api.read": "allow" })) as GrantPendingResponse;
    const approve = await req(app, `/admin/api/pending/${pend.pendingId}`, {
      method: "POST",
      headers: { "X-Plexus-Connection-Key": activeKey },
      body: JSON.stringify({ action: "approve", trustWindow: { kind: "once" } }),
    });
    expect(approve.status).toBe(200);
    const g = state.grants.get("agent-once2", "evil-tool.api.read")!;
    expect(g.standing).toBe(false);
    // A second request must NOT short-circuit on the once grant — it pends again.
    const res2 = (await putGrants(app, hs.sessionId, { "evil-tool.api.read": "allow" })) as GrantPendingResponse;
    expect(res2.status).toBe("grant_pending_user");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3b — resolveWindowExpiry: until-revoked sentinel + custom-ms flooring
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-018: resolveWindowExpiry window resolution", () => {
  const DEFAULT_MAX = config.auth.maxTrustWindowMs; // 30d by default
  const grantedAtMs = Date.parse("2026-06-23T00:00:00.000Z");

  // FIX-1: an `until-revoked` grant is NOT clamped by the custom cap — it gets the
  // far-future sentinel (>365d out) so the ledger renders "until you revoke".
  it("until-revoked uses the far-future sentinel, NOT the custom cap", () => {
    const { expiresAt, standing } = resolveWindowExpiry({ kind: "until-revoked" }, grantedAtMs, DEFAULT_MAX);
    expect(standing).toBe(true);
    const out = Date.parse(expiresAt) - grantedAtMs;
    expect(out).toBe(UNTIL_REVOKED_EXPIRY_MS);
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(yearMs); // far future
  });

  // FIX-3: a non-positive custom.ms is dead-on-arrival — standing:false, not a
  // standing:true grant that is already expired.
  it("custom with ms<=0 floors at 0 and is NOT standing", () => {
    const neg = resolveWindowExpiry({ kind: "custom", ms: -5000 }, grantedAtMs, DEFAULT_MAX);
    expect(neg.standing).toBe(false);
    expect(Date.parse(neg.expiresAt)).toBe(grantedAtMs); // floored at grantedAt

    const zero = resolveWindowExpiry({ kind: "custom", ms: 0 }, grantedAtMs, DEFAULT_MAX);
    expect(zero.standing).toBe(false);
    expect(Date.parse(zero.expiresAt)).toBe(grantedAtMs);
  });

  it("custom with positive ms stands and is clamped to the max", () => {
    const ok = resolveWindowExpiry({ kind: "custom", ms: 60_000 }, grantedAtMs, DEFAULT_MAX);
    expect(ok.standing).toBe(true);
    expect(Date.parse(ok.expiresAt) - grantedAtMs).toBe(60_000);
    // A custom ms above the cap is clamped (still standing).
    const clamped = resolveWindowExpiry({ kind: "custom", ms: DEFAULT_MAX * 10 }, grantedAtMs, DEFAULT_MAX);
    expect(clamped.standing).toBe(true);
    expect(Date.parse(clamped.expiresAt) - grantedAtMs).toBe(DEFAULT_MAX);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 — anon:* cap (no durable standing grant)
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-018: anon cap", () => {
  it("an anon agent (no client.agentId) gets a once-capped grant (standing:false)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state); // no agentId ⇒ anon:<session>
    const res = await putGrants(app, hs.sessionId, { "mock.note.read": "allow" });
    expect("token" in res).toBe(true);
    const tok = res as ScopedToken;
    // The window the gateway issued for an anon agent is once.
    expect(tok.trustWindow?.kind).toBe("once");
    // The persisted grant is non-standing (no durable standing trust for anon).
    const grants = state.grants.all().filter((g) => g.capabilityId === "mock.note.read");
    expect(grants.length).toBe(1);
    expect(grants[0]!.agentId.startsWith("anon:")).toBe(true);
    expect(grants[0]!.standing).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5 — GET /grants listing (session-auth, like /manifest)
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-018: GET /grants standing-grant ledger", () => {
  it("lists the caller's standing grants with provenance + trust-window", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-list");
    await putGrants(app, hs.sessionId, { "mock.note.read": "allow" });
    await putGrants(app, hs.sessionId, { "obsidian-rest.vault.read": "allow" });

    const res = await req(app, "/grants", { headers: { "X-Plexus-Session": hs.sessionId } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GrantsListResponse;
    const ids = body.grants.map((g) => g.capabilityId).sort();
    expect(ids).toContain("mock.note.read");
    expect(ids).toContain("obsidian-rest.vault.read");
    const fp = body.grants.find((g: StandingGrant) => g.capabilityId === "mock.note.read")!;
    expect(fp.provenance).toBe("first-party");
    expect(fp.standing).toBe(true);
    expect(fp.trustWindow.kind).toBe("7d");
    const mgd = body.grants.find((g: StandingGrant) => g.capabilityId === "obsidian-rest.vault.read")!;
    expect(mgd.provenance).toBe("managed");
  });

  it("GET /grants without a session header is rejected", async () => {
    const { app } = freshApp();
    const res = await req(app, "/grants");
    expect(res.status).toBe(401);
  });

  it("the admin grants ledger (GET /api/grants) lists all standing grants", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state, "agent-admin-list");
    await putGrants(app, hs.sessionId, { "mock.note.read": "allow" });
    const res = await req(app, "/admin/api/grants", { headers: { "X-Plexus-Connection-Key": activeKey } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GrantsListResponse;
    expect(body.grants.some((g) => g.agentId === "agent-admin-list" && g.capabilityId === "mock.note.read")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6 — admin TARGET-AGENT grant pre-authorizes the REAL agent (decoy fix)
// ════════════════════════════════════════════════════════════════════════════
describe("ADR-018: admin target-agent grant (decoy fix)", () => {
  it("an admin PUT /api/grants under a real agentId pre-authorizes that agent's next request", async () => {
    const { app, state } = freshApp();
    // Admin grants WRITE on a first-party cap to the REAL agent "plexus-cli" (would
    // normally pend on the agent's own PUT, but the human is granting it here).
    const adminRes = await req(app, "/admin/api/grants", {
      method: "PUT",
      headers: { "X-Plexus-Connection-Key": activeKey },
      body: JSON.stringify({
        agentId: "plexus-cli",
        trustWindow: { kind: "1d" },
        grants: { "mock.note.write": { decision: "allow", verbs: ["write"] } },
      }),
    });
    expect(adminRes.status).toBe(200);

    // The grant is persisted under the REAL agent (NOT plexus-admin).
    const g = state.grants.get("plexus-cli", "mock.note.write");
    expect(g).toBeDefined();
    expect(g!.standing).toBe(true);
    expect(g!.trustWindow?.kind).toBe("1d");
    expect(state.grants.get("plexus-admin", "mock.note.write")).toBeUndefined();

    // The real agent handshakes as plexus-cli; its write request now AUTO-ALLOWS
    // (hasPriorApproval short-circuits) — true pre-authorization, no pend.
    const hs = await handshake(app, state, "plexus-cli");
    const res = await putGrants(app, hs.sessionId, {
      "mock.note.write": { decision: "allow", verbs: ["write"] },
    });
    expect("token" in res).toBe(true);
    const tok = res as ScopedToken;
    expect(tok.scopes.some((s) => s.id === "mock.note.write" && s.verbs.includes("write"))).toBe(true);
    const ok = await invoke(app, tok.token, "mock.note.write");
    expect(ok.status).toBe(200);
  });
});
