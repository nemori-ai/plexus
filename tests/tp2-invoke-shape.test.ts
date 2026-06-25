/**
 * tp2 / ADR-017 — `/invoke` returns ONE result contract for ALL outcomes.
 *
 * `POST /invoke` ALWAYS replies with an `InvokeResponse`-shaped body
 * (`{ id, ok, error?, auditId }`) — for success AND for EVERY denial, including
 * auth/pre-dispatch ones that in v0.1.0 came back as the bare `ErrorResponse`
 * envelope (`{error:{…}}`, no `id`/`ok`/`auditId`). The closed `ErrorCode` and the
 * per-denial HTTP status are preserved; only the surrounding body is unified.
 *
 * These tests assert the SHAPE (not just `error.code`): a denial body has
 * `ok === false` (NOT `undefined`) and a present `id`, while keeping the right HTTP
 * status. A transport failure still surfaces as in-band `{ ok:false, error }` (200).
 *
 * Sandboxes gateway state into a fresh PLEXUS_HOME scratch dir per app, mirroring
 * core-pipeline.test.ts.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
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
  ErrorCode,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

// ── Mock entries ──────────────────────────────────────────────────────────────
// `mock.note.read` succeeds; `mock.note.boom` always throws at the transport so we
// can exercise the in-band transport-failure path.
const READ_ENTRY: CapabilityEntry = {
  id: "mock.note.read",
  source: "mock",
  kind: "capability",
  label: "Read a mock note",
  describe: "Read a note. Use when you need note text.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["read"],
  transport: "local-rest",
};

const BOOM_ENTRY: CapabilityEntry = {
  id: "mock.note.boom",
  source: "mock",
  kind: "capability",
  label: "A capability whose transport blows up",
  describe: "Always throws at dispatch. Use to prove the transport-failure path.",
  grants: ["read"],
  transport: "local-rest",
};

const MOCK_ENTRIES = [READ_ENTRY, BOOM_ENTRY];

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
    if (entry.id === "mock.note.boom") {
      // A transport-level throw → the pipeline catches it, audits outcome="error",
      // and returns an in-band `{ ok:false, error.code:"transport_error" }` (HTTP 200).
      throw new Error("kaboom: underlying service unreachable");
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
let tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-tp2-"));
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
) {
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "tp2", agentId: "agent-tp2" } }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grantRead(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
  id: CapabilityId,
) {
  const res = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

beforeEach(() => {});

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

/** Assert a body is InvokeResponse-SHAPED on a denial (the heart of ADR-017). */
function expectInvokeDenialShape(body: unknown, id: string, code: ErrorCode) {
  const b = body as InvokeResponse;
  // The crux: a naive agent reads `ok` and gets `false`, NOT `undefined`.
  expect(b.ok).toBe(false);
  expect(typeof b.ok).toBe("boolean");
  expect(b.id).toBe(id);
  expect(b.error?.code).toBe(code);
  // `auditId` is ALWAYS present in the unified shape (audited id or "" sentinel).
  expect(typeof b.auditId).toBe("string");
  // It must NOT be the bare ErrorResponse envelope (no top-level `id`/`ok`/`auditId`).
  expect("ok" in (body as object)).toBe(true);
  expect("id" in (body as object)).toBe(true);
}

describe("tp2 / ADR-017 — /invoke single result contract for denials", () => {
  it("no-token /invoke → InvokeResponse-shaped { ok:false, error.code:'grant_required', id } at 401", async () => {
    const { app, state } = freshApp();
    await handshake(app, state);
    const res = await req(app, "/invoke", {
      method: "POST",
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    // HTTP status preserved (auth class).
    expect(res.status).toBe(401);
    const body = await res.json();
    expectInvokeDenialShape(body, "mock.note.read", "grant_required");
    // Edge denial (before the pipeline audits) ⇒ the empty-string auditId sentinel.
    expect((body as InvokeResponse).auditId).toBe("");
  });

  it("un-granted (valid token, no scope) /invoke → grant_required as InvokeResponse shape, audited", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    // Grant READ only, then invoke the BOOM entry the token does not cover.
    const token = await grantRead(app, hs.sessionId, "mock.note.read");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.boom", input: {} }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as InvokeResponse;
    expectInvokeDenialShape(body, "mock.note.boom", "grant_required");
    // This denial WAS audited by the pipeline ⇒ a real (non-empty) audit id.
    expect(body.auditId.length).toBeGreaterThan(0);
  });

  it("unknown_capability /invoke → InvokeResponse shape at 404", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantRead(app, hs.sessionId, "mock.note.read");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.nope", input: {} }),
    });
    expect(res.status).toBe(404);
    expectInvokeDenialShape(await res.json(), "mock.note.nope", "unknown_capability");
  });

  it("forged token /invoke → token_revoked as InvokeResponse shape at 401", async () => {
    const { app, state } = freshApp();
    await handshake(app, state);
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: "Bearer not.a.real.jwt" },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as InvokeResponse;
    expectInvokeDenialShape(body, "mock.note.read", "token_revoked");
    expect(body.auditId).toBe(""); // edge denial, no audit
  });

  it("schema_validation_failed /invoke → InvokeResponse shape at 422", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantRead(app, hs.sessionId, "mock.note.read");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: {} }), // missing required `path`
    });
    expect(res.status).toBe(422);
    expectInvokeDenialShape(await res.json(), "mock.note.read", "schema_validation_failed");
  });

  it("a transport failure STILL returns in-band { ok:false, error } at HTTP 200", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantRead(app, hs.sessionId, "mock.note.boom");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.boom", input: {} }),
    });
    // Dispatch-level failure stays at 200 with an in-band error (unchanged).
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(false);
    expect(body.id).toBe("mock.note.boom");
    expect(body.error?.code).toBe("transport_error");
    expect(body.auditId.length).toBeGreaterThan(0); // the transport error WAS audited
  });

  it("a successful /invoke is the SAME shape (ok:true) at 200 — the contract is uniform", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantRead(app, hs.sessionId, "mock.note.read");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "a.md" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as InvokeResponse;
    expect(body.ok).toBe(true);
    expect(body.id).toBe("mock.note.read");
    expect(typeof body.auditId).toBe("string");
    expect(body.auditId.length).toBeGreaterThan(0);
  });
});
