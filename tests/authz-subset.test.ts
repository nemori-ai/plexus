/**
 * AUTHORIZED SUBSET (`docs/design/agent-authorized-subset.md`) — the owner declares each
 * agent's authorized capability subset at connect, and the agent sees + uses only that.
 *
 * This file grows with the implementation slices:
 *   S1 — connect writes the per-agent subset record (+ standingExecute); revoke&delete drops it.
 *   S2 — the discovered manifest is scoped to the subset (record present ⇒ enforce).
 *   S3 — a `PUT /grants` outside the subset is DENIED (not pended).
 *   S4 — `.well-known` no longer advertises the capability catalog.
 *
 * MIGRATION posture: an agent with NO subset record is UN-SCOPED — legacy behavior is
 * preserved unchanged. Every new connect writes a record.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { createAgentSubsetStore } from "@plexus/runtime/core/agent-subset.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

const READ_ENTRY: CapabilityEntry = {
  id: "mock.doc.read",
  source: "mock",
  kind: "capability",
  label: "Read a mock doc",
  describe: "Read a doc.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["read"],
  transport: "local-rest",
};
const WRITE_ENTRY: CapabilityEntry = {
  id: "mock.doc.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock doc",
  describe: "Write a doc.",
  grants: ["write"],
  transport: "local-rest",
};
const EXECUTE_ENTRY: CapabilityEntry = {
  id: "mock.script.run",
  source: "mock",
  kind: "capability",
  label: "Run a mock script",
  describe: "Execute a script.",
  grants: ["execute"],
  transport: "cli",
};
const SECRET_ENTRY: CapabilityEntry = {
  id: "mock.secret.read",
  source: "mock",
  kind: "capability",
  label: "Read the mock secret",
  describe: "Read a secret the owner did NOT authorize this agent for.",
  io: { input: { type: "object", properties: {}, required: [] } },
  grants: ["read"],
  transport: "local-rest",
};
// A read-as-context SKILL attached to READ_ENTRY (zero authority; teaches its use).
const SKILL_ENTRY: CapabilityEntry = {
  id: "mock.doc.how-to",
  source: "mock",
  kind: "skill",
  label: "How to read a mock doc",
  describe: "Guidance for using mock.doc.read.",
  grants: ["read"],
  transport: "local-rest",
};
// A standalone skill attached to nothing the agent will be authorized for.
const ORPHAN_SKILL_ENTRY: CapabilityEntry = {
  id: "mock.secret.how-to",
  source: "mock",
  kind: "skill",
  label: "How to read the secret",
  describe: "Guidance for a capability the agent is NOT authorized for.",
  grants: ["read"],
  transport: "local-rest",
};
// Attach the skill to READ_ENTRY (a capability references the skills that teach its use).
READ_ENTRY.skills = [{ id: SKILL_ENTRY.id, label: SKILL_ENTRY.label }];
const MOCK_ENTRIES = [
  READ_ENTRY,
  WRITE_ENTRY,
  EXECUTE_ENTRY,
  SECRET_ENTRY,
  SKILL_ENTRY,
  ORPHAN_SKILL_ENTRY,
];

class MockBridge implements CapabilityBridge {
  readonly source = "mock";
  constructor(
    private readonly deps: BridgeDeps,
    private readonly sessionId: string,
  ) {}
  getCapabilities(): CapabilityEntry[] {
    return MOCK_ENTRIES;
  }
  route(id: CapabilityId) {
    return MOCK_ENTRIES.some((e) => e.id === id) ? ("handled" as const) : ("passthrough" as const);
  }
  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const entry = this.deps.getEntry(req.id)!;
    const audit = await this.deps.audit({
      type: "invoke",
      agentId: ctx.agentId ?? "",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: "ok",
      detail: { transport: entry.transport },
    });
    return { id: entry.id, ok: true, output: { echoed: req.input ?? {} }, auditId: audit.id };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    createSource: () => {
      throw new Error("scan not used in these tests");
    },
    createBridge: (deps: BridgeDeps, sessionId: string) => new MockBridge(deps, sessionId),
  };
  return {
    all: () => [module],
    get: (id) => (id === "mock" ? module : undefined),
    getTransport: (kind: TransportKind) =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const config = loadConfig();
const HOST = expectedHost(config);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plexus-subset-"));
  process.env.PLEXUS_HOME = home;
});
afterEach(() => {
  delete process.env.PLEXUS_HOME;
  rmSync(home, { recursive: true, force: true });
});

function freshApp() {
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  return createAppWithState(config, { sources, capabilities });
}

type App = ReturnType<typeof freshApp>["app"];

function req(app: App, path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function connect(
  app: App,
  key: string,
  agentId: string,
  capabilities: string[],
  extra: Record<string, unknown> = {},
) {
  const res = await req(app, "/admin/api/agents/connect", {
    method: "POST",
    headers: { "x-plexus-connection-key": key },
    body: JSON.stringify({ agentId, capabilities, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function enroll(app: App, code: string): Promise<string> {
  const res = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) });
  const body = (await res.json()) as { pat?: string };
  if (!body.pat) throw new Error(`enroll failed: ${JSON.stringify(body)}`);
  return body.pat;
}

async function handshake(app: App, pat: string) {
  const res = await req(app, "/link/handshake", {
    method: "POST",
    headers: { authorization: `Bearer ${pat}` },
    body: JSON.stringify({ client: { name: "cc" } }),
  });
  return { status: res.status, body: (await res.json()) as HandshakeResponse };
}

async function putGrant(app: App, sessionId: string, capId: string) {
  const res = await req(app, "/grants", {
    method: "PUT",
    headers: { "x-plexus-session": sessionId },
    body: JSON.stringify({ grants: { [capId]: "allow" } }),
  });
  return (await res.json()) as any;
}

// ── S1 — the store itself ─────────────────────────────────────────────────────
describe("S1 — AgentSubsetStore", () => {
  it("an unset agent is UN-SCOPED (legacy); nothing is authorized", () => {
    const store = createAgentSubsetStore();
    expect(store.isScoped("nobody")).toBe(false);
    expect(store.get("nobody")).toBeUndefined();
    expect(store.isAuthorized("nobody", "mock.doc.read")).toBe(false);
  });

  it("set records the subset; standingExecute is intersected with the subset", () => {
    const store = createAgentSubsetStore();
    // standingExecute lists a cap NOT in `capabilities` — it must be dropped.
    store.set("agent-A", ["mock.doc.read", "mock.script.run"], ["mock.script.run", "not.in.subset"]);
    expect(store.isScoped("agent-A")).toBe(true);
    expect(store.isAuthorized("agent-A", "mock.doc.read")).toBe(true);
    expect(store.isAuthorized("agent-A", "mock.script.run")).toBe(true);
    expect(store.isAuthorized("agent-A", "mock.doc.write")).toBe(false);
    expect(store.isStandingExecute("agent-A", "mock.script.run")).toBe(true);
    expect(store.isStandingExecute("agent-A", "not.in.subset")).toBe(false);
  });

  it("set REPLACES (not merges) an agent's subset, and persists across a reload", () => {
    const store = createAgentSubsetStore();
    store.set("agent-A", ["mock.doc.read", "mock.doc.write"]);
    store.set("agent-A", ["mock.script.run"]); // replace
    expect(store.get("agent-A")?.capabilities).toEqual(["mock.script.run"]);
    // A fresh store over the SAME home reads back the persisted record.
    const reloaded = createAgentSubsetStore();
    expect(reloaded.get("agent-A")?.capabilities).toEqual(["mock.script.run"]);
  });

  it("remove drops the record entirely", () => {
    const store = createAgentSubsetStore();
    store.set("agent-A", ["mock.doc.read"]);
    expect(store.remove("agent-A")).toBe(true);
    expect(store.isScoped("agent-A")).toBe(false);
    expect(store.remove("agent-A")).toBe(false); // idempotent
  });
});

// ── S1 — connect writes the subset ─────────────────────────────────────────────
describe("S1 — connect declares the authorized subset", () => {
  it("connect persists the selected caps as the agent's subset", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read", "mock.doc.write", "mock.script.run"]);
    const sub = state.agentSubsets.get("agent-A");
    expect(sub).toBeDefined();
    expect(new Set(sub!.capabilities)).toEqual(
      new Set(["mock.doc.read", "mock.doc.write", "mock.script.run"]),
    );
    expect(sub!.standingExecute).toEqual([]);
  });

  it("connect records standingExecute (intersected with the subset)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read", "mock.script.run"], {
      standingExecute: ["mock.script.run", "mock.doc.write"], // write is NOT in the subset → dropped
    });
    const sub = state.agentSubsets.get("agent-A")!;
    expect(sub.standingExecute).toEqual(["mock.script.run"]);
  });

  it("an empty selection still SCOPES the agent (authorized-nothing world)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-empty", []);
    expect(state.agentSubsets.isScoped("agent-empty")).toBe(true);
    expect(state.agentSubsets.get("agent-empty")!.capabilities).toEqual([]);
  });

  it("S2: a scoped agent's handshake manifest is its subset only (never the full catalog)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.read", "mock.doc.write"]);
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    expect(hs.status).toBe(200);
    const ids = new Set(hs.body.manifest.entries.map((e) => e.id));
    // read + write, PLUS the skill attached to the authorized read (read-as-context rides along).
    expect(ids).toEqual(new Set(["mock.doc.read", "mock.doc.write", "mock.doc.how-to"]));
    // The execute + the un-authorized secret cap are INVISIBLE — the agent never learns they exist.
    expect(ids.has("mock.script.run")).toBe(false);
    expect(ids.has("mock.secret.read")).toBe(false);
    // A skill attached to a NON-authorized capability is likewise invisible (no leak).
    expect(ids.has("mock.secret.how-to")).toBe(false);
  });

  it("S2: an attached skill is INVISIBLE when its capability is NOT in the subset", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // Authorize only the WRITE cap — the read (which carries the skill) is NOT authorized.
    const { body: conn } = await connect(app, key, "agent-w", ["mock.doc.write"]);
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    const ids = new Set(hs.body.manifest.entries.map((e) => e.id));
    expect(ids).toEqual(new Set(["mock.doc.write"]));
    // The skill rides ONLY with its authorized capability — read isn't authorized, so it's hidden.
    expect(ids.has("mock.doc.how-to")).toBe(false);
  });

  it("S2: an execute cap IN the subset IS discoverable (per-use, but visible)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-exec", ["mock.script.run"]);
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    const ids = new Set(hs.body.manifest.entries.map((e) => e.id));
    expect(ids).toEqual(new Set(["mock.script.run"]));
  });

  it("S2: the admin/management handshake is UN-SCOPED — it still sees the full exposed set", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const res = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({ connectionKey: key, client: { name: "mgmt" } }),
    });
    const body = (await res.json()) as HandshakeResponse;
    const ids = new Set(body.manifest.entries.map((e) => e.id));
    expect(ids).toEqual(new Set(MOCK_ENTRIES.map((e) => e.id)));
  });

  it("S3: a PUT /grants for a cap OUTSIDE the subset is DENIED (no token scopes, no pending)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.read"]);
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    // The agent (or an attacker holding its session) probes a capability it was never authorized.
    const res = await putGrant(app, hs.body.sessionId, "mock.secret.read");
    // Not pended — no owner card is raised for an out-of-subset request.
    expect(res.status).not.toBe("grant_pending_user");
    // And no authority is minted (empty scopes) — the deny leaves it with nothing.
    expect(res.scopes ?? []).toEqual([]);
    // The persisted subset is untouched — a probe can never grow the agent's world.
    expect(state.agentSubsets.isAuthorized("agent-A", "mock.secret.read")).toBe(false);
    expect(state.grants.get("agent-A", "mock.secret.read")).toBeUndefined();
  });

  it("S3: an owner-issued STANDING grant OUTSIDE the explicit subset is visible + usable (no dead grant)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // Connect agent-A scoped to ONLY the read cap.
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.read"]);
    // The OWNER later grants an ADDITIONAL standing write cap via the inline picker (not a re-connect,
    // so the explicit subset is NOT updated). This must not become an invisible, dead grant.
    const adminGrant = await req(app, "/admin/api/grants", {
      method: "PUT",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: "agent-A", grants: { "mock.doc.write": "allow" }, trustWindow: { kind: "7d" } }),
    });
    expect(adminGrant.status).toBe(200);
    expect(state.grants.get("agent-A", "mock.doc.write")?.standing).toBe(true);

    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    // VISIBLE: the manifest carries the owner-granted write cap even though it isn't in the subset.
    const ids = new Set(hs.body.manifest.entries.map((e) => e.id));
    expect(ids.has("mock.doc.write")).toBe(true);
    // USABLE: the agent's PUT /grants for it short-circuits (not denied by the subset gate).
    const res = await putGrant(app, hs.body.sessionId, "mock.doc.write");
    expect(res.status).not.toBe("grant_pending_user");
    expect(typeof res.token).toBe("string");
    // But a cap with NO grant and NOT in the subset stays invisible + denied.
    expect(ids.has("mock.secret.read")).toBe(false);
    const denied = await putGrant(app, hs.body.sessionId, "mock.secret.read");
    expect(denied.scopes ?? []).toEqual([]);
  });

  it("S3: an IN-subset read short-circuits to a token (connect made it standing)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.read"]);
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    const res = await putGrant(app, hs.body.sessionId, "mock.doc.read");
    expect(res.status).not.toBe("grant_pending_user");
    expect(typeof res.token).toBe("string");
  });

  it("S3: an IN-subset execute PENDS per-use (visible + grantable, but not standing)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-exec", ["mock.script.run"]);
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    const res = await putGrant(app, hs.body.sessionId, "mock.script.run");
    // In-subset ⇒ NOT denied; execute ⇒ per-use pend (not a standing short-circuit).
    expect(res.status).toBe("grant_pending_user");
    expect(res.token).toBeUndefined();
  });

  it("S3: an UN-scoped (legacy) agent is NOT subset-gated — first-party read still auto-allows", async () => {
    // A legacy agent has no subset record: write one directly via enrollment + a PAT the OLD way.
    // Simplest proxy: an agent whose subset record we remove after connect behaves as legacy.
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-legacy", ["mock.doc.read"]);
    state.agentSubsets.remove("agent-legacy"); // simulate a pre-existing (un-migrated) agent
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    // With no subset record, the confirm-risky authorizer auto-allows a first-party read on request.
    const res = await putGrant(app, hs.body.sessionId, "mock.secret.read");
    expect(res.status).not.toBe("grant_pending_user");
    expect(typeof res.token).toBe("string");
  });

  it("S6: an EXECUTE cap opted into standingExecute becomes a STANDING grant at connect", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { status, body } = await connect(app, key, "agent-exec", ["mock.script.run"], {
      standingExecute: ["mock.script.run"],
      trustWindow: { kind: "7d" },
    });
    expect(status).toBe(200);
    // Opted in ⇒ it stands (appears under `granted`, NOT `skipped`).
    expect(body.granted.map((g: any) => g.capabilityId)).toContain("mock.script.run");
    expect(body.skipped).not.toContain("mock.script.run");
    const g = state.grants.get("agent-exec", "mock.script.run");
    expect(g?.standing).toBe(true);
  });

  it("S6: WITHOUT the opt-in an execute cap stays per-use (unchanged ADR-5 default)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body } = await connect(app, key, "agent-exec2", ["mock.script.run"], {
      trustWindow: { kind: "7d" }, // even an admin 7d must NOT make an un-opted execute standing
    });
    expect(body.granted.map((g: any) => g.capabilityId)).not.toContain("mock.script.run");
    expect(body.skipped).toContain("mock.script.run");
    expect(state.grants.get("agent-exec2", "mock.script.run")).toBeUndefined();
  });

  it("S6: the agent's PUT /grants for an OPTED execute short-circuits (no pend, standing token)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-exec", ["mock.script.run"], {
      standingExecute: ["mock.script.run"],
    });
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    const res = await putGrant(app, hs.body.sessionId, "mock.script.run");
    // Opted standing ⇒ the standing grant short-circuits approval — a token, not a per-use pend.
    expect(res.status).not.toBe("grant_pending_user");
    expect(typeof res.token).toBe("string");
  });

  it("S5: GET /admin/api/exposure carries defaultGrant; POST /default-grant/:id toggles + persists", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const expo = async () =>
      (
        (await (
          await req(app, "/admin/api/exposure", { headers: { "x-plexus-connection-key": key } })
        ).json()) as { capabilities: { id: string; enabled: boolean; defaultGrant: boolean }[] }
      ).capabilities;

    // Default: nothing is pre-checked.
    let caps = await expo();
    expect(caps.find((c) => c.id === "mock.doc.read")!.defaultGrant).toBe(false);

    // Mark mock.doc.read as default-grant.
    const set = await req(app, "/admin/api/default-grant/mock.doc.read", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ defaultGrant: true }),
    });
    expect(set.status).toBe(200);
    expect(state.defaultGrants.isDefaultGrant("mock.doc.read")).toBe(true);

    // The exposure list now reflects it, orthogonal to `enabled`.
    caps = await expo();
    const row = caps.find((c) => c.id === "mock.doc.read")!;
    expect(row.defaultGrant).toBe(true);
    expect(row.enabled).toBe(true);
  });

  it("S5: default-grant is management-gated + rejects a non-boolean", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // No key → 401.
    const noKey = await req(app, "/admin/api/default-grant/mock.doc.read", {
      method: "POST",
      body: JSON.stringify({ defaultGrant: true }),
    });
    expect(noKey.status).toBe(401);
    // Bad body → 400, nothing set.
    const bad = await req(app, "/admin/api/default-grant/mock.doc.read", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ defaultGrant: "yes" }),
    });
    expect(bad.status).toBe(400);
    expect(state.defaultGrants.isDefaultGrant("mock.doc.read")).toBe(false);
  });

  it("revoke (tombstone) KEEPS the subset; revoke&delete DROPS it", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();

    await connect(app, key, "agent-keep", ["mock.doc.read"]);
    await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: "agent-keep" }),
    });
    // A lost-PAT re-issue keeps the same authorized world.
    expect(state.agentSubsets.isScoped("agent-keep")).toBe(true);

    await connect(app, key, "agent-del", ["mock.doc.read"]);
    await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: "agent-del", delete: true }),
    });
    expect(state.agentSubsets.isScoped("agent-del")).toBe(false);
  });
});
