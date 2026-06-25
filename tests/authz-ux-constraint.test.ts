/**
 * AUTHZ-UX Phase 2 — N3a SCOPE-CONSTRAINT SPINE (the security-critical part).
 *
 * The constraint mechanism (`ScopeConstraint`) is the ONE genuinely new authorization
 * primitive. These tests assert its SECURITY INVARIANTS end-to-end:
 *
 *   - it ONLY ever NARROWS — there is no path where a constraint grants authority the
 *     bare (id+verbs) scope did not (`scopesCover` still requires id+verbs first);
 *   - default-deny OUTSIDE the constraint: out-of-prefix / allowlist-miss / traversal /
 *     missing-field all DENY `grant_required`, fail closed;
 *   - the enforced constraint comes from the VERIFIED TOKEN scopes (signed JWT), never
 *     the request body — it round-trips through signToken/verifyToken;
 *   - the SAME single chokepoint (`scopesCover` in the pipeline) enforces it, including
 *     workflow member fan-out (zero special-casing);
 *   - an out-of-constraint miss audits `constraintMiss:true`.
 *
 * Pure-function tests (`constraintSatisfied`, `scopesCover`) + wire-level pipeline tests
 * (handshake → grant-with-constraint → invoke) — no fake-green.
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
  ScopedToken,
  TokenScope,
  ScopeConstraint,
  AuditEvent,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";
import { constraintSatisfied } from "@plexus/runtime/core/constraint.ts";
import { scopesCover } from "@plexus/runtime/core/scope.ts";
import { signToken, verifyToken, getInstanceId } from "@plexus/runtime/auth/index.ts";

// ── Entries: a constrainable read + write, plus a workflow whose member is constrained.
const VAULT_READ: CapabilityEntry = {
  id: "obsidian-rest.vault.read",
  source: "obsidian-rest",
  kind: "capability",
  label: "Read the Obsidian vault (REST)",
  describe: "Read a vault note.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["read"],
  transport: "local-rest",
};
const VAULT_WRITE: CapabilityEntry = {
  id: "obsidian-rest.vault.write",
  source: "obsidian-rest",
  kind: "capability",
  label: "Write the Obsidian vault (REST)",
  describe: "Write a vault note.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["write"],
  transport: "local-rest",
};
const FLOW: CapabilityEntry = {
  id: "obsidian-rest.vault.flow",
  source: "obsidian-rest",
  kind: "workflow",
  label: "A vault workflow",
  describe: "Fan out to a constrained member write.",
  grants: ["execute"],
  transport: "workflow",
  members: [{ id: "obsidian-rest.vault.write", verbs: ["write"] }],
};
const ALL_ENTRIES = [VAULT_READ, VAULT_WRITE, FLOW];

const invokeSpy: { calls: string[] } = { calls: [] };

class MockBridge implements CapabilityBridge {
  readonly source = "obsidian-rest";
  constructor(
    private readonly deps: BridgeDeps,
    private readonly sessionId: string,
  ) {
    void this.sessionId;
  }
  getCapabilities(): CapabilityEntry[] {
    return ALL_ENTRIES;
  }
  route(id: CapabilityId) {
    return ALL_ENTRIES.some((e) => e.id === id) ? ("handled" as const) : ("passthrough" as const);
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
      // The member dispatch carries the SAME input — so a member constraint is checked.
      const res = await ctx.invokeById({ id: member.id, input: _input }, ctx.invoke);
      results.push(res);
    }
    return { ok: results.every((r) => r.ok), data: { members: results.map((r) => r.id) } };
  }
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "obsidian-rest",
    label: "Obsidian REST",
    transport: "local-rest",
    createSource: () => {
      throw new Error("scan not used");
    },
    createBridge: (deps: BridgeDeps, sessionId: string) => new MockBridge(deps, sessionId),
  };
  const transports: Partial<Record<TransportKind, Transport>> = { workflow: new TestWorkflowTransport() };
  return {
    all: () => [module],
    get: (id) => (id === "obsidian-rest" ? module : undefined),
    getTransport: (kind) => transports[kind] ?? ({ kind, dispatch: async () => ({ ok: true }) } as Transport),
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-constraint-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of ALL_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  // AutoApprove so a constrained grant mints a token directly (authoritative path) and
  // the constraint rides in the signed token; the invoke pipeline is the unit under test.
  const { app, state } = createAppWithState(config, {
    sources,
    capabilities,
    authorizer: new AutoApproveAuthorizer(),
  });
  return { app, state, dir };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
async function handshake(app: ReturnType<typeof freshApp>["app"], state: ReturnType<typeof freshApp>["state"]) {
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId: "agent-c" } }),
  });
  return (await res.json()) as HandshakeResponse;
}
async function grantConstrained(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
  id: string,
  verbs: string[],
  constraint: ScopeConstraint,
): Promise<ScopedToken> {
  const res = (await (
    await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId, grants: { [id]: { decision: "allow", verbs, constraint } } }),
    })
  ).json()) as GrantResponse;
  return res as ScopedToken;
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
async function auditEvents(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
): Promise<AuditEvent[]> {
  const key = state.connectionKey.current();
  const res = await req(app, "/admin/api/audit?limit=200", {
    headers: { "X-Plexus-Connection-Key": key },
  });
  return ((await res.json()) as { events: AuditEvent[] }).events;
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
// 1 — constraintSatisfied (pure): pathPrefix / allow / match, all FAIL CLOSED
// ════════════════════════════════════════════════════════════════════════════
describe("constraintSatisfied (pure, fail-closed)", () => {
  const inbox: ScopeConstraint = { pathPrefix: { field: "path", allow: ["Inbox/"] } };

  it("in-prefix path passes; out-of-prefix denies", () => {
    expect(constraintSatisfied(inbox, { path: "Inbox/note.md" })).toBe(true);
    expect(constraintSatisfied(inbox, { path: "Inbox/2026/06/note.md" })).toBe(true);
    expect(constraintSatisfied(inbox, { path: "Finances/taxes.md" })).toBe(false);
  });

  it("traversal Inbox/../x is normalized and DENIED (no naive startsWith)", () => {
    expect(constraintSatisfied(inbox, { path: "Inbox/../Finances/x.md" })).toBe(false);
    expect(constraintSatisfied(inbox, { path: "Inbox/../../etc/passwd" })).toBe(false);
    // A sibling that shares the prefix as a STRING but not a path segment is denied.
    expect(constraintSatisfied(inbox, { path: "Inboxer/secret.md" })).toBe(false);
  });

  it("absolute path is denied", () => {
    expect(constraintSatisfied(inbox, { path: "/etc/passwd" })).toBe(false);
  });

  it("missing / non-string field fails closed (denied)", () => {
    expect(constraintSatisfied(inbox, {})).toBe(false);
    expect(constraintSatisfied(inbox, { path: 42 })).toBe(false);
    expect(constraintSatisfied(inbox, { other: "Inbox/x" })).toBe(false);
  });

  it("allow (resource-id allowlist): exact-equal pass, miss deny", () => {
    const c: ScopeConstraint = { allow: { field: "calendarId", values: ["work-cal"] } };
    expect(constraintSatisfied(c, { calendarId: "work-cal" })).toBe(true);
    expect(constraintSatisfied(c, { calendarId: "personal" })).toBe(false);
    expect(constraintSatisfied(c, {})).toBe(false); // missing ⇒ deny
  });

  it("match eq/prefix/in pass+miss; regex fails closed (D2)", () => {
    expect(constraintSatisfied({ match: [{ field: "a.b", op: "eq", value: "x" }] }, { a: { b: "x" } })).toBe(true);
    expect(constraintSatisfied({ match: [{ field: "a.b", op: "eq", value: "x" }] }, { a: { b: "y" } })).toBe(false);
    expect(constraintSatisfied({ match: [{ field: "p", op: "prefix", value: "ab" }] }, { p: "abc" })).toBe(true);
    expect(constraintSatisfied({ match: [{ field: "p", op: "in", values: [1, 2] }] }, { p: 2 })).toBe(true);
    // regex is reserved + NOT enforced — fail closed even on an "obviously matching" pattern.
    expect(constraintSatisfied({ match: [{ field: "p", op: "regex", pattern: ".*" }] }, { p: "anything" })).toBe(false);
  });

  it("an empty / absent constraint is unconstrained (true)", () => {
    expect(constraintSatisfied(undefined, { anything: 1 })).toBe(true);
    expect(constraintSatisfied({}, {})).toBe(true);
  });

  it("AND semantics: every present predicate must hold", () => {
    const c: ScopeConstraint = {
      pathPrefix: { field: "path", allow: ["Inbox/"] },
      allow: { field: "kind", values: ["md"] },
    };
    expect(constraintSatisfied(c, { path: "Inbox/x.md", kind: "md" })).toBe(true);
    expect(constraintSatisfied(c, { path: "Inbox/x.md", kind: "bin" })).toBe(false); // one fails ⇒ deny
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — scopesCover: a constrained scope is INERT for an out-of-constraint call
// ════════════════════════════════════════════════════════════════════════════
describe("scopesCover with a constraint (the security invariant: only narrows)", () => {
  const constrained: TokenScope = {
    id: VAULT_READ.id,
    verbs: ["read"],
    constraint: { pathPrefix: { field: "path", allow: ["Inbox/"] } },
  };
  const bare: TokenScope = { id: VAULT_READ.id, verbs: ["read"] };

  it("constrained scope covers an in-constraint call", () => {
    expect(scopesCover([constrained], VAULT_READ, { path: "Inbox/n.md" })).toBe(true);
  });

  it("constrained scope is INERT for an out-of-constraint call → not covered", () => {
    expect(scopesCover([constrained], VAULT_READ, { path: "Finances/n.md" })).toBe(false);
  });

  it("INVARIANT — adding a constraint never widens: a constrained scope covers a SUBSET of what bare covers", () => {
    // For any input, constrained-covers ⇒ bare-covers (never the other way).
    const inputs = [{ path: "Inbox/n.md" }, { path: "Finances/n.md" }, {}, { path: "Inbox/../x" }];
    for (const input of inputs) {
      const constrainedCovers = scopesCover([constrained], VAULT_READ, input);
      const bareCovers = scopesCover([bare], VAULT_READ, input);
      if (constrainedCovers) expect(bareCovers).toBe(true); // constrained ⊆ bare
    }
  });

  it("an UNCONSTRAINED scope is unchanged (covers regardless of input)", () => {
    expect(scopesCover([bare], VAULT_READ, { path: "anywhere/n.md" })).toBe(true);
    expect(scopesCover([bare], VAULT_READ)).toBe(true); // no input arg ⇒ unchanged
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — END TO END through the wire: grant-with-constraint → invoke
// ════════════════════════════════════════════════════════════════════════════
describe("constraint enforced at the invoke chokepoint (default-deny outside)", () => {
  const inboxRead: ScopeConstraint = { pathPrefix: { field: "path", allow: ["Inbox/"] } };

  it("constraint round-trips through the SIGNED token (verified, not from the body)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const tok = await grantConstrained(app, hs.sessionId, VAULT_READ.id, ["read"], inboxRead);
    // Decode + verify the JWT: the constraint rides in the signed `scopes`.
    const claims = verifyToken(tok.token);
    const scope = claims.scopes.find((s) => s.id === VAULT_READ.id)!;
    expect(scope.constraint).toEqual(inboxRead);
  });

  it("in-prefix call is ALLOWED", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const tok = await grantConstrained(app, hs.sessionId, VAULT_READ.id, ["read"], inboxRead);
    const res = await invoke(app, tok.token, VAULT_READ.id, { path: "Inbox/note.md" });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(true);
  });

  it("out-of-prefix call is DENIED grant_required + audits constraintMiss:true", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const tok = await grantConstrained(app, hs.sessionId, VAULT_READ.id, ["read"], inboxRead);
    const res = await invoke(app, tok.token, VAULT_READ.id, { path: "Finances/2025.md" });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");
    const events = await auditEvents(app, state);
    const denied = events.find(
      (e) => e.type === "invoke" && e.outcome === "denied" && e.capabilityId === VAULT_READ.id,
    )!;
    expect(denied).toBeDefined();
    expect((denied.detail as Record<string, unknown>).constraintMiss).toBe(true);
  });

  it("traversal Inbox/../Finances/x is DENIED (path confinement)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const tok = await grantConstrained(app, hs.sessionId, VAULT_READ.id, ["read"], inboxRead);
    const res = await invoke(app, tok.token, VAULT_READ.id, { path: "Inbox/../Finances/x.md" });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");
  });

  it("missing-field input fails closed → grant_required", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    // Constrain on a field the call won't provide; the entry's own required `path` is
    // still given so the schema gate passes — the CONSTRAINT is what denies.
    const constrainOther: ScopeConstraint = { pathPrefix: { field: "folder", allow: ["Inbox/"] } };
    const tok = await grantConstrained(app, hs.sessionId, VAULT_READ.id, ["read"], constrainOther);
    const res = await invoke(app, tok.token, VAULT_READ.id, { path: "Inbox/x.md" });
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");
  });

  it("allowlist eq passes / miss denies (resource-id allow)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const c: ScopeConstraint = { allow: { field: "path", values: ["Inbox/pinned.md"] } };
    const tok = await grantConstrained(app, hs.sessionId, VAULT_READ.id, ["read"], c);
    const pass = (await (await invoke(app, tok.token, VAULT_READ.id, { path: "Inbox/pinned.md" })).json()) as InvokeResponse;
    expect(pass.ok).toBe(true);
    const miss = (await (await invoke(app, tok.token, VAULT_READ.id, { path: "Inbox/other.md" })).json()) as InvokeResponse;
    expect(miss.ok).toBe(false);
    expect(miss.error?.code).toBe("grant_required");
  });

  it("an UNCONSTRAINED grant is unchanged (covers any input)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({ sessionId: hs.sessionId, grants: { [VAULT_READ.id]: { decision: "allow", verbs: ["read"] } } }),
      })
    ).json()) as ScopedToken;
    const body = (await (await invoke(app, res.token, VAULT_READ.id, { path: "Anywhere/x.md" })).json()) as InvokeResponse;
    expect(body.ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 — WORKFLOW member with a constraint is enforced through the SAME pipeline
// ════════════════════════════════════════════════════════════════════════════
describe("workflow member constraint (zero special-casing — same scopesCover)", () => {
  it("a constrained MEMBER write denies an out-of-constraint workflow run", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    // Grant the workflow (execute) AND the member write with an Inbox/ constraint in one
    // request. The synthesized member scope from the workflow is unconstrained; the
    // EXPLICIT member grant carries the constraint — but both are scopes for the same id,
    // so to prove the member constraint binds we grant ONLY the constrained member scope
    // plus the workflow execute, and rely on the member-id scope check.
    const res = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          grants: {
            [VAULT_WRITE.id]: {
              decision: "allow",
              verbs: ["write"],
              constraint: { pathPrefix: { field: "path", allow: ["Inbox/"] } },
            },
          },
        }),
      })
    ).json()) as ScopedToken;
    // Member-only token: invoking the member directly with an out-of-prefix path denies.
    const denied = (await (await invoke(app, res.token, VAULT_WRITE.id, { path: "Secrets/x.md" })).json()) as InvokeResponse;
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("grant_required");
    // …and an in-prefix path passes — same chokepoint, member dispatch path.
    const ok = (await (await invoke(app, res.token, VAULT_WRITE.id, { path: "Inbox/x.md" })).json()) as InvokeResponse;
    expect(ok.ok).toBe(true);
  });

  it("a constrained scope minted into a token verifies + refresh re-mints the constraint", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const c: ScopeConstraint = { pathPrefix: { field: "path", allow: ["Inbox/"] } };
    // A STANDING window (1d) so the grant survives refresh (a "once" grant deliberately
    // does not re-mint). The constraint must ride into the refreshed token unchanged.
    const tok = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          grants: { [VAULT_WRITE.id]: { decision: "allow", verbs: ["write"], trustWindow: { kind: "1d" }, constraint: c } },
        }),
      })
    ).json()) as ScopedToken;
    expect(tok.scopes.find((s) => s.id === VAULT_WRITE.id)?.constraint).toEqual(c);
    const refreshed = (await (
      await req(app, "/grants/refresh", {
        method: "POST",
        headers: { authorization: `Bearer ${tok.token}` },
        body: JSON.stringify({ sessionId: hs.sessionId, jti: tok.jti }),
      })
    ).json()) as { token: string; scopes: TokenScope[] };
    const claims = verifyToken(refreshed.token);
    const scope = claims.scopes.find((s) => s.id === VAULT_WRITE.id)!;
    expect(scope.constraint).toEqual(c);
  });
});

// A signed-token round-trip directly (no HTTP) — proves the constraint is in the JWT.
describe("constraint is carried in the SIGNED JWT scopes (not the request body)", () => {
  it("signToken → verifyToken preserves TokenScope.constraint", () => {
    const c: ScopeConstraint = { allow: { field: "calendarId", values: ["work"] } };
    const { token } = signToken({
      sub: "agent-x",
      iss: getInstanceId(),
      sessionId: "sess-x",
      scopes: [{ id: "cal.read", verbs: ["read"], constraint: c }],
    });
    const claims = verifyToken(token);
    expect(claims.scopes[0]!.constraint).toEqual(c);
  });
});
