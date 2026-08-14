/**
 * The opt-in ASYNC INVOKE channel (ADR-029) — `POST /invoke {async:true}` →
 * `GET /invoke/status?runId=…`.
 *
 * What these assert, in one line each:
 *   A1  async accepts (202 + handle) and the result is collectable after it settles
 *   A2  the synchronous path is untouched by the feature existing
 *   A3  authorization is NOT deferred — every pre-dispatch denial still fires inline,
 *       audited, before any run exists
 *   A4  the handle is a locator, not a credential — collection re-proves identity, and
 *       "not yours" is indistinguishable from "no such run"
 *   A5  async does not remove backpressure — the per-agent in-flight ceiling holds
 *   A6  a settled run pushes `invoke_resolved` and stays repeatably readable
 *
 * The mock capability blocks on a gate this file releases, so "still running" and
 * "finished" are both deterministic rather than timing-dependent.
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
  ScopedToken,
  InvokeRunStatus,
  PlexusEvent,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";
import { MAX_CONCURRENT_RUNS_PER_AGENT } from "@plexus/runtime/core/invoke-runs.ts";

// ── a capability that finishes only when this file says so ───────────────────
const SLOW_ENTRY: CapabilityEntry = {
  id: "mock.slow.run",
  source: "mock",
  kind: "capability",
  label: "A slow mock run",
  describe: "Blocks until the test releases it. Stands in for a real coding run.",
  io: { input: { type: "object", properties: { prompt: { type: "string" } } } },
  grants: ["execute"],
  transport: "ipc",
  longRunning: true,
};

/** A capability deliberately left OUT of every agent's subset (for the denial test). */
const FORBIDDEN_ENTRY: CapabilityEntry = {
  ...SLOW_ENTRY,
  id: "mock.forbidden.run",
  label: "Never granted",
};

const MOCK_ENTRIES = [SLOW_ENTRY, FORBIDDEN_ENTRY];

/** The gate every dispatch awaits; `release()` lets all in-flight dispatches finish. */
let gate: { promise: Promise<void>; release: () => void };
function newGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = () => r();
  });
  gate = { promise, release };
}
newGate();

class MockBridge implements CapabilityBridge {
  readonly source = "mock";
  constructor(private readonly deps: BridgeDeps) {}
  getCapabilities(): CapabilityEntry[] {
    return MOCK_ENTRIES;
  }
  route(id: CapabilityId) {
    return MOCK_ENTRIES.some((e) => e.id === id) ? ("handled" as const) : ("passthrough" as const);
  }
  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    await gate.promise;
    const audit = await this.deps.audit({
      type: "invoke",
      agentId: ctx.agentId ?? "",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      capabilityId: req.id,
      verbs: ["execute"],
      outcome: "ok",
      detail: { transport: "ipc" },
    });
    return { id: req.id, ok: true, output: { echoed: req.input ?? {} }, auditId: audit.id };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "ipc",
    createSource: () => {
      throw new Error("scan not used here");
    },
    createBridge: (deps: BridgeDeps) => new MockBridge(deps),
  };
  return {
    all: () => [module],
    get: (id) => (id === "mock" ? module : undefined),
    getTransport: (kind: TransportKind) =>
      ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

// ── harness ──────────────────────────────────────────────────────────────────
const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-async-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  newGate();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES) {
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  }
  // The async CHANNEL is what's under test, not the confirm authorizer — grants mint
  // directly so each test reaches /invoke. The gates themselves are asserted in A3.
  const { app, state } = createAppWithState(config, {
    sources,
    capabilities,
    authorizer: new AutoApproveAuthorizer(),
  });
  return { app, state, dir };
}

type App = ReturnType<typeof freshApp>["app"];
type State = ReturnType<typeof freshApp>["state"];

async function req(app: App, path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Handshake + grant `mock.slow.run` to `agentId`; returns its session, token, manifest. */
async function connect(app: App, state: State, agentId: string) {
  state.agentSubsets.set(agentId, [SLOW_ENTRY.id]);
  const key = state.connectionKey.current();
  const hsRes = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId } }),
  });
  const hs = (await hsRes.json()) as HandshakeResponse;
  const manifest = hs.manifest;
  const grantRes = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({
      sessionId: hs.sessionId,
      grants: { [SLOW_ENTRY.id]: { decision: "allow", verbs: ["execute"] } },
    }),
  });
  const token = (await grantRes.json()) as ScopedToken;
  return { sessionId: hs.sessionId, token: token.token, manifest };
}

/** Fire an async invoke and return the parsed response. */
async function invokeAsync(app: App, token: string, id: CapabilityId = SLOW_ENTRY.id) {
  const res = await req(app, "/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, async: true, input: { prompt: "do the thing" } }),
  });
  return { res, body: (await res.json()) as InvokeResponse };
}

async function status(app: App, runId: string, headers: Record<string, string>) {
  const res = await req(app, `/invoke/status?runId=${runId}`, { headers });
  return { res, body: (await res.json()) as InvokeRunStatus & { error?: { message: string } } };
}

/** Let the gate open and give the detached dispatch a turn to settle. */
async function releaseAndDrain() {
  gate.release();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
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

describe("A1 — async accept and collection", () => {
  it("returns 202 + a run handle instead of a result, then yields the result once settled", async () => {
    const { app, state } = freshApp();
    const { token, sessionId, manifest } = await connect(app, state, "agent-1");

    // The agent-facing hint survives manifest projection — the whole async story is
    // keyed off an agent reading this on the entry it is about to call.
    expect(manifest.entries.find((e) => e.id === SLOW_ENTRY.id)?.longRunning).toBe(true);

    const { res, body } = await invokeAsync(app, token);
    expect(res.status).toBe(202);
    // `ok:true` means ACCEPTED — the tell is `run` present and `output` absent.
    expect(body.ok).toBe(true);
    expect(body.output).toBeUndefined();
    expect(body.run?.runId).toMatch(/^run_/);
    expect(body.run?.status).toBe("running");
    expect(body.run?.statusUrl).toContain("/invoke/status?runId=");

    const runId = body.run!.runId;
    const auth = { authorization: `Bearer ${token}` };

    const mid = await status(app, runId, auth);
    expect(mid.res.status).toBe(200);
    expect(mid.body.status).toBe("running");
    expect(mid.body.result).toBeUndefined();
    expect(mid.body.id).toBe(SLOW_ENTRY.id);

    await releaseAndDrain();

    const done = await status(app, runId, auth);
    expect(done.body.status).toBe("succeeded");
    expect(done.body.finishedAt).toBeTruthy();
    // The result is the SAME shape the synchronous call would have returned.
    expect(done.body.result?.ok).toBe(true);
    expect(done.body.result?.output).toEqual({ echoed: { prompt: "do the thing" } });
    expect(done.body.result?.auditId).toBeTruthy();

    // The session header is an equally valid credential for collection.
    const viaSession = await status(app, runId, { "x-plexus-session": sessionId });
    expect(viaSession.res.status).toBe(200);
    expect(viaSession.body.status).toBe("succeeded");
  });
});

describe("A2 — the synchronous path is unchanged", () => {
  it("a call without `async` still returns 200 with the result inline and no handle", async () => {
    const { app, state } = freshApp();
    const { token } = await connect(app, state, "agent-1");
    gate.release(); // synchronous callers must not block on the gate

    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: SLOW_ENTRY.id, input: { prompt: "sync" } }),
    });
    const body = (await res.json()) as InvokeResponse;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.run).toBeUndefined();
    expect(body.output).toEqual({ echoed: { prompt: "sync" } });
  });
});

describe("A3 — authorization is not deferred by going async", () => {
  it("an out-of-subset capability is denied INLINE on the async path, and opens no run", async () => {
    const { app, state } = freshApp();
    const { token } = await connect(app, state, "agent-1");

    // `mock.forbidden.run` is a real registry entry the agent holds no scope for.
    const { res, body } = await invokeAsync(app, token, FORBIDDEN_ENTRY.id);
    expect(res.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("grant_required");
    expect(body.run).toBeUndefined();
    // Audited like any other denial — the async path did not swallow it.
    expect(body.auditId).toBeTruthy();
    expect(state.invokeRuns.all().length).toBe(0);
  });

  it("an exposure-disabled capability is denied inline on the async path too", async () => {
    const { app, state } = freshApp();
    const { token } = await connect(app, state, "agent-1");
    state.exposure.setEnabled(SLOW_ENTRY.id, false);

    const { res, body } = await invokeAsync(app, token);
    expect(res.status).toBe(403);
    expect(body.error?.code).toBe("capability_unexposed");
    expect(state.invokeRuns.all().length).toBe(0);
  });

  it("a bad token never reaches the run store", async () => {
    const { app, state } = freshApp();
    await connect(app, state, "agent-1");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ id: SLOW_ENTRY.id, async: true }),
    });
    expect(res.status).toBe(401);
    expect(state.invokeRuns.all().length).toBe(0);
  });
});

describe("A4 — the handle is a locator, not a credential", () => {
  it("another agent cannot collect, and gets the SAME answer as for an unknown runId", async () => {
    const { app, state } = freshApp();
    const a = await connect(app, state, "agent-1");
    const b = await connect(app, state, "agent-2");

    const { body } = await invokeAsync(app, a.token);
    const runId = body.run!.runId;
    await releaseAndDrain();

    const stranger = await status(app, runId, { authorization: `Bearer ${b.token}` });
    const unknown = await status(app, "run_00000000-0000-4000-8000-000000000000", {
      authorization: `Bearer ${b.token}`,
    });

    expect(stranger.res.status).toBe(403);
    expect(unknown.res.status).toBe(403);
    // Byte-identical: the endpoint is never an existence oracle for runs.
    expect(stranger.body).toEqual(unknown.body);
    expect(stranger.body.result).toBeUndefined();
  });

  it("a REVOKED agent cannot collect a run it legitimately started", async () => {
    const { app, state } = freshApp();
    const { token, sessionId } = await connect(app, state, "agent-1");

    const { body } = await invokeAsync(app, token);
    const runId = body.run!.runId;

    // The owner revokes the agent mid-run: sessions die, their jtis are revoked.
    for (const jti of state.sessions.invalidateByAgentId("agent-1")) {
      state.revocation.revoke(jti, "revoked by owner");
    }
    await releaseAndDrain();

    // The run itself completed (already-authorized work is not aborted)...
    expect(state.invokeRuns.get(runId)?.status).toBe("succeeded");
    // ...but neither credential reaches the result any more.
    const viaToken = await status(app, runId, { authorization: `Bearer ${token}` });
    const viaSession = await status(app, runId, { "x-plexus-session": sessionId });
    expect(viaToken.res.status).toBe(403);
    expect(viaSession.res.status).toBe(403);
    expect(viaToken.body.result).toBeUndefined();
    expect(viaSession.body.result).toBeUndefined();
  });

  it("an unauthenticated read is refused", async () => {
    const { app, state } = freshApp();
    const { token } = await connect(app, state, "agent-1");
    const { body } = await invokeAsync(app, token);
    const bare = await status(app, body.run!.runId, {});
    expect(bare.res.status).toBe(403);
    expect(bare.body.result).toBeUndefined();
  });

  it("the owner's management key can collect any run", async () => {
    const { app, state } = freshApp();
    const { token } = await connect(app, state, "agent-1");
    const { body } = await invokeAsync(app, token);
    await releaseAndDrain();

    const owner = await status(app, body.run!.runId, {
      "x-plexus-connection-key": state.connectionKey.current(),
    });
    expect(owner.res.status).toBe(200);
    expect(owner.body.status).toBe("succeeded");
  });
});

describe("A5 — async keeps backpressure", () => {
  it("caps simultaneously-running invokes per agent", async () => {
    const { app, state } = freshApp();
    const { token } = await connect(app, state, "agent-1");

    for (let i = 0; i < MAX_CONCURRENT_RUNS_PER_AGENT; i++) {
      const { res } = await invokeAsync(app, token);
      expect(res.status).toBe(202);
    }
    const over = await invokeAsync(app, token);
    expect(over.res.status).toBe(429);
    expect(over.body.error?.code).toBe("rate_limited");
    expect(over.body.run).toBeUndefined();

    // Settled runs do not hold a slot — draining frees capacity.
    await releaseAndDrain();
    newGate();
    const after = await invokeAsync(app, token);
    expect(after.res.status).toBe(202);
  });
});

describe("A6 — resolution is pushed, and the result is repeatable", () => {
  it("publishes invoke_resolved and stays readable across repeated collections", async () => {
    const { app, state } = freshApp();
    const { token } = await connect(app, state, "agent-1");

    const seen: PlexusEvent[] = [];
    state.events.subscribe((e) => seen.push(e));

    const { body } = await invokeAsync(app, token);
    const runId = body.run!.runId;
    await releaseAndDrain();

    const resolved = seen.find((e) => e.type === "invoke_resolved");
    expect(resolved).toBeDefined();
    expect(resolved).toMatchObject({ runId, id: SLOW_ENTRY.id, status: "succeeded" });
    // The push carries NO output — the notification travels, the payload does not.
    expect((resolved as unknown as { result?: unknown }).result).toBeUndefined();

    const auth = { authorization: `Bearer ${token}` };
    const first = await status(app, runId, auth);
    const second = await status(app, runId, auth);
    expect(first.body.result?.output).toEqual(second.body.result?.output);
    expect(second.res.status).toBe(200);
  });
});
