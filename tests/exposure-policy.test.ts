/**
 * Top-level capability EXPOSURE policy ("What I expose") — REAL enforcement.
 *
 * Proves all four semantics of the owner's enable/disable switch, intersected with
 * the grant model (effective access = granted ∧ exposed):
 *   1. Disabled = INVISIBLE   — absent from `.well-known` summaries AND `GET /manifest`.
 *   2. Disabled = NOT GRANTABLE — a `PUT /grants` request is rejected (no token, no pend).
 *   3. Disabled = NOT INVOKABLE — even a PRE-EXISTING valid token is DENIED at the
 *      pipeline (`capability_unexposed`), audited; the grant RECORD is preserved.
 *   4. Granted-but-disabled is FLAGGED in the admin grants list (`topLevelDisabled`).
 *   + Re-enabling restores invoke (intersection, not revocation).
 *   + Default (no policy) = fully exposed (no regression).
 *
 * Each test sandboxes gateway state into a fresh PLEXUS_HOME scratch dir, and toggles
 * exposure through the REAL admin endpoint (connection-key gated).
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
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
  StandingGrant,
  WellKnownDocument,
  GrantsListResponse,
  Manifest,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";

// ── Two leaf capabilities (read + write) on a mock source ────────────────────
const READ_ENTRY: CapabilityEntry = {
  id: "mock.note.read",
  source: "mock",
  kind: "capability",
  label: "Read a mock note",
  describe: "Read a note from the mock source.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["read"],
  transport: "local-rest",
};

const WRITE_ENTRY: CapabilityEntry = {
  id: "mock.note.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock note",
  describe: "Write a note in the mock source.",
  grants: ["write"],
  transport: "local-rest",
};

const MOCK_ENTRIES = [READ_ENTRY, WRITE_ENTRY];

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
      throw new Error("scan not used in exposure tests");
    },
    createBridge: (deps: BridgeDeps, sessionId: string) => new MockBridge(deps, sessionId),
  };
  const transports: Partial<Record<TransportKind, Transport>> = {};
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

// ── harness ──────────────────────────────────────────────────────────────────
const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-exposure-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  invokeSpy.calls = [];
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  // Permissive authorizer so grants mint directly (the confirm linchpin is not under test).
  const { app, state } = createAppWithState(config, {
    sources,
    capabilities,
    authorizer: new AutoApproveAuthorizer(),
  });
  return { app, state, dir, key: state.connectionKey.current() };
}

type App = ReturnType<typeof freshApp>["app"];

function req(app: App, path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(app: App, state: ReturnType<typeof freshApp>["state"]) {
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({
      connectionKey: state.connectionKey.current(),
      client: { name: "test", agentId: "agent-1" },
    }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grantRead(app: App, sessionId: string): Promise<ScopedToken> {
  const res = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { "mock.note.read": "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

function setExposure(app: App, key: string, id: string, enabled: boolean) {
  return req(app, `/admin/api/exposure/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "X-Plexus-Connection-Key": key },
    body: JSON.stringify({ enabled }),
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

// ── 0. DEFAULT (no policy) = fully exposed (no regression) ───────────────────
describe("exposure default", () => {
  it("with no policy, capabilities are exposed + grantable + invokable", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);

    const wk = (await (await req(app, "/.well-known/plexus")).json()) as WellKnownDocument;
    expect(wk.capabilities.map((s) => s.id)).toContain("mock.note.read");

    const token = await grantRead(app, hs.sessionId);
    expect(token.scopes).toEqual([{ id: "mock.note.read", verbs: ["read"] }]);

    const inv = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(inv.status).toBe(200);
    expect(((await inv.json()) as InvokeResponse).ok).toBe(true);
  });
});

// ── 1. DISABLED = INVISIBLE (discovery: .well-known + manifest) ──────────────
describe("exposure semantic #1 — disabled is invisible", () => {
  it("a disabled capability is absent from .well-known AND the manifest; revision bumps", async () => {
    const { app, state, key } = freshApp();
    const hs = await handshake(app, state);

    const revBefore = (
      (await (await req(app, "/manifest", { headers: { "x-plexus-session": hs.sessionId } })).json()) as {
        manifest: Manifest;
      }
    ).manifest.revision;

    const toggle = await setExposure(app, key, "mock.note.read", false);
    expect(toggle.status).toBe(200);

    const wk = (await (await req(app, "/.well-known/plexus")).json()) as WellKnownDocument;
    const wkIds = wk.capabilities.map((s) => s.id);
    expect(wkIds).not.toContain("mock.note.read");
    expect(wkIds).toContain("mock.note.write"); // the enabled sibling is still visible

    const mani = (
      (await (await req(app, "/manifest", { headers: { "x-plexus-session": hs.sessionId } })).json()) as {
        manifest: Manifest;
      }
    ).manifest;
    expect(mani.entries.map((e) => e.id)).not.toContain("mock.note.read");
    expect(mani.entries.map((e) => e.id)).toContain("mock.note.write");
    // Revision bumped so connected agents re-fetch.
    expect(mani.revision).toBeGreaterThan(revBefore);
  });
});

// ── 2. DISABLED = NOT GRANTABLE ──────────────────────────────────────────────
describe("exposure semantic #2 — disabled is not grantable", () => {
  it("a grant request for a disabled capability is rejected (no token, not pended)", async () => {
    const { app, state, key } = freshApp();
    const hs = await handshake(app, state);
    await setExposure(app, key, "mock.note.read", false);

    const res = await req(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { "mock.note.read": "allow" } }),
    });
    const body = (await res.json()) as Partial<ScopedToken> & { status?: string; pending?: string[] };
    // Rejected: the request was NOT pended, and the response carries NO scope for the
    // disabled capability (an empty-scope token, identical to an explicit-deny request —
    // it confers nothing).
    expect(body.status).not.toBe("grant_pending_user");
    expect(body.pending ?? []).not.toContain("mock.note.read");
    expect((body.scopes ?? []).map((s) => s.id)).not.toContain("mock.note.read");
    // No persisted grant exists for the disabled capability.
    expect(state.grants.get("agent-1", "mock.note.read")).toBeUndefined();
  });
});

// ── 3. DISABLED = NOT INVOKABLE — the INTERSECTION (the security crux) ───────
describe("exposure semantic #3 — pre-existing token denied when disabled", () => {
  it("an already-held valid token is DENIED (capability_unexposed); grant record preserved", async () => {
    const { app, state, key, dir } = freshApp();
    const hs = await handshake(app, state);

    // Grant + mint a token WHILE EXPOSED, and confirm it invokes.
    const token = await grantRead(app, hs.sessionId);
    const okInvoke = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(okInvoke.status).toBe(200);

    // Now DISABLE the capability — the standing grant + token still exist.
    await setExposure(app, key, "mock.note.read", false);
    expect(state.grants.get("agent-1", "mock.note.read")).toBeDefined(); // record preserved

    // The SAME still-valid token is now DENIED at the pipeline (the intersection).
    invokeSpy.calls = [];
    const denied = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error?: { code: string }; ok?: boolean };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("capability_unexposed");
    // The source was NEVER reached — denied pre-dispatch.
    expect(invokeSpy.calls).not.toContain("mock.note.read");

    // The denial was AUDITED (outcome denied + the distinct code).
    const auditDir = join(dir, "audit");
    expect(existsSync(auditDir)).toBe(true);
    const content = readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(auditDir, f), "utf8"))
      .join("\n");
    const lines = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const denial = lines.find(
      (l) =>
        l.type === "invoke" &&
        l.outcome === "denied" &&
        (l.detail as { code?: string } | undefined)?.code === "capability_unexposed",
    );
    expect(denial).toBeDefined();
  });
});

// ── 4. GRANTED-BUT-DISABLED is FLAGGED in the admin grants list ──────────────
describe("exposure semantic #4 — granted-but-disabled flag", () => {
  it("the admin grants list flags topLevelDisabled for a granted-but-disabled capability", async () => {
    const { app, state, key } = freshApp();
    const hs = await handshake(app, state);
    await grantRead(app, hs.sessionId);

    // While exposed: the grant is present WITHOUT the flag.
    const before = (
      (await (
        await req(app, "/admin/api/grants", { headers: { "X-Plexus-Connection-Key": key } })
      ).json()) as GrantsListResponse
    ).grants.find((g) => g.capabilityId === "mock.note.read");
    expect(before).toBeDefined();
    expect((before as StandingGrant & { topLevelDisabled?: boolean }).topLevelDisabled).toBeUndefined();

    // Disable → the SAME grant row now carries topLevelDisabled:true.
    await setExposure(app, key, "mock.note.read", false);
    const after = (
      (await (
        await req(app, "/admin/api/grants", { headers: { "X-Plexus-Connection-Key": key } })
      ).json()) as GrantsListResponse
    ).grants.find((g) => g.capabilityId === "mock.note.read");
    expect(after).toBeDefined();
    expect((after as StandingGrant & { topLevelDisabled?: boolean }).topLevelDisabled).toBe(true);
  });
});

// ── + RE-ENABLE restores invoke (intersection, not revocation) ───────────────
describe("exposure re-enable restores access", () => {
  it("re-enabling a disabled capability lets the preserved grant invoke again", async () => {
    const { app, state, key } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantRead(app, hs.sessionId);

    await setExposure(app, key, "mock.note.read", false);
    const denied = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(denied.status).toBe(403);

    // Re-enable — the preserved standing grant + token work again, no re-grant needed.
    const reenable = await setExposure(app, key, "mock.note.read", true);
    expect(reenable.status).toBe(200);
    const restored = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as InvokeResponse).ok).toBe(true);

    // Visible in discovery again.
    const wk = (await (await req(app, "/.well-known/plexus")).json()) as WellKnownDocument;
    expect(wk.capabilities.map((s) => s.id)).toContain("mock.note.read");
  });
});

// ── exposure store persistence + admin list ──────────────────────────────────
describe("exposure persistence + admin list", () => {
  it("the toggle persists to exposure.json and GET /api/exposure reports it", async () => {
    const { app, state, key, dir } = freshApp();
    await setExposure(app, key, "mock.note.read", false);

    // Persisted to ~/.plexus/exposure.json (record-of-truth).
    const file = join(dir, "exposure.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "mock.note.read": false });

    // The admin list reports per-capability exposure.
    const list = (await (
      await req(app, "/admin/api/exposure", { headers: { "X-Plexus-Connection-Key": key } })
    ).json()) as { capabilities: { id: string; enabled: boolean }[]; revision: number };
    const read = list.capabilities.find((c) => c.id === "mock.note.read");
    const write = list.capabilities.find((c) => c.id === "mock.note.write");
    expect(read?.enabled).toBe(false);
    expect(write?.enabled).toBe(true);

    // Re-enabling drops the key (back to the default; file becomes empty map).
    await setExposure(app, key, "mock.note.read", true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("the exposure toggle requires the management connection-key", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/exposure/mock.note.read", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(401);
  });
});
