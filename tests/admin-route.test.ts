/**
 * Admin route gate (t11) — the local management client surface.
 *
 * Verifies the gateway SERVES the admin SPA + exposes the same-origin admin API:
 *   - GET /admin serves HTML same-origin (the SPA, or the not-built fallback),
 *   - the admin API endpoints respond same-origin (capabilities,
 *     grants → token, tokens list, revoke, audit),
 *   - there is NO `GET /admin/api/connection-key` route (F2): the key is never
 *     fetchable over HTTP, on either the /admin or /v1/admin mount,
 *   - a CROSS-ORIGIN request to /admin/* is still rejected by the Host/Origin
 *     guard (§5b) — the admin surface inherits the loopback-only guarantee.
 *
 * Mirrors the security-adversarial harness: an in-memory mock source so the
 * registry has real entries to list/grant, and a fresh PLEXUS_HOME per app.
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
  ScopedToken,
  GrantResponse,
  RevokeResponse,
  AuditEvent,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

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

const WRITE_ENTRY: CapabilityEntry = {
  id: "mock.note.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock note",
  describe: "Write a note.",
  grants: ["read", "write"],
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
    return { id: req.id, ok: true, auditId: "evt_x" };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    createSource: () => {
      throw new Error("scan not used in admin tests");
    },
    createBridge: (_deps: BridgeDeps, _sessionId: string) => new MockBridge(),
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

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-admin-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  const { app, state } = createAppWithState(config, { sources, capabilities });
  // Mutating admin routes are connection-key gated (msrc-rev); the management
  // surface sends the verified key, so the test helper mirrors that.
  activeKey = state.connectionKey.current();
  return { app, state, dir };
}

/** The active app's verified management connection-key (set per freshApp). */
let activeKey = "";

function req(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "X-Plexus-Connection-Key": activeKey, ...(init?.headers ?? {}) },
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

describe("admin: serves the SPA same-origin", () => {
  it("GET /admin returns HTML 200 same-origin", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.toLowerCase()).toContain("<!doctype html>");
  });

  it("a cross-origin request to /admin is still guarded (host_forbidden)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/capabilities", {
      headers: { origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });

  it("a non-loopback Host to /admin is rejected (DNS-rebinding)", async () => {
    const { app } = freshApp();
    const res = await app.request("http://evil.example.com/admin/api/capabilities", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("host_forbidden");
  });
});

describe("admin: API endpoints respond same-origin", () => {
  it("F2: GET /admin/api/connection-key is NOT a route (404) — never disclosed over HTTP", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/connection-key");
    expect(res.status).toBe(404);
    // And the body must not leak the key anywhere in its payload.
    const text = await res.text();
    expect(text).not.toContain(activeKey);
  });

  it("F2: the /v1/admin/api/connection-key alias is ALSO gone (404)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/v1/admin/api/connection-key");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(activeKey);
  });

  it("F2: agent-facing surfaces never serialize the connection-key value", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // .well-known is UNAUTHENTICATED + agent-reachable: send no key, assert none back.
    const wk = await app.request("http://" + HOST + "/.well-known/plexus", {
      headers: { host: HOST },
    });
    expect(wk.status).toBe(200);
    const wkText = await wk.text();
    expect(wkText).not.toContain(key);

    // The handshake response (session bootstrap) returns a Manifest, never the key.
    const hs = await app.request("http://" + HOST + "/link/handshake", {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: JSON.stringify({ connectionKey: key, client: { name: "agent-x", agentId: "agent-x" } }),
    });
    const hsText = await hs.text();
    // The echoed request body would contain the key; assert the RESPONSE does not.
    expect(hs.status).toBe(200);
    expect(hsText).not.toContain(key);

    // The pre-session manifest + the management event stream snapshot are key-free too.
    const mani = await app.request("http://" + HOST + "/manifest", { headers: { host: HOST } });
    const maniText = await mani.text();
    expect(maniText).not.toContain(key);
  });

  it("GET /admin/api/capabilities lists the full self-describe entries", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gateway: { name: string };
      entries: CapabilityEntry[];
    };
    expect(body.gateway.name).toBe("plexus");
    const ids = body.entries.map((e) => e.id);
    expect(ids).toContain("mock.note.read");
    expect(ids).toContain("mock.note.write");
    // Full entries carry io/grants (unlike the .well-known summary tier).
    const read = body.entries.find((e) => e.id === "mock.note.read")!;
    expect(read.grants).toEqual(["read"]);
    expect(read.io).toBeDefined();
  });

  it("PUT /admin/api/grants issues a scoped token (read-write maps to verbs)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/grants", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grants: {
          "mock.note.read": { decision: "allow", verbs: ["read"] },
          "mock.note.write": { decision: "allow", verbs: ["read", "write"] },
        },
      }),
    });
    expect(res.status).toBe(200);
    const token = (await res.json()) as GrantResponse;
    expect("token" in token).toBe(true);
    if ("token" in token) {
      const byId = Object.fromEntries(token.scopes.map((s) => [s.id, s.verbs]));
      expect(byId["mock.note.read"]).toEqual(["read"]);
      expect(byId["mock.note.write"]).toEqual(["read", "write"]);
    }
  });

  it("GET /admin/api/tokens lists active tokens; POST /admin/api/revoke kills one", async () => {
    const { app } = freshApp();
    const grantRes = await req(app, "/admin/api/grants", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grants: { "mock.note.read": "allow" } }),
    });
    const token = (await grantRes.json()) as ScopedToken;
    expect(token.jti).toBeTruthy();

    const listRes = await req(app, "/admin/api/tokens");
    const list = (await listRes.json()) as { tokens: { jti: string }[] };
    expect(list.tokens.some((t) => t.jti === token.jti)).toBe(true);

    const revokeRes = await req(app, "/admin/api/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jti: token.jti }),
    });
    expect(revokeRes.status).toBe(200);
    const revoked = (await revokeRes.json()) as RevokeResponse;
    expect(revoked.revokedJtis).toContain(token.jti);

    const afterRes = await req(app, "/admin/api/tokens");
    const after = (await afterRes.json()) as { tokens: { jti: string }[] };
    expect(after.tokens.some((t) => t.jti === token.jti)).toBe(false);
  });

  it("GET /admin/api/audit returns the audit trail (grant/token events recorded)", async () => {
    const { app } = freshApp();
    await req(app, "/admin/api/grants", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grants: { "mock.note.read": "allow" } }),
    });
    const res = await req(app, "/admin/api/audit");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: AuditEvent[] };
    expect(Array.isArray(body.events)).toBe(true);
    const types = body.events.map((e) => e.type);
    expect(types).toContain("grant.allow");
    expect(types).toContain("token.issue");
  });

});
