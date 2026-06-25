/**
 * P1 — LRA v1 thin endpoints + the management event stream (REDESIGN-ARCHITECTURE
 * §2.2–§2.4, PLAN P1). ADDITIVE backend work; the frozen agent wire is untouched.
 *
 * Asserts:
 *   - the 3 NEW management events fire at the right sites:
 *       · pending_added       — on a PUT /grants that PENDS,
 *       · pending_resolved    — on admin approve/deny,
 *       · audit_appended      — on every audit.write (projection, redaction-safe);
 *   - the agent `GET /events` stream FILTERS OUT the management-only variants;
 *   - GET /v1/events streams those events (management-key gated; no key → 401);
 *   - GET /v1/health → {ok:true}; GET /v1/status composes counts + the bound port;
 *   - GET /v1/config reads + PUT /v1/config writes (clamped) auth-config fields;
 *   - POST /v1/connection-key/rotate rotates the key (+ drops sessions/tokens);
 *   - .well-known reports the ACTUAL bound port (boundPort reconciliation);
 *   - /admin/api/* still works, AND /v1/admin/api/* is a working alias.
 *
 * Driven through the published wire + the admin pending channel — no fake-green.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
  PlexusEvent,
  WellKnownDocument,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";
import { setBoundPort } from "@plexus/runtime/core/state.ts";

// A managed-source WRITE — always PENDS under the default authorizer (the human surface).
const MANAGED_WRITE: CapabilityEntry = {
  id: "obsidian-rest.vault.write",
  source: "obsidian-rest",
  kind: "capability",
  label: "Write the Obsidian vault (REST)",
  describe: "Write a vault note over the local REST API.",
  grants: ["write"],
  transport: "local-rest",
};
const ALL_ENTRIES = [MANAGED_WRITE];

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

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-p1-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of ALL_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  const authorizer = defaultAuthorizer({
    managedSources: () => new Set(["obsidian-rest"]),
    defaultTrustWindows: config.auth.defaultTrustWindows,
  });
  const { app, state } = createAppWithState(config, { sources, capabilities, authorizer });
  capabilities.setPostureInputs({
    managedSourceIds: () => new Set(["obsidian-rest"]),
    defaultTrustWindows: config.auth.defaultTrustWindows,
  });
  return { app, state, dir };
}

type App = ReturnType<typeof freshApp>["app"];
type State = ReturnType<typeof freshApp>["state"];

function req(app: App, path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
function keyReq(app: App, state: State, path: string, init?: RequestInit) {
  return req(app, path, {
    ...init,
    headers: { "X-Plexus-Connection-Key": state.connectionKey.current(), ...(init?.headers ?? {}) },
  });
}
async function handshake(app: App, state: State): Promise<HandshakeResponse> {
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: state.connectionKey.current(), client: { name: "agent-x", agentId: "agent-x" } }),
  });
  return (await res.json()) as HandshakeResponse;
}
async function putGrants(app: App, sessionId: string, grants: Record<string, unknown>): Promise<GrantResponse> {
  const res = await req(app, "/grants", { method: "PUT", body: JSON.stringify({ sessionId, grants }) });
  return (await res.json()) as GrantResponse;
}
/** Collect events the EventBus publishes during `fn` (in-process subscriber). */
async function captureEvents(state: State, fn: () => Promise<void>): Promise<PlexusEvent[]> {
  const seen: PlexusEvent[] = [];
  const unsub = state.events.subscribe((e) => seen.push(e));
  try {
    await fn();
  } finally {
    unsub();
  }
  return seen;
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
// The 3 NEW management events fire at the right sites
// ════════════════════════════════════════════════════════════════════════════
describe("P1: management events fire at the right sites", () => {
  it("audit_appended fires on every audit.write (handshake) carrying id/type/at", async () => {
    const { app, state } = freshApp();
    const events = await captureEvents(state, async () => {
      await handshake(app, state);
    });
    const audit = events.filter((e) => e.type === "audit_appended");
    expect(audit.length).toBeGreaterThan(0);
    const ev = audit.find((e) => e.type === "audit_appended" && e.auditType === "handshake");
    expect(ev).toBeDefined();
    if (ev && ev.type === "audit_appended") {
      expect(typeof ev.id).toBe("string");
      expect(ev.id.startsWith("evt_")).toBe(true);
      expect(typeof ev.at).toBe("string");
      // Redaction-safe projection: it must NOT carry the raw audit `detail` blob.
      expect((ev as unknown as Record<string, unknown>).detail).toBeUndefined();
    }
  });

  it("pending_added fires on a PUT /grants that PENDS (carries narration)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    let resp!: GrantResponse;
    const events = await captureEvents(state, async () => {
      resp = await putGrants(app, hs.sessionId, { "obsidian-rest.vault.write": { decision: "allow", verbs: ["write"] } });
    });
    expect((resp as GrantPendingResponse).status).toBe("grant_pending_user");
    const added = events.filter((e): e is Extract<PlexusEvent, { type: "pending_added" }> => e.type === "pending_added");
    expect(added.length).toBe(1);
    const item = added[0]!.item;
    expect(item.kind).toBe("grant");
    expect(item.agentId).toBe("agent-x");
    expect(item.capabilities).toContain("obsidian-rest.vault.write");
    expect(item.pendingNarration?.length).toBeGreaterThan(0);
    expect(item.pendingId).toBe((resp as GrantPendingResponse).pendingId);
  });

  it("pending_resolved fires on admin approve", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const resp = (await putGrants(app, hs.sessionId, {
      "obsidian-rest.vault.write": { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    const pendingId = resp.pendingId;
    const events = await captureEvents(state, async () => {
      const r = await keyReq(app, state, `/admin/api/pending/${pendingId}`, {
        method: "POST",
        body: JSON.stringify({ action: "approve", agentId: "agent-x", trustWindow: { kind: "1d" } }),
      });
      expect(r.status).toBe(200);
    });
    const resolved = events.filter((e): e is Extract<PlexusEvent, { type: "pending_resolved" }> => e.type === "pending_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.pendingId).toBe(pendingId);
    expect(resolved[0]!.kind).toBe("grant");
    expect(resolved[0]!.decision).toBe("approved");
  });

  it("pending_resolved fires on admin deny", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const resp = (await putGrants(app, hs.sessionId, {
      "obsidian-rest.vault.write": { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    const events = await captureEvents(state, async () => {
      const r = await keyReq(app, state, `/admin/api/pending/${resp.pendingId}`, {
        method: "POST",
        body: JSON.stringify({ action: "deny", reason: "no" }),
      });
      expect(r.status).toBe(200);
    });
    const resolved = events.filter((e): e is Extract<PlexusEvent, { type: "pending_resolved" }> => e.type === "pending_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.decision).toBe("denied");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The agent `GET /events` stream FILTERS OUT the management-only variants
// ════════════════════════════════════════════════════════════════════════════
describe("P1: agent /events filters out the management-only variants", () => {
  it("an audit_appended published while an agent stream is open is NOT delivered to it", async () => {
    const { app, state } = freshApp();
    const res = await req(app, "/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    // Read the opening comment frame.
    await reader.read();
    // Publish one of each: a management-only event + an agent event.
    state.events.publish({ type: "audit_appended", id: "evt_probe", auditType: "handshake", at: new Date().toISOString() });
    state.events.publish({ type: "manifest_changed", revision: 99 });
    // Read the next frame — it must be the agent event, never the audit one.
    const chunk = await reader.read();
    const text = chunk.value ? dec.decode(chunk.value) : "";
    expect(text).toContain("manifest_changed");
    expect(text).not.toContain("audit_appended");
    await reader.cancel();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/events — the MANAGEMENT SSE stream (gated; streams the new events)
// ════════════════════════════════════════════════════════════════════════════
describe("P1: GET /v1/events (management SSE — gated)", () => {
  it("no key → 401", async () => {
    const { app } = freshApp();
    const res = await req(app, "/v1/events");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("with key → streams a pending_added event (an actual SSE probe)", async () => {
    const { app, state } = freshApp();
    const res = await keyReq(app, state, "/v1/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // opening comment frame

    // Drive a real pending grant through the wire so the stream emits pending_added.
    const hs = await handshake(app, state);
    void putGrants(app, hs.sessionId, { "obsidian-rest.vault.write": { decision: "allow", verbs: ["write"] } });

    // Read frames until we see pending_added (audit_appended frames may arrive first).
    let buf = "";
    let sawPendingAdded = false;
    for (let i = 0; i < 12 && !sawPendingAdded; i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += chunk.value ? dec.decode(chunk.value) : "";
      if (buf.includes("pending_added")) sawPendingAdded = true;
    }
    expect(sawPendingAdded).toBe(true);
    expect(buf).toContain("obsidian-rest.vault.write");
    await reader.cancel();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/health + GET /v1/status
// ════════════════════════════════════════════════════════════════════════════
describe("P1: /v1/health + /v1/status", () => {
  it("GET /v1/health → {ok:true} (loopback, no key needed)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/v1/health");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it("GET /v1/status composes versions + counts + the bound port", async () => {
    const { app, state } = freshApp();
    setBoundPort(state, 65432); // simulate the post-listen ephemeral bound port
    const res = await req(app, "/v1/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lraVersion: string; protocolVersion: string; runtimeVersion: string;
      pid: number; port: number; uptime: number;
      counts: { sources: number; capabilities: number; grants: number; pending: number; sessions: number };
    };
    expect(body.lraVersion).toBe("1.0");
    expect(typeof body.protocolVersion).toBe("string");
    expect(typeof body.runtimeVersion).toBe("string");
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBe(65432); // the ACTUAL bound port, not config.port
    expect(typeof body.uptime).toBe("number");
    expect(body.counts.capabilities).toBe(1);
    expect(body.counts.pending).toBe(0);
  });

  it("GET /v1/status pending count reflects a live pending grant", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    await putGrants(app, hs.sessionId, { "obsidian-rest.vault.write": { decision: "allow", verbs: ["write"] } });
    const res = await req(app, "/v1/status");
    const body = (await res.json()) as { counts: { pending: number } };
    expect(body.counts.pending).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET/PUT /v1/config
// ════════════════════════════════════════════════════════════════════════════
describe("P1: /v1/config (read + write, clamped)", () => {
  it("GET /v1/config returns the auth-config fields + bounds", async () => {
    const { app } = freshApp();
    const res = await req(app, "/v1/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokenLifetimeMs: number; tokenLifetimeBounds: { minMs: number; maxMs: number };
      maxTrustWindowMs: number; allowUntilRevoked: boolean;
      defaultTrustWindows: Record<string, string>;
    };
    expect(typeof body.tokenLifetimeMs).toBe("number");
    expect(typeof body.allowUntilRevoked).toBe("boolean");
    expect(body.defaultTrustWindows["extension:write"]).toBeDefined();
  });

  it("PUT /v1/config without a key → 401", async () => {
    const { app } = freshApp();
    const res = await req(app, "/v1/config", { method: "PUT", body: JSON.stringify({ tokenLifetimeMs: 120000 }) });
    expect(res.status).toBe(401);
  });

  it("PUT /v1/config clamps tokenLifetimeMs + writes auth-config.json + persists the table", async () => {
    const { app, state, dir } = freshApp();
    // 9_999_999 is above the 60-min ceiling → clamped to TOKEN_LIFETIME_MAX_MS (3_600_000).
    const res = await keyReq(app, state, "/v1/config", {
      method: "PUT",
      body: JSON.stringify({
        tokenLifetimeMs: 9_999_999,
        allowUntilRevoked: false,
        defaultTrustWindows: { "extension:write": "1h", "bogus:key": "nope" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      config: { tokenLifetimeMs: number; allowUntilRevoked: boolean; defaultTrustWindows: Record<string, string> };
    };
    expect(body.ok).toBe(true);
    expect(body.config.tokenLifetimeMs).toBe(3_600_000); // clamped to the ceiling
    expect(body.config.allowUntilRevoked).toBe(false);
    expect(body.config.defaultTrustWindows["extension:write"]).toBe("1h"); // valid kind accepted
    expect((body.config.defaultTrustWindows as Record<string, string>)["bogus:key"]).toBeUndefined();

    // It actually wrote ~/.plexus/auth-config.json with the clamped values.
    const onDisk = JSON.parse(readFileSync(join(dir, "auth-config.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk.tokenLifetimeMs).toBe(3_600_000);
    expect(onDisk.allowUntilRevoked).toBe(false);
    expect((onDisk.defaultTrustWindows as Record<string, string>)["extension:write"]).toBe("1h");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/connection-key/rotate
// ════════════════════════════════════════════════════════════════════════════
describe("P1: POST /v1/connection-key/rotate", () => {
  it("without a key → 401", async () => {
    const { app } = freshApp();
    const res = await req(app, "/v1/connection-key/rotate", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("with the key → rotates to a new key + bumps the epoch", async () => {
    const { app, state } = freshApp();
    const before = state.connectionKey.current();
    const epochBefore = state.connectionKey.epoch();
    const res = await keyReq(app, state, "/v1/connection-key/rotate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; connectionKey: string; epoch: number };
    expect(body.ok).toBe(true);
    expect(body.connectionKey).not.toBe(before);
    expect(body.connectionKey).toBe(state.connectionKey.current());
    expect(body.epoch).toBe(epochBefore + 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// .well-known reports the ACTUAL bound port (REDESIGN §3.4 reconciliation)
// ════════════════════════════════════════════════════════════════════════════
describe("P1: .well-known reconciles to the bound port", () => {
  it("baseUrl + auth endpoint URLs report the bound port, not config.port", async () => {
    const { app, state } = freshApp();
    setBoundPort(state, 54321);
    const res = await req(app, "/.well-known/plexus");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as WellKnownDocument;
    expect(doc.gateway.baseUrl).toContain(":54321");
    expect(doc.auth.handshakeUrl).toContain(":54321");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /admin/api/* still works + /v1/admin/api/* alias works
// ════════════════════════════════════════════════════════════════════════════
describe("P1: /admin/api/* alias under /v1", () => {
  it("GET /admin/api/capabilities still works (existing path, key-gated)", async () => {
    const { app, state } = freshApp();
    // FEAT configurable-binding re-gating: /admin/api/* reads are now key-gated.
    const res = await keyReq(app, state, "/admin/api/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: CapabilityEntry[] };
    expect(body.entries.some((e) => e.id === "obsidian-rest.vault.write")).toBe(true);
  });

  it("GET /v1/admin/api/capabilities is a working alias (key-gated)", async () => {
    const { app, state } = freshApp();
    const res = await keyReq(app, state, "/v1/admin/api/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: CapabilityEntry[] };
    expect(body.entries.some((e) => e.id === "obsidian-rest.vault.write")).toBe(true);
  });

  it("a mutating /v1/admin/api/* route is management-key gated (alias keeps the gate)", async () => {
    const { app, state } = freshApp();
    // No key → 401 (the admin mutating-route guard runs inside the aliased sub-app).
    const noKey = await req(app, "/v1/admin/api/grants", { method: "PUT", body: JSON.stringify({ grants: {} }) });
    expect(noKey.status).toBe(401);
    // With key → 200 (empty grant set is a valid no-op token issuance).
    const withKey = await keyReq(app, state, "/v1/admin/api/grants", { method: "PUT", body: JSON.stringify({ grants: {} }) });
    expect(withKey.status).toBe(200);
  });
});
