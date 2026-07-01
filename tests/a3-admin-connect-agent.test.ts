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
const MOCK_ENTRIES = [WRITE_ENTRY, READ_ENTRY];

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

  it("mints a one-time code AND grants the cap-set as STANDING", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { status, body } = await connect(app, key, "agent-A", ["mock.doc.write"], {
      agentType: "claude-code",
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
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.write"]);
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

    // Provision + fully connect TWO agents on the same gateway.
    const { body: connA } = await connect(app, key, "agent-A", ["mock.doc.write"]);
    const { body: connB } = await connect(app, key, "agent-B", ["mock.doc.write"]);
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

  it("mgmt-gated: revoke without the connection-key is 401", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-A" }),
    });
    expect(res.status).toBe(401);
  });
});
