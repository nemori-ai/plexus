/**
 * Integration-legibility fixes (docs/design/integration-legibility-findings.md) — the cold-agent
 * authorization core made reachable + honest. Black-box over the HTTP surface, DEFAULT authorizer
 * (UserConfirm — the linchpin), so a valid connection-key is the ONLY trust the cold agent holds.
 *
 * Proves the six fixes:
 *  1. COLD AUTO-GRANT: a fresh session (valid key) can invoke a low-sensitivity first-party READ
 *     with NO Bearer token — the gateway auto-issues the scoped grant, runs the call, and attaches
 *     the token — with NO owner step.
 *  2. APPROVAL PATH: an invoke for a first-party WRITE returns a STRUCTURED `approval_required`
 *     (real pendingId + approvalUrl + grantStatusUrl); `GET /grants/status` finds it; the owner
 *     approves via the admin path → the polled token invokes successfully.
 *  3. ERROR HYGIENE: a malformed `PUT /grants` body → 400 (not a 500 crash); an unknown capability
 *     id → 400 (not a hollow empty-scope 200).
 *  4. DISCOVERY: `.well-known` advertises the grant-request endpoint + the session header.
 *  5. SESSION CONSISTENCY: the SAME session works across GET and PUT /grants via the header.
 *  6. CONNECTION-KEY IS NOT A BEARER: presenting it as a token is rejected (never accepted).
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
  ScopedToken,
  WellKnownDocument,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

// A first-party READ cap (auto-grant) + a first-party WRITE cap (pends). `mock` is a RESERVED
// first-party source id, so read auto-grants and write pends under the default authorizer.
const READ_ENTRY: CapabilityEntry = {
  id: "mock.note.read",
  source: "mock",
  kind: "capability",
  label: "Read a mock note",
  describe: "Read a note.",
  io: { input: { type: "object", properties: { path: { type: "string" } } } },
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
const MOCK_ENTRIES = [READ_ENTRY, WRITE_ENTRY];

class MockBridge implements CapabilityBridge {
  readonly source = "mock";
  getCapabilities(): CapabilityEntry[] {
    return MOCK_ENTRIES;
  }
  route(id: CapabilityId) {
    return MOCK_ENTRIES.some((e) => e.id === id) ? ("handled" as const) : ("passthrough" as const);
  }
  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    void ctx;
    return { id: req.id, ok: true, output: { ran: req.id, input: req.input ?? {} }, auditId: "evt_mock" };
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
      scan: async () => MOCK_ENTRIES,
      start: async () => {},
      stop: async () => {},
    }),
    createBridge: (_deps: BridgeDeps, _sid: string) => new MockBridge(),
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
const tmpDirs: string[] = [];
let activeKey = "";

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-intleg-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  // NO authorizer override → the gateway default (UserConfirmAuthorizer, the linchpin).
  const { app, state } = createAppWithState(config, { sources, capabilities });
  activeKey = state.connectionKey.current();
  return { app, state, dir };
}

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  agentId = "cold-agent",
) {
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "cold", agentId } }),
  });
  return (await res.json()) as HandshakeResponse;
}

/** Invoke WITHOUT a Bearer token, identifying the session via the standardized header. */
function invokeWithSession(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
  id: string,
  input?: Record<string, unknown>,
) {
  return req(app, "/invoke", {
    method: "POST",
    headers: { "X-Plexus-Session": sessionId },
    body: JSON.stringify({ id, ...(input ? { input } : {}) }),
  });
}

function invokeWithToken(
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

async function adminApprove(app: ReturnType<typeof freshApp>["app"], pendingId: string) {
  const res = await req(app, `/admin/api/pending/${pendingId}`, {
    method: "POST",
    headers: { "X-Plexus-Connection-Key": activeKey },
    body: JSON.stringify({ action: "approve" }),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean } };
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

describe("integration-legibility — the authorization core made reachable", () => {
  // ── Fix #2: cold auto-grant a low-sensitivity first-party READ (NO owner step) ──
  it("cold session invokes a first-party READ with no token → auto-granted + result + token", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);

    const res = await invokeWithSession(app, hs.sessionId, "mock.note.read", { path: "a.md" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeResponse;
    // The call PROCEEDED — real result, no human.
    expect(body.ok).toBe(true);
    expect((body.output as { ran?: string }).ran).toBe("mock.note.read");
    // The freshly-minted scoped token is ATTACHED so the agent keeps it.
    expect(body.grant).toBeTruthy();
    expect(typeof (body.grant as ScopedToken).token).toBe("string");
    expect((body.grant as ScopedToken).scopes.some((s) => s.id === "mock.note.read")).toBe(true);

    // And the attached token works directly on a subsequent Bearer invoke (no re-grant).
    const again = await invokeWithToken(app, (body.grant as ScopedToken).token, "mock.note.read", {
      path: "b.md",
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as InvokeResponse).ok).toBe(true);
  });

  // ── Fix #1: an invoke for a WRITE returns a structured, actionable approval_required ──
  it("cold session invokes a first-party WRITE → structured approval_required + real pendingId", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);

    const res = await invokeWithSession(app, hs.sessionId, "mock.note.write", { path: "x", content: "y" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("approval_required");
    const pendingId = body.error?.pendingId;
    expect(typeof pendingId).toBe("string");
    expect(body.error?.approvalUrl).toContain("/admin");
    expect(body.error?.grantStatusUrl).toContain(pendingId as string);
    expect(body.error?.message).toContain("cannot mint its own token");

    // GET /grants/status FINDS the pending record the invoke created — polled by the ORIGINATING
    // session (P6-STATUS-AUTH: the status read is now bound to the session that created it).
    const statusRes = await req(app, `/grants/status?pendingId=${pendingId}`, {
      headers: { "X-Plexus-Session": hs.sessionId },
    });
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as GrantStatusResponse;
    expect(status.state).toBe("pending");
    expect(status.capabilities).toContain("mock.note.write");

    // Owner approves via the existing admin path → token appears → invoke works.
    const approved = await adminApprove(app, pendingId as string);
    expect(approved.status).toBe(200);
    expect(approved.body.ok).toBe(true);

    const after = (await (
      await req(app, `/grants/status?pendingId=${pendingId}`, {
        headers: { "X-Plexus-Session": hs.sessionId },
      })
    ).json()) as GrantStatusResponse;
    expect(after.state).toBe("approved");
    expect(after.token?.token).toBeTruthy();

    const done = await invokeWithToken(app, after.token!.token, "mock.note.write", { path: "x", content: "y" });
    expect(done.status).toBe(200);
    expect(((await done.json()) as InvokeResponse).ok).toBe(true);
  });

  // ── Fix #4: preserve the classic owner-approval flow via PUT /grants (mesh/write path) ──
  it("PUT /grants for a WRITE pends with a pollable pendingId + approvalUrl (owner-approval preserved)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = await req(app, "/grants", {
      method: "PUT",
      headers: { "X-Plexus-Session": hs.sessionId },
      body: JSON.stringify({ grants: { "mock.note.write": "allow" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GrantPendingResponse;
    expect(body.status).toBe("grant_pending_user");
    expect(typeof body.pendingId).toBe("string");
    expect(body.approvalUrl).toContain("/admin");

    const approved = await adminApprove(app, body.pendingId);
    expect(approved.body.ok).toBe(true);
    const status = (await (
      await req(app, `/grants/status?pendingId=${body.pendingId}`, {
        headers: { "X-Plexus-Session": hs.sessionId },
      })
    ).json()) as GrantStatusResponse;
    expect(status.state).toBe("approved");
    expect(status.token?.token).toBeTruthy();
  });

  // ── Fix #3/#5: error hygiene — malformed body → 400, unknown id → 400 (never 500/hollow-200) ──
  it("malformed PUT /grants body → 400 (not a 500 crash)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    // Valid JSON but NO `grants` map — the shape that used to crash on Object.entries(undefined).
    const noGrants = await req(app, "/grants", {
      method: "PUT",
      headers: { "X-Plexus-Session": hs.sessionId },
      body: JSON.stringify({ sessionId: hs.sessionId }),
    });
    expect(noGrants.status).toBe(400);
    expect((await noGrants.json()).error.code).toBe("schema_validation_failed");

    // `grants` present but not an object.
    const badGrants = await req(app, "/grants", {
      method: "PUT",
      headers: { "X-Plexus-Session": hs.sessionId },
      body: JSON.stringify({ grants: "nope" }),
    });
    expect(badGrants.status).toBe(400);

    // A top-level array body.
    const arr = await req(app, "/grants", {
      method: "PUT",
      headers: { "X-Plexus-Session": hs.sessionId },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(arr.status).toBe(400);

    // Not-even-JSON.
    const notJson = await req(app, "/grants", {
      method: "PUT",
      headers: { "X-Plexus-Session": hs.sessionId },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
  });

  it("unknown capability id in PUT /grants → 400 with a validation detail (not a hollow 200 token)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = await req(app, "/grants", {
      method: "PUT",
      headers: { "X-Plexus-Session": hs.sessionId },
      body: JSON.stringify({ grants: { "mock.does.not.exist": "allow" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; detail?: { unknownCapabilities?: string[] } } };
    expect(body.error.code).toBe("schema_validation_failed");
    expect(body.error.detail?.unknownCapabilities).toContain("mock.does.not.exist");
  });

  // ── Fix #4 (discovery): the .well-known auth block advertises the grant-request path ──
  it(".well-known auth block advertises grantRequestUrl + method + session header + console", async () => {
    const { app } = freshApp();
    const res = await req(app, "/.well-known/plexus");
    const doc = (await res.json()) as WellKnownDocument;
    expect(doc.auth.grantRequestUrl).toContain("/grants");
    expect(doc.auth.grantRequestMethod).toBe("PUT");
    expect(doc.auth.sessionHeader).toBe("X-Plexus-Session");
    expect(doc.auth.consoleUrl).toContain("/admin");
  });

  // ── Fix #4: session plumbing consistency — the SAME session across GET and PUT /grants ──
  it("the same session (X-Plexus-Session header) works across PUT and GET /grants", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);

    // PUT via header (no body sessionId) → auto-granted read token (not "unknown session").
    const putRes = await req(app, "/grants", {
      method: "PUT",
      headers: { "X-Plexus-Session": hs.sessionId },
      body: JSON.stringify({ grants: { "mock.note.read": "allow" } }),
    });
    expect(putRes.status).toBe(200);
    const scoped = (await putRes.json()) as ScopedToken;
    expect(scoped.token).toBeTruthy();
    expect(scoped.scopes.some((s) => s.id === "mock.note.read")).toBe(true);

    // GET via the SAME header → the standing-grant ledger for this session's agent.
    const getRes = await req(app, "/grants", { headers: { "X-Plexus-Session": hs.sessionId } });
    expect(getRes.status).toBe(200);
    const list = (await getRes.json()) as { grants: { capabilityId: string }[] };
    expect(list.grants.some((g) => g.capabilityId === "mock.note.read")).toBe(true);
  });

  // ── No-session invoke returns actionable guidance, NOT a misleading "bad token" ──
  it("invoke with no token and no session → grant_required guidance pointing at the grant-request path", async () => {
    const { app, state } = freshApp();
    await handshake(app, state);
    const res = await req(app, "/invoke", {
      method: "POST",
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");
    expect(body.error?.grantRequestUrl).toContain("/grants");
    expect(body.error?.sessionHeader).toBe("X-Plexus-Session");
    // NEVER token_revoked / signature-invalid vocabulary when the true state is "no grant".
    expect(body.error?.message.toLowerCase()).not.toContain("signature");
  });

  // ── SIGNPOST: the root + unknown paths self-advertise the discovery doc (cold-agent entry) ──
  it("GET / returns 2xx pointing a cold agent at /.well-known/plexus", async () => {
    const { app } = freshApp();
    const res = await req(app, "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service?: string; discovery?: string; hint?: string };
    expect(body.service).toBe("plexus");
    expect(body.discovery).toBe("/.well-known/plexus");
    expect(body.hint).toContain("/.well-known/plexus");
  });

  it("an unknown path's 404 body names the discovery URL (not a bare unknown_capability)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/nope/does/not/exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string; discovery?: string } };
    // Existing typed code preserved…
    expect(body.error.code).toBe("unknown_capability");
    // …but now self-signposted toward discovery.
    expect(body.error.discovery).toBe("/.well-known/plexus");
    expect(body.error.message).toContain("/.well-known/plexus");
  });

  it("signposting is additive: /.well-known/plexus discovery is unchanged", async () => {
    const { app } = freshApp();
    const res = await req(app, "/.well-known/plexus");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as WellKnownDocument;
    // The real discovery doc still carries its auth block + request shapes (untouched).
    expect(doc.auth.grantRequestUrl).toContain("/grants");
    expect(doc.auth.requestShapes).toBeTruthy();
  });

  // ── Must-not-break: the connection-key is NOT a bearer token ──
  it("presenting the connection-key as a Bearer token is rejected (not accepted as a token)", async () => {
    const { app, state } = freshApp();
    await handshake(app, state);
    const res = await invokeWithToken(app, state.connectionKey.current(), "mock.note.read", { path: "a.md" });
    expect(res.status).not.toBe(200);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
  });

  // ── P6-SCHEMA: the .well-known auth block carries machine-readable request-shape hints ──
  it(".well-known auth block advertises request-shape hints for handshake / grant-request / invoke", async () => {
    const { app } = freshApp();
    const res = await req(app, "/.well-known/plexus");
    const doc = (await res.json()) as WellKnownDocument;
    const shapes = doc.auth.requestShapes;
    expect(shapes).toBeTruthy();

    // handshake: the AGENT path (ADR-4/ADR-5, v0.1.3) — present the durable PAT as an
    // `Authorization: Bearer` header with NO connectionKey body (that shape is ADMIN/owner-only).
    expect(shapes!.handshake.method).toBe("POST");
    expect(shapes!.handshake.url).toContain("/link/handshake");
    expect(shapes!.handshake.auth.toLowerCase()).toContain("bearer");
    expect(Object.keys(shapes!.handshake.body)).not.toContain("connectionKey");
    expect(shapes!.handshake.headers?.Authorization?.toLowerCase()).toContain("bearer");

    // grant-request: a `grants` DECISION-MAP object (not an array), session via the header.
    expect(shapes!.grantRequest.method).toBe("PUT");
    expect(shapes!.grantRequest.url).toContain("/grants");
    const grantsField = shapes!.grantRequest.body.grants as Record<string, string>;
    expect(typeof grantsField).toBe("object");
    expect(Array.isArray(grantsField)).toBe(false);
    expect(Object.values(grantsField)).toContain("allow");
    expect(shapes!.grantRequest.auth).toContain("X-Plexus-Session");

    // invoke: the capability field is `id` (NOT `capability`); Bearer + session header.
    expect(shapes!.invoke.method).toBe("POST");
    expect(shapes!.invoke.url).toContain("/invoke");
    expect(Object.keys(shapes!.invoke.body)).toContain("id");
    expect(Object.keys(shapes!.invoke.body)).not.toContain("capability");
    expect(shapes!.invoke.auth.toLowerCase()).toContain("bearer");
    expect(shapes!.invoke.auth).toContain("X-Plexus-Session");
  });

  // ── ADR-9: the .well-known auth block self-describes the enrollment bootstrap (code → PAT) ──
  it(".well-known auth block self-describes enrollment: POST /agents/enroll, {code}→{pat,agentId}, error codes", async () => {
    const { app } = freshApp();
    const res = await req(app, "/.well-known/plexus");
    const doc = (await res.json()) as WellKnownDocument;

    // The address is advertised (a cold agent never guesses the verb/path).
    expect(doc.auth.enrollmentUrl).toContain("/agents/enroll");

    const enroll = doc.auth.enrollment;
    expect(enroll).toBeTruthy();
    // Endpoint: POST /agents/enroll, code carried in the BODY (unauthenticated — the code IS the credential).
    expect(enroll!.method).toBe("POST");
    expect(enroll!.url).toContain("/agents/enroll");
    expect(doc.auth.enrollmentUrl!).toBe(enroll!.url);
    expect(enroll!.auth.toLowerCase()).toContain("code");

    // Request shape: `{ code }` — the load-bearing field the gateway reads.
    expect(Object.keys(enroll!.body)).toContain("code");

    // Success shape: `{ pat, agentId }` — the durable credential minted once.
    expect(Object.keys(enroll!.success)).toContain("pat");
    expect(Object.keys(enroll!.success)).toContain("agentId");

    // The typed rejection reasons the endpoint actually returns (match A1's contract exactly).
    expect(enroll!.errorCodes).toEqual(
      expect.arrayContaining(["malformed", "unknown_code", "code_expired", "code_consumed", "persist_failed"]),
    );

    // The PAT-storage instruction tells the agent to store it and present it at handshake.
    expect(enroll!.patStorage.toLowerCase()).toContain("handshake");
    expect(enroll!.patStorage.toLowerCase()).toMatch(/store|\.env/);
  });

  // ── ADR-9: the advertised enroll endpoint honors the described contract (endpoint truth) ──
  it("the advertised enroll endpoint rejects a bad code with a typed error code from the advertised set", async () => {
    const { app } = freshApp();
    const doc = (await (await req(app, "/.well-known/plexus")).json()) as WellKnownDocument;
    const enrollUrl = new URL(doc.auth.enrollment!.url).pathname;

    // A well-formed body with an unknown code → 401 + a typed reason the doc advertises.
    const res = await req(app, enrollUrl, {
      method: "POST",
      body: JSON.stringify({ code: "plx_enroll_not-a-real-code" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(doc.auth.enrollment!.errorCodes).toContain(body.error.code);
    expect(body.error.code).toBe("unknown_code");

    // A malformed body (no `code`) → 400 + the advertised `malformed` reason.
    const bad = await req(app, enrollUrl, { method: "POST", body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("malformed");
  });

  // ── P6-SCHEMA: the handshake 401 message NAMES the connectionKey body field ──
  it("handshake with a missing/misplaced connection-key → error names the connectionKey BODY field", async () => {
    const { app } = freshApp();
    // No connectionKey in the body (e.g. an agent that tried a header/bearer instead).
    const res = await req(app, "/link/handshake", {
      method: "POST",
      body: JSON.stringify({ client: { name: "cold" } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("connectionKey");
    // It must say the key belongs in the BODY, not merely "invalid or missing".
    expect(body.error.message.toLowerCase()).toContain("body");
  });

  // ── P6-STATUS-AUTH: /grants/status is bound to the ORIGINATING session ──
  it("originating session gets the token after approval; a different/no session does NOT", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    // A SECOND, unrelated live session (valid key) — a would-be pendingId thief.
    const other = await handshake(app, state, "other-agent");

    // Session A creates a pending WRITE grant via grant-assist invoke.
    const res = await invokeWithSession(app, hs.sessionId, "mock.note.write", { path: "x", content: "y" });
    expect(res.status).toBe(401);
    const pendingId = ((await res.json()) as InvokeResponse).error?.pendingId as string;
    expect(typeof pendingId).toBe("string");

    // NO session header → 403, no leak (holding just the pendingId is not enough).
    const anon = await req(app, `/grants/status?pendingId=${pendingId}`);
    expect(anon.status).toBe(403);

    // A DIFFERENT valid session → 403, no leak.
    const wrong = await req(app, `/grants/status?pendingId=${pendingId}`, {
      headers: { "X-Plexus-Session": other.sessionId },
    });
    expect(wrong.status).toBe(403);

    // Owner approves via the management/admin path.
    const approved = await adminApprove(app, pendingId);
    expect(approved.body.ok).toBe(true);

    // Even AFTER approval, the wrong session still cannot read the minted token.
    const wrongAfter = await req(app, `/grants/status?pendingId=${pendingId}`, {
      headers: { "X-Plexus-Session": other.sessionId },
    });
    expect(wrongAfter.status).toBe(403);
    expect((await wrongAfter.json()).token).toBeUndefined();

    // The ORIGINATING session gets the token — the owner-approval round-trip still works.
    const mineAfter = await req(app, `/grants/status?pendingId=${pendingId}`, {
      headers: { "X-Plexus-Session": hs.sessionId },
    });
    expect(mineAfter.status).toBe(200);
    const mineBody = (await mineAfter.json()) as GrantStatusResponse;
    expect(mineBody.state).toBe("approved");
    expect(mineBody.token?.token).toBeTruthy();

    // The management connection-key can also read status (the owner's console path).
    const mgmt = await req(app, `/grants/status?pendingId=${pendingId}`, {
      headers: { "X-Plexus-Connection-Key": activeKey },
    });
    expect(mgmt.status).toBe(200);
    expect(((await mgmt.json()) as GrantStatusResponse).token?.token).toBeTruthy();
  });
});
