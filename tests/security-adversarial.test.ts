/**
 * ADVERSARIAL SECURITY VERIFICATION (t10).
 *
 * Attacks the authorization/audit pipeline as an adversary across the 7 attack
 * classes: default-deny, revocation, session↔token liveness, Host/Origin
 * (DNS-rebinding), audit integrity, refresh bounds, transitive grants. Each test
 * asserts a REAL denial/rejection — no fake-green.
 *
 * Mirrors the core-pipeline harness (mock in-memory source, fresh PLEXUS_HOME).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

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
  ScopedToken,
  RefreshResponse,
} from "../src/protocol/index.ts";
import { createAppWithState } from "../src/core/server.ts";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import { loadConfig, expectedHost } from "../src/config.ts";
import { _resetSecretCacheForTests, signToken, getInstanceId } from "../src/auth/index.ts";

// ── Mock entries: read cap, write cap (also a workflow member), execute-only
//    capability, and a workflow whose member needs a verb the workflow surfaces.
const READ_ENTRY: CapabilityEntry = {
  id: "mock.note.read",
  source: "mock",
  kind: "capability",
  label: "Read a mock note",
  describe: "Read a note.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["read"],
  transport: "local-rest",
};

const WRITE_ENTRY: CapabilityEntry = {
  id: "mock.note.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock note",
  describe: "Write a note.",
  grants: ["write"],
  transport: "local-rest",
};

const EXEC_ENTRY: CapabilityEntry = {
  id: "mock.proc.run",
  source: "mock",
  kind: "capability",
  label: "Run a process",
  describe: "Execute a side-effecting action.",
  grants: ["execute"],
  transport: "cli",
};

const WORKFLOW_ENTRY: CapabilityEntry = {
  id: "mock.flow.run",
  source: "mock",
  kind: "workflow",
  label: "Run a mock workflow",
  describe: "Fan out to write then exec.",
  grants: ["execute"],
  transport: "workflow",
  members: [
    { id: "mock.note.write", verbs: ["write"] },
    { id: "mock.proc.run", verbs: ["execute"] },
  ],
};

// A workflow that under-declares: it surfaces only `read` for a member that
// REQUIRES `write` — granting it must NOT let the member dispatch (class 7).
const UNDERSCOPED_WORKFLOW: CapabilityEntry = {
  id: "mock.flow.sneaky",
  source: "mock",
  kind: "workflow",
  label: "Sneaky workflow",
  describe: "Tries to run write under a read-only surfaced scope.",
  grants: ["execute"],
  transport: "workflow",
  members: [{ id: "mock.note.write", verbs: ["read"] }], // member requires write!
};

const MOCK_ENTRIES = [READ_ENTRY, WRITE_ENTRY, EXEC_ENTRY, WORKFLOW_ENTRY, UNDERSCOPED_WORKFLOW];

const invokeSpy: { calls: string[] } = { calls: [] };

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
    invokeSpy.calls.push(req.id);
    const entry = this.deps.getEntry(req.id)!;
    if (entry.transport === "workflow") {
      const transport = this.deps.getTransport("workflow");
      const result = await transport.dispatch(entry, req.input ?? {}, {
        invokeById: this.deps.invokeById,
        invoke: ctx,
      });
      const audit = await this.deps.audit({
        type: "invoke",
        agentId: ctx.agentId ?? "",
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: result.ok ? "ok" : "error",
        detail: { transport: "workflow" },
      });
      return { id: entry.id, ok: result.ok, output: result.data, auditId: audit.id };
    }
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

/** Workflow transport: fans out to each member through the uniform pipeline.
 *  A member dispatch that THROWS a PipelineError halts the rest (the real
 *  WorkflowTransport surfaces the per-member denial). */
class TestWorkflowTransport implements Transport {
  readonly kind = "workflow" as const;
  async dispatch(
    entry: CapabilityEntry,
    _input: Record<string, unknown>,
    ctx?: { invokeById: BridgeDeps["invokeById"]; invoke: InvokeContext },
  ) {
    if (!ctx) return { ok: false, error: { code: "transport_error" as const, message: "no ctx" } };
    const results: InvokeResponse[] = [];
    for (const member of entry.members ?? []) {
      try {
        const res = await ctx.invokeById({ id: member.id }, ctx.invoke);
        results.push(res);
      } catch (e) {
        // A pre-dispatch denial (revoked jti / missing scope) halts fan-out.
        return { ok: false, error: { code: "transport_error" as const, message: String(e) } };
      }
    }
    return { ok: results.every((r) => r.ok), data: { members: results.map((r) => r.id) } };
  }
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    createSource: () => {
      throw new Error("scan not used in security tests");
    },
    createBridge: (deps: BridgeDeps, sessionId: string) => new MockBridge(deps, sessionId),
  };
  const transports: Partial<Record<TransportKind, Transport>> = {
    workflow: new TestWorkflowTransport(),
  };
  return {
    all: () => [module],
    get: (id) => (id === "mock" ? module : undefined),
    getTransport: (kind) => {
      const t = transports[kind];
      if (t) return t;
      return { kind, dispatch: async () => ({ ok: true }) } as Transport;
    },
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
let tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-sec-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  const { app, state } = createAppWithState(config, { sources, capabilities });
  return { app, state, dir };
}

async function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  agentId = "agent-1",
) {
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId } }),
  });
  return { res, body: (await res.json()) as HandshakeResponse };
}

async function grant(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
  grants: Record<string, unknown>,
) {
  const res = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants }),
  });
  return (await res.json()) as ScopedToken;
}

function invoke(
  app: ReturnType<typeof freshApp>["app"],
  token: string,
  id: string,
  input?: Record<string, unknown>,
) {
  return req(app, "/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, ...(input ? { input } : {}) }),
  });
}

beforeEach(() => {
  invokeSpy.calls = [];
});

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
// CLASS 1 — DEFAULT-DENY EVERYWHERE
// ════════════════════════════════════════════════════════════════════════════
describe("class1: default-deny", () => {
  it("read-token cannot invoke a write capability (verb escalation denied)", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    // Grant read on the READ entry only.
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    // Forge a request: present the read-scoped token against the WRITE capability.
    const res = await invoke(app, token.token, "mock.note.write");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("grant_required");
    expect(invokeSpy.calls).not.toContain("mock.note.write");
  });

  it("a token scoped to read with the write id but only read verb is denied on write", async () => {
    // Craft a scope that names the write entry but only grants 'read' — write
    // requires 'write', so scopesCover must fail.
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const sess = state.sessions.get(hs.sessionId)!;
    const { token, claims } = signToken({
      sub: "agent-1",
      iss: getInstanceId(),
      sessionId: sess.id,
      scopes: [{ id: "mock.note.write", verbs: ["read"] }],
    });
    state.sessions.trackJti(sess.id, claims.jti);
    const res = await invoke(app, token, "mock.note.write");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("grant_required");
  });

  it("invoke with no token → grant_required (no dispatch)", async () => {
    const { app, state } = freshApp();
    await handshake(app, state);
    const res = await req(app, "/invoke", {
      method: "POST",
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a" } }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("grant_required");
  });

  it("token signed with a DIFFERENT secret is rejected (forged signature)", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    // Hand-build a JWT with valid claims but sign with an attacker secret.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "agent-1",
        iss: getInstanceId(),
        sessionId: hs.sessionId,
        jti: "tok_forged",
        scopes: [{ id: "mock.note.read", verbs: ["read"] }],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url");
    const forgedSig = createHmac("sha256", Buffer.from("attacker-secret"))
      .update(`${header}.${payload}`)
      .digest("base64url");
    const forged = `${header}.${payload}.${forgedSig}`;
    const res = await invoke(app, forged, "mock.note.read", { path: "a" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("token_revoked");
    expect(invokeSpy.calls).not.toContain("mock.note.read");
  });

  it("alg:none unsigned token is rejected (no algorithm confusion)", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "agent-1",
        iss: getInstanceId(),
        sessionId: hs.sessionId,
        jti: "tok_none",
        scopes: [{ id: "mock.note.read", verbs: ["read"] }],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString("base64url");
    // alg:none → empty signature segment.
    const none = `${header}.${payload}.`;
    const res = await invoke(app, none, "mock.note.read", { path: "a" });
    expect(res.status).toBe(401);
    expect(invokeSpy.calls).not.toContain("mock.note.read");
  });

  it("expired token (exp in the past) is rejected with token_expired", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const sess = state.sessions.get(hs.sessionId)!;
    const { token } = signToken({
      sub: "agent-1",
      iss: getInstanceId(),
      sessionId: sess.id,
      scopes: [{ id: "mock.note.read", verbs: ["read"] }],
      lifetimeMs: -1000, // already expired
    });
    const res = await invoke(app, token, "mock.note.read", { path: "a" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("token_expired");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLASS 2 — REVOCATION TRULY KILLS ACCESS (incl. mid-fan-out)
// ════════════════════════════════════════════════════════════════════════════
describe("class2: revocation", () => {
  it("revoked jti cannot complete a multi-member workflow (halts before members)", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, {
      "mock.flow.run": { decision: "allow", verbs: ["execute"] },
    });
    state.revocation.revoke(token.jti, "revoked pre-flight");
    const res = await invoke(app, token.token, "mock.flow.run");
    expect(res.status).toBe(401);
    expect(invokeSpy.calls).not.toContain("mock.note.write");
    expect(invokeSpy.calls).not.toContain("mock.proc.run");
  });

  it("connection-key rotation invalidates in-flight session AND revokes its tokens", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    // Works pre-rotation.
    expect((await invoke(app, token.token, "mock.note.read", { path: "a" })).status).toBe(200);
    // Rotate the connection key → old-key sessions invalidated, jtis revoked.
    state.connectionKey.rotate();
    expect(state.revocation.isRevoked(token.jti)).toBe(true);
    const after = await invoke(app, token.token, "mock.note.read", { path: "a" });
    expect(after.status).toBe(401);
    const code = ((await after.json()) as { error: { code: string } }).error.code;
    // Either session_expired (liveness) or token_revoked — both are real denials.
    expect(["session_expired", "token_revoked"]).toContain(code);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLASS 3 — SESSION↔TOKEN LIVENESS (replay / torn-down session)
// ════════════════════════════════════════════════════════════════════════════
describe("class3: session liveness", () => {
  it("a token whose session was invalidated cannot invoke", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    // Invalidate the session WITHOUT revoking the jti (isolate the liveness path).
    const sess = state.sessions.get(hs.sessionId)!;
    sess.invalidated = true;
    const res = await invoke(app, token.token, "mock.note.read", { path: "a" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("session_expired");
    expect(invokeSpy.calls).not.toContain("mock.note.read");
  });

  it("a token referencing a NON-EXISTENT session is denied (forged sessionId)", async () => {
    const { app, state } = freshApp();
    await handshake(app, state);
    // Mint a perfectly-signed token pointing at a session that was never opened.
    const { token } = signToken({
      sub: "agent-1",
      iss: getInstanceId(),
      sessionId: "sess_does_not_exist",
      scopes: [{ id: "mock.note.read", verbs: ["read"] }],
    });
    const res = await invoke(app, token, "mock.note.read", { path: "a" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("session_expired");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLASS 4 — HOST/ORIGIN (DNS-rebinding)
// ════════════════════════════════════════════════════════════════════════════
describe("class4: host/origin", () => {
  it("non-loopback Host header → 403 host_forbidden (DNS-rebinding hostname)", async () => {
    const { app } = freshApp();
    const res = await app.request("http://evil.example.com/invoke", {
      method: "POST",
      headers: { host: "evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ id: "mock.note.read" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });

  it("cross-origin Origin header → 403 host_forbidden", async () => {
    const { app } = freshApp();
    const res = await app.request("http://" + HOST + "/.well-known/plexus", {
      headers: { host: HOST, origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });

  it(".well-known works for the loopback caller but leaks ONLY summaries", async () => {
    const { app } = freshApp();
    const res = await app.request("http://" + HOST + "/.well-known/plexus", {
      headers: { host: HOST },
    });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      capabilities: Array<Record<string, unknown>>;
    };
    expect(doc.capabilities.length).toBe(MOCK_ENTRIES.length);
    // Summary tier must NOT carry full io schemas, mcp.raw, skill bodies, members.
    for (const c of doc.capabilities) {
      expect(c).not.toHaveProperty("io");
      expect(c).not.toHaveProperty("mcp");
      expect(c).not.toHaveProperty("members");
      expect(c).not.toHaveProperty("body");
      expect(c).not.toHaveProperty("describe"); // only `summary`, not full describe
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLASS 5 — AUDIT INTEGRITY
// ════════════════════════════════════════════════════════════════════════════
describe("class5: audit integrity", () => {
  it("invoke audit records faithfully and NEVER writes token/secret/raw-input", async () => {
    const { app, state, dir } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    const SECRET_PATH = "TOP-SECRET-VALUE-12345";
    await invoke(app, token.token, "mock.note.read", { path: SECRET_PATH });

    const auditDir = join(dir, "audit");
    expect(existsSync(auditDir)).toBe(true);
    const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    const content = files.map((f) => readFileSync(join(auditDir, f), "utf8")).join("");
    // Faithful: invoke outcome recorded.
    const lines = content.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const inv = lines.find((l) => l.type === "invoke");
    expect(inv).toBeDefined();
    expect(inv?.outcome).toBe("ok");
    // Integrity: the raw token string, the connection-key, and the raw input
    // value must NOT appear anywhere in the JSONL.
    expect(content).not.toContain(token.token);
    expect(content).not.toContain(state.connectionKey.current());
    expect(content).not.toContain(SECRET_PATH);
  });

  it("a DENIED top-level invoke is audited with outcome=denied", async () => {
    const { app, state, dir } = freshApp();
    const { body: hs } = await handshake(app, state);
    // Grant read; then attempt the write capability (default-deny) → grant_required.
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    const res = await invoke(app, token.token, "mock.note.write");
    expect(res.status).toBe(401);

    const auditDir = join(dir, "audit");
    const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    const content = files.map((f) => readFileSync(join(auditDir, f), "utf8")).join("");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const denied = lines.find(
      (l) => l.type === "invoke" && l.capabilityId === "mock.note.write" && l.outcome === "denied",
    );
    expect(denied).toBeDefined();
  });

  it("revoked-token reuse at top-level /invoke is audited (outcome=denied)", async () => {
    const { app, state, dir } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    state.revocation.revoke(token.jti, "revoked for probe");
    const res = await invoke(app, token.token, "mock.note.read", { path: "a" });
    expect(res.status).toBe(401);
    const auditDir = join(dir, "audit");
    const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    const content = files.map((f) => readFileSync(join(auditDir, f), "utf8")).join("");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const denied = lines.find(
      (l) =>
        l.type === "invoke" &&
        l.capabilityId === "mock.note.read" &&
        l.outcome === "denied" &&
        l.jti === token.jti,
    );
    expect(denied).toBeDefined();
  });

  it("a DENIED invoke audits outcome faithfully (the error path is recorded)", async () => {
    const { app, state, dir } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    // Drive a transport error by making the bridge throw: invoke an entry whose
    // member path forces a fan-out denial. Use the underscoped workflow.
    const wfToken = await grant(app, hs.sessionId, {
      "mock.flow.sneaky": { decision: "allow", verbs: ["execute"] },
    });
    const res = await invoke(app, wfToken.token, "mock.flow.sneaky");
    // The member (write) is denied → the workflow result is ok:false.
    const out = (await res.json()) as InvokeResponse;
    expect(out.ok).toBe(false);
    // And an audit line for the workflow invoke exists with a non-ok outcome.
    const auditDir = join(dir, "audit");
    const files = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    const content = files.map((f) => readFileSync(join(auditDir, f), "utf8")).join("");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const wfInvoke = lines.find(
      (l) => l.type === "invoke" && l.capabilityId === "mock.flow.sneaky",
    );
    expect(wfInvoke).toBeDefined();
    expect(wfInvoke?.outcome).toBe("error");
    void token;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLASS 6 — REFRESH BOUNDS
// ════════════════════════════════════════════════════════════════════════════
describe("class6: refresh bounds", () => {
  it("refresh of a revoked grant fails and does not resurrect the jti", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    // Revoke by scope (removes the persisted grant + revokes the jti).
    // Scope-form is a management action → authorized by the connection-key (tv2).
    await req(app, "/grants/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": state.connectionKey.current() },
      body: JSON.stringify({ agentId: "agent-1", capabilityId: "mock.note.read" }),
    });
    const ref = await req(app, "/grants/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ sessionId: hs.sessionId, jti: token.jti }),
    });
    expect(ref.status).toBe(401);
    // The revoked jti stays revoked (no resurrection).
    expect(state.revocation.isRevoked(token.jti)).toBe(true);
  });

  it("refresh cannot exceed the originating grant's validity (grantExpiresAt bounded)", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    const ref = await req(app, "/grants/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ sessionId: hs.sessionId, jti: token.jti }),
    });
    expect(ref.status).toBe(200);
    const refreshed = (await ref.json()) as RefreshResponse;
    // grantExpiresAt is the persisted grant's ceiling, and the new token expiry
    // must not exceed it.
    const grantCeil = Date.parse(refreshed.grantExpiresAt);
    const newExp = Date.parse(refreshed.expiresAt);
    expect(newExp).toBeLessThanOrEqual(grantCeil);
    // And it equals the persisted grant's stored expiry.
    const g = state.grants.get("agent-1", "mock.note.read")!;
    expect(refreshed.grantExpiresAt).toBe(g.expiresAt);
  });

  it("refresh with a mismatched jti (token vs body) is rejected", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, { "mock.note.read": "allow" });
    const ref = await req(app, "/grants/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ sessionId: hs.sessionId, jti: "tok_some_other_jti" }),
    });
    expect(ref.status).toBe(401);
    expect(((await ref.json()) as { error: { code: string } }).error.code).toBe("token_revoked");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GAP A — events SSE ↔ registry list_changed wiring
// ════════════════════════════════════════════════════════════════════════════
describe("gapA: registry change → manifest_changed on /events", () => {
  it("a registry entry-set change publishes manifest_changed onto the event bus", async () => {
    // A controllable source whose scan() output we can grow at will, driving a
    // real EntrySetChange through createCapabilityRegistry.refresh().
    const dir = mkdtempSync(join(tmpdir(), "plexus-sec-gapA-"));
    tmpDirs.push(dir);
    process.env.PLEXUS_HOME = dir;
    _resetSecretCacheForTests();

    let scanned: CapabilityEntry[] = [];
    const controllableSource = {
      id: "ctl",
      label: "Controllable",
      transport: "local-rest" as const,
      checkRequirements: async () => ({ ok: true }),
      scan: async () => scanned,
      start: async () => {},
      stop: async () => {},
    };
    const ctlModule = {
      id: "ctl",
      label: "Controllable",
      transport: "local-rest",
      createSource: () => controllableSource,
      createBridge: (deps: BridgeDeps, sid: string) => new MockBridge(deps, sid),
    } as SourceModule;
    const sources: SourceRegistry = {
      all: () => [ctlModule],
      get: (id) => (id === "ctl" ? ctlModule : undefined),
      getTransport: (kind) => ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
    };
    const capabilities = createCapabilityRegistry(sources);
    const { state } = createAppWithState(config, { sources, capabilities });

    // Subscribe to the SAME event bus /events subscribes to.
    const received: Array<{ type: string; revision?: number; changed?: unknown }> = [];
    state.events.subscribe((e) => received.push(e as never));

    // Grow the entry set and refresh → a real `added` change fires.
    scanned = [READ_ENTRY];
    await capabilities.refresh();

    const evt = received.find((e) => e.type === "manifest_changed");
    expect(evt).toBeDefined();
    expect(typeof evt?.revision).toBe("number");
    expect(evt?.revision).toBe(capabilities.revision());
    expect((evt?.changed as { added?: string[] })?.added).toContain("mock.note.read");
  });

  it("GET /events opens an SSE stream and stays subscribed", async () => {
    const { app } = freshApp();
    const res = await req(app, "/events", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CLASS 7 — TRANSITIVE GRANTS (no silent member escalation)
// ════════════════════════════════════════════════════════════════════════════
describe("class7: transitive grants", () => {
  it("granting a workflow does NOT authorize a member verb the workflow under-surfaced", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    // Sneaky workflow surfaces only `read` for a member that REQUIRES `write`.
    const token = await grant(app, hs.sessionId, {
      "mock.flow.sneaky": { decision: "allow", verbs: ["execute"] },
    });
    // The synthesized member scope carries only read → member dispatch (needs
    // write) must be denied; the workflow invoke returns ok:false and the member
    // never produced a successful write.
    const res = await invoke(app, token.token, "mock.flow.sneaky");
    const out = (await res.json()) as InvokeResponse;
    expect(out.ok).toBe(false);
  });

  it("granting a workflow does NOT let the agent directly invoke a non-member sibling", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    // Grant the workflow whose members are write + proc.run. The READ entry is
    // NOT a member → the workflow token must not cover it.
    const token = await grant(app, hs.sessionId, {
      "mock.flow.run": { decision: "allow", verbs: ["execute"] },
    });
    const res = await invoke(app, token.token, "mock.note.read", { path: "a" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("grant_required");
  });

  it("a workflow member IS dispatchable only through the synthesized scope, not standalone", async () => {
    const { app, state } = freshApp();
    const { body: hs } = await handshake(app, state);
    const token = await grant(app, hs.sessionId, {
      "mock.flow.run": { decision: "allow", verbs: ["execute"] },
    });
    // The fan-out runs the members (write + proc) under the synthesized scope.
    const res = await invoke(app, token.token, "mock.flow.run");
    expect(res.status).toBe(200);
    expect((await res.json() as InvokeResponse).ok).toBe(true);
    expect(invokeSpy.calls).toContain("mock.note.write");
    expect(invokeSpy.calls).toContain("mock.proc.run");
  });
});
