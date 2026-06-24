/**
 * AUTHZ-UX Phase 3 — N3 MODE-2 TASK BUNDLES (the NAS-folder worked example, design §4).
 *
 * A task bundle = a named, human-approved group of (capability + verbs + scope constraint)
 * grants to ONE task-agent, plus attached in-scope context. It adds NO new authority class —
 * it is N normal `PersistedGrant`s tagged with a shared `bundleId` (+ keyEpoch, D6) + context
 * materialized through the EXISTING skill mechanism. These tests prove the headline flow:
 *
 *   create bundle (read+write+list constrained to pathPrefix Inbox/, 1d window, context) via
 *   POST /admin/api/bundles  →  ONE approve (admin = human approver, auto-approve)  →
 *   target agent handshakes  →  in-scope calls (Inbox/…, incl. Inbox/2026/06/x) PASS, NO pend
 *   (standing grant)  →  out-of-scope (Finances/x) → grant_required + constraintMiss audited →
 *   agent PUT /grants for it → PENDS (Mode-1 fallback) → revoke-bundle removes all members.
 *
 * Plus: agent-requested `GrantRequest.bundle` group-pends as ONE item (anti-self-grant
 * linchpin held); GET /grants/context returns the context bodies; revoke-bundle leaves no
 * orphan grant; D6 key-epoch rotation drops the bundle.
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
  ScopedToken,
  BundleView,
  BundleContextResponse,
  AuditEvent,
  StandingGrant,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, AutoApproveAuthorizer, defaultAuthorizer, verifyToken } from "@plexus/runtime/auth/index.ts";

// ── Entries: a NAS vault read + write + list, plus a how-to-use skill for context.
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
const VAULT_LIST: CapabilityEntry = {
  id: "obsidian-rest.vault.list",
  source: "obsidian-rest",
  kind: "capability",
  label: "List the Obsidian vault (REST)",
  describe: "List vault notes under a path.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["read"],
  transport: "local-rest",
};
const HOWTO_SKILL: CapabilityEntry = {
  id: "obsidian-rest.vault.how-to-use",
  source: "obsidian-rest",
  kind: "skill",
  label: "How to use the vault REST API",
  describe: "Usage guidance for the vault REST capabilities.",
  grants: [],
  transport: "skill",
  body: { format: "markdown", markdown: "Use forward-slash paths relative to the vault root." },
};
const ALL_ENTRIES = [VAULT_READ, VAULT_WRITE, VAULT_LIST, HOWTO_SKILL];

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
    id: "obsidian-rest",
    label: "Obsidian REST",
    transport: "local-rest",
    // A real scan-able source so `refresh()` (triggered when a bundle materializes its inline
    // context as a synthetic `bundle:` extension) repopulates these entries cleanly.
    createSource: () => ({
      id: "obsidian-rest",
      label: "Obsidian REST",
      transport: "local-rest" as const,
      async checkRequirements() {
        return { ok: true as const };
      },
      async start() {},
      async stop() {},
      async scan() {
        return ALL_ENTRIES;
      },
    }),
    createBridge: (deps: BridgeDeps, sessionId: string) => new MockBridge(deps, sessionId),
  };
  const transports: Partial<Record<TransportKind, Transport>> = {};
  return {
    all: () => [module],
    get: (id) => (id === "obsidian-rest" ? module : undefined),
    getTransport: (kind) => transports[kind] ?? ({ kind, dispatch: async () => ({ ok: true }) } as Transport),
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp(authorizer: "auto" | "confirm" = "auto") {
  const dir = mkdtempSync(join(tmpdir(), "plexus-bundle-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of ALL_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  const { app, state } = createAppWithState(config, {
    sources,
    capabilities,
    authorizer: authorizer === "auto" ? new AutoApproveAuthorizer() : defaultAuthorizer(),
  });
  return { app, state, dir };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
async function adminReq(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  path: string,
  init?: RequestInit,
) {
  return req(app, path, {
    ...init,
    headers: { "X-Plexus-Connection-Key": state.connectionKey.current(), ...(init?.headers ?? {}) },
  });
}
async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  agentId: string,
) {
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: state.connectionKey.current(), client: { name: "task-runner", agentId } }),
  });
  return (await res.json()) as HandshakeResponse;
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
  const res = await adminReq(app, state, "/admin/api/audit?limit=300");
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

const INBOX = { pathPrefix: { field: "path", allow: ["Inbox/"] } };
const AGENT = "cc-master-taskA";

// ════════════════════════════════════════════════════════════════════════════
// 1 — THE NAS-FOLDER E2E (design §4): create → approve-once → in-scope pass →
//     out-of-scope grant_required → Mode-1 re-request pends → revoke-bundle.
// ════════════════════════════════════════════════════════════════════════════
describe("NAS-folder task bundle e2e (Mode-2: create once, run within scope, no re-prompts)", () => {
  async function createInboxBundle(
    app: ReturnType<typeof freshApp>["app"],
    state: ReturnType<typeof freshApp>["state"],
  ): Promise<BundleView> {
    const res = await adminReq(app, state, "/admin/api/bundles", {
      method: "POST",
      body: JSON.stringify({
        name: "Organize NAS Inbox",
        agentId: AGENT,
        trustWindow: { kind: "1d" },
        grants: [
          { id: VAULT_READ.id, verbs: ["read"], constraint: INBOX },
          { id: VAULT_WRITE.id, verbs: ["write"], constraint: INBOX },
          { id: VAULT_LIST.id, verbs: ["read"], constraint: INBOX },
        ],
        context: [
          { kind: "skill", skillId: HOWTO_SKILL.id },
          {
            kind: "inline",
            label: "NAS Inbox conventions",
            markdown:
              "Inbox files are unsorted captures; move each into Inbox/YYYY/MM/ by its creation date; keep filenames; never touch anything outside Inbox/.",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as BundleView;
  }

  it("creates the bundle in ONE admin action with 3 constrained members + attached context", async () => {
    const { app, state } = freshApp("auto");
    const bundle = await createInboxBundle(app, state);
    expect(bundle.name).toBe("Organize NAS Inbox");
    expect(bundle.agentId).toBe(AGENT);
    expect(bundle.members).toHaveLength(3);
    for (const m of bundle.members) {
      expect(m.bundleId).toBe(bundle.bundleId);
      expect(m.constraint).toEqual(INBOX);
    }
    // Context = the referenced skill + the materialized inline blob (2 entries).
    expect(bundle.context).toHaveLength(2);
    expect(bundle.context.some((c) => c.id === HOWTO_SKILL.id && c.kind === "skill")).toBe(true);
    expect(bundle.context.some((c) => c.kind === "inline")).toBe(true);
  });

  it("REAL-AGENT bare in-scope request → NO pend, mints a CONSTRAINED token (inherits the bundle scope)", async () => {
    // The `confirm` authorizer proves the REAL flow: a bare request would normally PEND, but the
    // pre-authorized (constrained) standing grant short-circuits it. The agent does NOT know /
    // send the human-set constraint — it sends a BARE request, exactly as `plexus call` does.
    const { app, state } = freshApp("confirm");
    await createInboxBundle(app, state);
    const hs = await handshake(app, state, AGENT);
    const grantRes = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          // BARE — no constraint, no verbs override: exactly what a real agent sends.
          grants: {
            [VAULT_READ.id]: "allow",
            [VAULT_WRITE.id]: { decision: "allow", verbs: ["write"] },
            [VAULT_LIST.id]: "allow",
          },
        }),
      })
    ).json()) as GrantResponse;
    // NO pend — the standing bundle grant short-circuits the confirm authorizer.
    expect("token" in grantRes).toBe(true);
    const token = (grantRes as ScopedToken).token;

    // NO-WIDEN: the bare request still yields a CONSTRAINED token (inherited from the grant).
    const readScope = (grantRes as ScopedToken).scopes.find((s) => s.id === VAULT_READ.id)!;
    expect(readScope.constraint).toEqual(INBOX);

    // In-scope calls PASS (incl. nested Inbox/2026/06/x) — the inherited constraint allows them.
    for (const [id, path] of [
      [VAULT_LIST.id, "Inbox/"],
      [VAULT_READ.id, "Inbox/note-1.md"],
      [VAULT_WRITE.id, "Inbox/2026/06/note-1.md"],
    ] as const) {
      const body = (await (await invoke(app, token, id, { path })).json()) as InvokeResponse;
      expect(body.ok).toBe(true);
    }
    // Out-of-scope is STILL DENIED even though the request was bare — the token is constrained.
    const denied = (await (await invoke(app, token, VAULT_READ.id, { path: "Finances/x.md" })).json()) as InvokeResponse;
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("grant_required");
  });

  it("out-of-scope (Finances/x) → grant_required + constraintMiss audited; Mode-1 PUT pends", async () => {
    // confirm authorizer so the Mode-1 re-request for the broader scope PENDS (anti-self-grant).
    const { app, state } = freshApp("confirm");
    await createInboxBundle(app, state);
    const hs = await handshake(app, state, AGENT);
    // The agent already holds the standing bundle grant; a BARE request mints from it.
    const tokenRes = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          grants: { [VAULT_READ.id]: "allow" },
        }),
      })
    ).json()) as GrantResponse;
    // Standing grant exists → hasPriorApproval short-circuits the confirm authorizer → token.
    expect("token" in tokenRes).toBe(true);
    const token = (tokenRes as ScopedToken).token;

    // Out-of-scope read → constraint inert → grant_required, audited constraintMiss:true.
    const denied = (await (await invoke(app, token, VAULT_READ.id, { path: "Finances/2025-taxes.md" })).json()) as InvokeResponse;
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("grant_required");
    const events = await auditEvents(app, state);
    const miss = events.find(
      (e) => e.type === "invoke" && e.outcome === "denied" && e.capabilityId === VAULT_READ.id,
    )!;
    expect(miss).toBeDefined();
    expect((miss.detail as Record<string, unknown>).constraintMiss).toBe(true);

    // Mode-1 fallback: the agent requests an EXPLICIT DIFFERENT scope (Finances/) → PENDS. The
    // constrained standing grant (Inbox/) does NOT satisfy a different explicit constraint, so it
    // does not short-circuit → the confirm authorizer pends (a one-off Mode-1 approval).
    const FINANCES = { pathPrefix: { field: "path", allow: ["Finances/"] } };
    const pend = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          grants: {
            [VAULT_READ.id]: { decision: "allow", verbs: ["read"], constraint: FINANCES, purpose: "read the taxes note" },
          },
        }),
      })
    ).json()) as GrantResponse;
    expect((pend as GrantPendingResponse).status).toBe("grant_pending_user");
  });

  it("revoke-bundle removes EVERY member + leaves no orphan grant", async () => {
    const { app, state } = freshApp("auto");
    const bundle = await createInboxBundle(app, state);
    // Sanity: 3 grants exist for the agent before revoke.
    const before = (await (await adminReq(app, state, "/admin/api/grants")).json()) as { grants: StandingGrant[] };
    expect(before.grants.filter((g) => g.bundleId === bundle.bundleId)).toHaveLength(3);

    const revoke = (await (
      await adminReq(app, state, "/admin/api/revoke", {
        method: "POST",
        body: JSON.stringify({ bundleId: bundle.bundleId }),
      })
    ).json()) as { ok: boolean; grantRemoved: boolean };
    expect(revoke.ok).toBe(true);
    expect(revoke.grantRemoved).toBe(true);

    // No orphan: zero grants tagged with the bundle, and the bundle list is empty.
    const after = (await (await adminReq(app, state, "/admin/api/grants")).json()) as { grants: StandingGrant[] };
    expect(after.grants.filter((g) => g.bundleId === bundle.bundleId)).toHaveLength(0);
    const bundles = (await (await adminReq(app, state, "/admin/api/bundles")).json()) as { bundles: BundleView[] };
    expect(bundles.bundles.find((b) => b.bundleId === bundle.bundleId)).toBeUndefined();
  });

  it("NO-WIDEN invariant — a BARE request mints the STANDING grant's constraint (never unconstrained)", async () => {
    const { app, state } = freshApp("confirm");
    await createInboxBundle(app, state);
    const hs = await handshake(app, state, AGENT);
    const res = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({ sessionId: hs.sessionId, grants: { [VAULT_READ.id]: "allow" } }),
      })
    ).json()) as ScopedToken;
    // The SIGNED token (not the request) carries the standing grant's constraint — proving the
    // bare request minted a CONSTRAINED token, never an unconstrained one (no widening).
    const claims = verifyToken(res.token);
    const scope = claims.scopes.find((s) => s.id === VAULT_READ.id)!;
    expect(scope.constraint).toEqual(INBOX);
    expect(scope.constraint).not.toBeUndefined();
  });

  it("EXPLICIT broader/different constraint request PENDS (Mode-1 escalation, no auto-mint)", async () => {
    const { app, state } = freshApp("confirm");
    await createInboxBundle(app, state);
    const hs = await handshake(app, state, AGENT);
    // An explicit DIFFERENT constraint (Finances/) on the same id does NOT match the standing
    // Inbox/ grant → does not short-circuit → the confirm authorizer PENDS (a one-off Mode-1).
    const FINANCES = { pathPrefix: { field: "path", allow: ["Finances/"] } };
    const res = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          grants: { [VAULT_READ.id]: { decision: "allow", verbs: ["read"], constraint: FINANCES } },
        }),
      })
    ).json()) as GrantResponse;
    expect((res as GrantPendingResponse).status).toBe("grant_pending_user");
    expect("token" in res).toBe(false); // no auto-mint
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2 — GET /grants/context returns the resolved context bodies (D3)
// ════════════════════════════════════════════════════════════════════════════
describe("bundle context fetch (D3 — reuse the skill mechanism, one call)", () => {
  it("GET /grants/context?bundle=<id> returns the attached skill + inline bodies", async () => {
    const { app, state } = freshApp("auto");
    const res = await adminReq(app, state, "/admin/api/bundles", {
      method: "POST",
      body: JSON.stringify({
        name: "ctx", agentId: AGENT, grants: [{ id: VAULT_READ.id, verbs: ["read"], constraint: INBOX }],
        context: [
          { kind: "skill", skillId: HOWTO_SKILL.id },
          { kind: "inline", label: "note", markdown: "do the thing" },
        ],
      }),
    });
    const bundle = (await res.json()) as BundleView;
    const hs = await handshake(app, state, AGENT);
    const ctxRes = await req(app, `/grants/context?bundle=${bundle.bundleId}`, {
      headers: { "X-Plexus-Session": hs.sessionId },
    });
    expect(ctxRes.status).toBe(200);
    const ctx = (await ctxRes.json()) as BundleContextResponse;
    expect(ctx.bundleId).toBe(bundle.bundleId);
    const howto = ctx.context.find((c) => c.id === HOWTO_SKILL.id);
    expect(howto?.markdown).toContain("forward-slash");
    const inline = ctx.context.find((c) => c.markdown === "do the thing");
    expect(inline).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3 — AGENT-REQUESTED bundle group-PENDS as ONE item (D4 anti-self-grant linchpin)
// ════════════════════════════════════════════════════════════════════════════
describe("agent-requested GrantRequest.bundle group-pends (linchpin: risky members still pend)", () => {
  it("a write-bearing bundle from an agent PENDS as one grouped item, never auto-approves", async () => {
    const { app, state } = freshApp("confirm");
    const hs = await handshake(app, state, AGENT);
    const res = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          bundle: { name: "Agent task", context: [{ kind: "inline", label: "n", markdown: "go" }] },
          grants: {
            [VAULT_READ.id]: { decision: "allow", verbs: ["read"], constraint: INBOX },
            [VAULT_WRITE.id]: { decision: "allow", verbs: ["write"], constraint: INBOX },
          },
        }),
      })
    ).json()) as GrantResponse;
    // Linchpin: the risky bundle PENDS — never auto-approved.
    expect((res as GrantPendingResponse).status).toBe("grant_pending_user");

    // The admin pending panel shows ONE grouped bundle card (PendingView.bundle).
    const pendList = (await (await adminReq(app, state, "/admin/api/pending")).json()) as {
      pending: { pendingId: string; bundle?: { name: string; members: { id: string }[] } }[];
    };
    const grouped = pendList.pending.find((p) => p.bundle);
    expect(grouped).toBeDefined();
    expect(grouped!.bundle!.name).toBe("Agent task");
    expect(grouped!.bundle!.members).toHaveLength(2);

    // ONE approve → both members become standing grants tagged the bundleId + context materialized.
    const approve = await adminReq(app, state, `/admin/api/pending/${grouped!.pendingId}`, {
      method: "POST",
      body: JSON.stringify({ action: "approve", agentId: AGENT, trustWindow: { kind: "1d" } }),
    });
    expect(approve.status).toBe(200);
    const bundles = (await (await adminReq(app, state, "/admin/api/bundles")).json()) as { bundles: BundleView[] };
    const made = bundles.bundles.find((b) => b.name === "Agent task");
    expect(made).toBeDefined();
    expect(made!.members).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4 — D6: a connection-key rotation drops the whole bundle (keyEpoch stamping)
// ════════════════════════════════════════════════════════════════════════════
describe("D6 — connection-key epoch stamping drops a bundle on rotation", () => {
  it("after rotate, the agent's prior bundle grant no longer short-circuits (re-request pends)", async () => {
    const { app, state } = freshApp("confirm");
    const res = await adminReq(app, state, "/admin/api/bundles", {
      method: "POST",
      body: JSON.stringify({
        name: "rotate-me", agentId: AGENT, trustWindow: { kind: "7d" },
        grants: [{ id: VAULT_WRITE.id, verbs: ["write"], constraint: INBOX }],
      }),
    });
    expect(res.status).toBe(200);
    // Rotate the connection key → bumps the epoch → the bundle grant is now stale.
    state.connectionKey.rotate();
    // Re-handshake under the NEW key; re-request the same scope. Because the bundle grant's
    // keyEpoch is now stale, hasPriorApproval no longer short-circuits → confirm authorizer pends.
    const hs = await handshake(app, state, AGENT);
    const reReq = (await (
      await req(app, "/grants", {
        method: "PUT",
        body: JSON.stringify({
          sessionId: hs.sessionId,
          grants: { [VAULT_WRITE.id]: { decision: "allow", verbs: ["write"], constraint: INBOX } },
        }),
      })
    ).json()) as GrantResponse;
    expect((reReq as GrantPendingResponse).status).toBe("grant_pending_user");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5 — A bundle adds NO new authority class (it is grants + constraints + context)
// ════════════════════════════════════════════════════════════════════════════
describe("a bundle is purely grouped grants — no new authority", () => {
  it("every bundle member is an ordinary standing grant tagged bundleId (same ledger)", async () => {
    const { app, state } = freshApp("auto");
    const res = await adminReq(app, state, "/admin/api/bundles", {
      method: "POST",
      body: JSON.stringify({
        name: "plain", agentId: AGENT, trustWindow: { kind: "1d" },
        grants: [{ id: VAULT_READ.id, verbs: ["read"], constraint: INBOX }],
      }),
    });
    const bundle = (await res.json()) as BundleView;
    // The member appears in the ordinary standing-grant ledger, carrying its bundleId — it is
    // exactly a grant + constraint, grouped; nothing more.
    const ledger = (await (await adminReq(app, state, "/admin/api/grants")).json()) as { grants: StandingGrant[] };
    const member = ledger.grants.find((g) => g.capabilityId === VAULT_READ.id && g.bundleId === bundle.bundleId);
    expect(member).toBeDefined();
    expect(member!.constraint).toEqual(INBOX);
    expect(member!.agentId).toBe(AGENT);
  });
});
