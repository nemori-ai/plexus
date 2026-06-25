/**
 * REVOKE AUTHORIZATION (tv2 — Low-severity security fix).
 *
 * `POST /grants/revoke` must enforce the frozen §4c / ADR-006/010 contract: the
 * Host/Origin loopback guard alone does NOT authorize a revoke. A revoke is
 * accepted ONLY if EITHER
 *   (a) it carries the management connection-key (management session), OR
 *   (b) it presents a valid Bearer token whose `jti` matches the jti being revoked
 *       (an agent revoking its OWN token).
 * Everything else is rejected. Each assertion below is a REAL denial / success —
 * no fake-green.
 *
 * Mirrors the security-adversarial harness (mock in-memory source, fresh PLEXUS_HOME).
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
  RevokeResponse,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

// ── A single grantable read capability is all we need to mint a real token. ──
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

const MOCK_ENTRIES = [READ_ENTRY];

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
    const audit = await this.deps.audit({
      type: "invoke",
      agentId: ctx.agentId ?? "",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      capabilityId: req.id,
      verbs: ["read"],
      outcome: "ok",
      detail: {},
    });
    return { id: req.id, ok: true, output: {}, auditId: audit.id };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    createSource: () => {
      throw new Error("scan not used in tv2 tests");
    },
    createBridge: (deps: BridgeDeps, sessionId: string) => new MockBridge(deps, sessionId),
  };
  return {
    all: () => [module],
    get: (id) => (id === "mock" ? module : undefined),
    getTransport: (kind) => ({ kind, dispatch: async () => ({ ok: true }) }) as Transport,
  };
}

const config = loadConfig();
const HOST = expectedHost(config);
let tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-tv2-"));
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
  return (await res.json()) as HandshakeResponse;
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

/** Mint a real scoped-token for a given agent, returning the token + jti. */
async function mintToken(
  app: ReturnType<typeof freshApp>["app"],
  state: ReturnType<typeof freshApp>["state"],
  agentId: string,
): Promise<ScopedToken> {
  const hs = await handshake(app, state, agentId);
  return grant(app, hs.sessionId, { "mock.note.read": "allow" });
}

describe("tv2 — POST /grants/revoke authorization", () => {
  beforeEach(() => {
    tmpDirs = [];
  });
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("rejects a revoke with NO credential (no connection-key, no token)", async () => {
    const { app, state } = freshApp();
    const tok = await mintToken(app, state, "agent-1");

    const res = await req(app, "/grants/revoke", {
      method: "POST",
      body: JSON.stringify({ jti: tok.jti }),
    });

    // Real denial: rejected with the contract-consistent closed-union code,
    // 401 status, and the token must NOT have been revoked.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session_expired");
    expect(state.revocation.isRevoked(tok.jti)).toBe(false);
  });

  it("succeeds with a valid connection-key (management session)", async () => {
    const { app, state } = freshApp();
    const tok = await mintToken(app, state, "agent-1");

    const res = await req(app, "/grants/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": state.connectionKey.current() },
      body: JSON.stringify({ jti: tok.jti, reason: "management revoke" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RevokeResponse;
    expect(body.ok).toBe(true);
    expect(body.revokedJtis).toContain(tok.jti);
    expect(state.revocation.isRevoked(tok.jti)).toBe(true);
  });

  it("succeeds when an agent revokes its OWN jti with that token", async () => {
    const { app, state } = freshApp();
    const tok = await mintToken(app, state, "agent-1");

    const res = await req(app, "/grants/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${tok.token}` },
      body: JSON.stringify({ jti: tok.jti }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RevokeResponse;
    expect(body.ok).toBe(true);
    expect(body.revokedJtis).toContain(tok.jti);
    expect(state.revocation.isRevoked(tok.jti)).toBe(true);
  });

  it("rejects revoking a DIFFERENT jti with a token that doesn't own it", async () => {
    const { app, state } = freshApp();
    const victim = await mintToken(app, state, "agent-victim");
    const attacker = await mintToken(app, state, "agent-attacker");
    expect(victim.jti).not.toBe(attacker.jti);

    // Attacker presents its OWN valid token but tries to revoke the victim's jti.
    const res = await req(app, "/grants/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${attacker.token}` },
      body: JSON.stringify({ jti: victim.jti }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session_expired");
    // The victim's token must remain live.
    expect(state.revocation.isRevoked(victim.jti)).toBe(false);
  });
});
