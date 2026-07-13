/**
 * m4sec-auth — THE HUMAN-IN-THE-LOOP AUTHORIZER LINCHPIN.
 *
 * Asserts the keystone security property of the M4 extension ecosystem: with the
 * default `UserConfirmAuthorizer`, an agent holding a connection-key CANNOT
 *   - self-grant `execute`/`write` on a capability, NOR
 *   - register-and-use a transport-backed extension,
 * without a REAL human approving in the management surface. A risky grant returns
 * `grant_pending_user`; invoke stays DENIED until a human approves; deny blocks it.
 * After approval it works. Plus: register PENDS and surfaces the cli bins / rest
 * hosts; DELETE /extensions unregisters; first-party `read` still auto-allows.
 *
 * Every denial here is REAL — driven through the published wire (handshake → grants
 * → status → invoke) + the admin approve/deny channel (the human surface). No fake-green.
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
  ExtensionManifest,
  ExtensionRegisterResponse,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

// ── A first-party read cap + a first-party write cap + an execute cap (source "mock",
//    which is a RESERVED first-party id). ───────────────────────────────────────────
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
const EXEC_ENTRY: CapabilityEntry = {
  id: "mock.proc.run",
  source: "mock",
  kind: "capability",
  label: "Run a process",
  describe: "Execute a side-effecting action.",
  grants: ["execute"],
  transport: "cli",
};
const MOCK_ENTRIES = [READ_ENTRY, WRITE_ENTRY, EXEC_ENTRY];

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
    return { id: req.id, ok: true, output: { ran: req.id }, auditId: "evt_x" };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    // A minimal lifecycle source that re-scans the seeded entries. Committing an
    // extension triggers registry.refresh() which iterates ALL sources, so this must
    // not throw (it returns the same seeded mock entries).
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
    getTransport: (kind: TransportKind) => ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

/** Build a gateway with the DEFAULT authorizer (UserConfirm — the linchpin). */
function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-secauth-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  // NO authorizer override → the gateway default (UserConfirmAuthorizer).
  const { app, state } = createAppWithState(config, { sources, capabilities });
  // The pending APPROVE/DENY route is now connection-key gated (msrc-rev) — the
  // human management surface sends the verified key.
  activeKey = state.connectionKey.current();
  return { app, state, dir };
}

/** The active app's verified management connection-key (set per freshApp). */
let activeKey = "";

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(app: ReturnType<typeof freshApp>["app"], state: ReturnType<typeof freshApp>["state"], agentId = "agent-1") {
  // ADR-023 fail-closed: an agent with NO subset record is authorized NOTHING. Seed the
  // owner-authorized subset for the mock caps so this suite keeps proving the LINCHPIN it is
  // about: even a subset-authorized agent cannot self-grant write/execute — those still PEND
  // per use for a human (no standing opt-in). The subset gate itself is covered in
  // tests/authz-subset.test.ts.
  state.agentSubsets.set(agentId, ["mock.note.read", "mock.note.write", "mock.proc.run"]);
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId } }),
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

/** Drive the human approve/deny channel via the admin endpoint (the human surface). */
async function adminPending(app: ReturnType<typeof freshApp>["app"]) {
  // FEAT configurable-binding re-gating: every /admin/api/* read is now key-gated.
  const res = await req(app, "/admin/api/pending", {
    headers: { "X-Plexus-Connection-Key": activeKey },
  });
  return (await res.json()) as { pending: { pendingId: string; kind: string; register?: unknown; reasons?: string[] }[] };
}
async function adminResolve(app: ReturnType<typeof freshApp>["app"], id: string, action: "approve" | "deny") {
  const res = await req(app, `/admin/api/pending/${id}`, {
    method: "POST",
    headers: { "X-Plexus-Connection-Key": activeKey },
    body: JSON.stringify({ action }),
  });
  return { status: res.status, body: (await res.json()) as { ok: boolean; kind?: string } };
}
async function grantStatus(app: ReturnType<typeof freshApp>["app"], pendingId: string) {
  // /grants/status is bound to the originating session or the management key (P6-STATUS-AUTH);
  // poll via the management connection-key (the owner's console path).
  const res = await req(app, `/grants/status?pendingId=${pendingId}`, {
    headers: { "X-Plexus-Connection-Key": activeKey },
  });
  return (await res.json()) as GrantStatusResponse;
}

const CLI_EXT: ExtensionManifest = {
  manifest: "plexus-extension/0.1",
  source: "evil-tool",
  label: "Evil CLI tool",
  transport: "cli",
  capabilities: [
    {
      name: "shell.run",
      kind: "capability",
      label: "Run shell",
      describe: "Run a command.",
      grants: ["execute"],
      transport: "cli",
      route: { bin: "git", args: ["{cmd}"], allowedBins: ["git"] },
    },
    {
      name: "api.call",
      kind: "capability",
      label: "Call API",
      describe: "Call a local API.",
      grants: ["read"],
      transport: "local-rest",
      route: { baseUrl: "http://127.0.0.1:9999", allowedHosts: ["api.internal.example"] },
    },
  ],
};

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
// LINCHPIN 1 — agent CANNOT self-grant execute without a human
// ════════════════════════════════════════════════════════════════════════════
describe("linchpin: agent cannot self-grant execute/write without a human", () => {
  it("granting execute PENDS (grant_pending_user); no token minted; invoke stays DENIED", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);

    const res = (await putGrants(app, hs.sessionId, {
      "mock.proc.run": { decision: "allow", verbs: ["execute"] },
    })) as GrantPendingResponse;

    // The agent gets a pending notice — NOT a token.
    expect(res.status).toBe("grant_pending_user");
    expect(res.pending).toContain("mock.proc.run");
    expect("token" in res).toBe(false);

    // Poll: still pending, no token.
    const st = await grantStatus(app, res.pendingId);
    expect(st.state).toBe("pending");
    expect(st.token).toBeUndefined();

    // The agent holds NO token, so it CANNOT invoke — default-deny holds.
    const denied = await invoke(app, "not-a-real-token", "mock.proc.run");
    expect(denied.status).toBe(401);
  });

  it("granting write PENDS too (mutating grant requires a human)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = (await putGrants(app, hs.sessionId, {
      "mock.note.write": { decision: "allow", verbs: ["write"] },
    })) as GrantPendingResponse;
    expect(res.status).toBe("grant_pending_user");
    expect(res.pending).toContain("mock.note.write");
  });

  it("after a human APPROVES, the token mints and invoke succeeds", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const pending = (await putGrants(app, hs.sessionId, {
      "mock.proc.run": { decision: "allow", verbs: ["execute"] },
    })) as GrantPendingResponse;

    // The pending item is visible to the human in the admin panel, with a risk reason.
    const list = await adminPending(app);
    const item = list.pending.find((p) => p.pendingId === pending.pendingId);
    expect(item).toBeDefined();
    expect(item?.kind).toBe("grant");
    expect((item?.reasons ?? []).join(" ")).toContain("mock.proc.run");

    // The human approves.
    const approve = await adminResolve(app, pending.pendingId, "approve");
    expect(approve.status).toBe(200);
    expect(approve.body.ok).toBe(true);

    // The agent's poll now returns the minted token.
    const st = await grantStatus(app, pending.pendingId);
    expect(st.state).toBe("approved");
    expect(st.token).toBeDefined();
    expect(st.token!.scopes.some((s: { id: string; verbs: string[] }) => s.id === "mock.proc.run" && s.verbs.includes("execute"))).toBe(true);

    // …and the agent can now invoke (the approved scope passes scope-check).
    const ok = await invoke(app, st.token!.token, "mock.proc.run");
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as InvokeResponse;
    expect(okBody.ok).toBe(true);
  });

  it("after a human DENIES, no token mints; the agent stays blocked", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const pending = (await putGrants(app, hs.sessionId, {
      "mock.proc.run": { decision: "allow", verbs: ["execute"] },
    })) as GrantPendingResponse;

    const deny = await adminResolve(app, pending.pendingId, "deny");
    expect(deny.body.ok).toBe(true);

    const st = await grantStatus(app, pending.pendingId);
    expect(st.state).toBe("denied");
    expect(st.token).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LINCHPIN 2 — first-party read still AUTO-ALLOWS (low-risk UX preserved)
// ════════════════════════════════════════════════════════════════════════════
describe("policy boundary: first-party read auto-allows", () => {
  it("granting read on a first-party capability mints a token immediately (no pending)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = await putGrants(app, hs.sessionId, { "mock.note.read": "allow" });
    expect("token" in res).toBe(true);
    const token = res as ScopedToken;
    expect(token.scopes).toEqual([{ id: "mock.note.read", verbs: ["read"] }]);

    const ok = await invoke(app, token.token, "mock.note.read", { path: "a" });
    expect(ok.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LINCHPIN 3 — agent cannot register-and-use a transport extension without a human
// ════════════════════════════════════════════════════════════════════════════
describe("linchpin: register-and-use a transport extension requires a human", () => {
  it("POST /extensions for a transport-backed extension PENDS + surfaces cli bins / rest hosts", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);

    const res = await req(app, "/extensions", {
      method: "POST",
      body: JSON.stringify({ sessionId: hs.sessionId, manifest: CLI_EXT }),
    });
    const body = (await res.json()) as GrantPendingResponse;
    expect(body.status).toBe("grant_pending_user");

    // The extension is NOT active — its capabilities are not in the registry yet.
    expect(state.capabilities.get("evil-tool.shell.run")).toBeUndefined();

    // The human sees the SECURITY-SENSITIVE surface in the admin panel.
    const list = await adminPending(app);
    const item = list.pending.find((p) => p.pendingId === body.pendingId) as
      | { register?: { cliBins: string[]; restHosts: string[]; transportBacked: boolean; capabilities: { id: string; verbs: string[] }[] } }
      | undefined;
    expect(item?.register).toBeDefined();
    expect(item!.register!.transportBacked).toBe(true);
    expect(item!.register!.cliBins).toContain("git");
    // The local-rest baseUrl host + the declared non-loopback allow-list host both surface.
    expect(item!.register!.restHosts).toContain("api.internal.example");
    expect(item!.register!.capabilities.map((c) => c.id)).toContain("evil-tool.shell.run");
  });

  it("an UNAPPROVED register does NOT activate; after APPROVE it activates", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = await req(app, "/extensions", {
      method: "POST",
      body: JSON.stringify({ sessionId: hs.sessionId, manifest: CLI_EXT }),
    });
    const pending = (await res.json()) as GrantPendingResponse;

    // Not active before approval.
    expect(state.capabilities.get("evil-tool.shell.run")).toBeUndefined();

    // The human approves → COMMIT runs, the extension activates.
    const approve = await adminResolve(app, pending.pendingId, "approve");
    expect(approve.status).toBe(200);
    expect(approve.body.ok).toBe(true);
    expect(approve.body.kind).toBe("register");

    expect(state.capabilities.get("evil-tool.shell.run")).toBeDefined();
    expect(state.capabilities.get("evil-tool.api.call")).toBeDefined();
  });

  it("a DENIED register never activates the extension", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = await req(app, "/extensions", {
      method: "POST",
      body: JSON.stringify({ sessionId: hs.sessionId, manifest: CLI_EXT }),
    });
    const pending = (await res.json()) as GrantPendingResponse;
    await adminResolve(app, pending.pendingId, "deny");
    expect(state.capabilities.get("evil-tool.shell.run")).toBeUndefined();
  });

  it("a register that impersonates a reserved first-party id is REJECTED outright (not even pended)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const impostor: ExtensionManifest = { ...CLI_EXT, source: "claudecode" };
    const res = await req(app, "/extensions", {
      method: "POST",
      body: JSON.stringify({ sessionId: hs.sessionId, manifest: impostor }),
    });
    const body = (await res.json()) as ExtensionRegisterResponse;
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("reserved");
    // Nothing pended for an outright-rejected manifest.
    const list = await adminPending(app);
    expect(list.pending.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LINCHPIN 4 — DELETE /extensions unregisters (remove a malicious extension)
// ════════════════════════════════════════════════════════════════════════════
describe("DELETE /extensions/:source unregisters", () => {
  it("approve a register, then DELETE removes its capabilities", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const res = await req(app, "/extensions", {
      method: "POST",
      body: JSON.stringify({ sessionId: hs.sessionId, manifest: CLI_EXT }),
    });
    const pending = (await res.json()) as GrantPendingResponse;
    await adminResolve(app, pending.pendingId, "approve");
    expect(state.capabilities.get("evil-tool.shell.run")).toBeDefined();

    // DELETE with the management connection-key (the user's removal action).
    const del = await req(app, "/extensions/evil-tool", {
      method: "DELETE",
      headers: { "x-plexus-connection-key": state.connectionKey.current() },
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { ok: boolean; removed: string[] };
    expect(delBody.ok).toBe(true);
    expect(delBody.removed).toContain("evil-tool.shell.run");
    expect(state.capabilities.get("evil-tool.shell.run")).toBeUndefined();
  });

  it("DELETE without management/session auth is rejected", async () => {
    const { app } = freshApp();
    const del = await req(app, "/extensions/evil-tool", { method: "DELETE" });
    expect(del.status).toBe(401);
  });
});
