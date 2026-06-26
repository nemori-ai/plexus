/**
 * Central `io.input` validation (post-rc1 review): the gateway must honor the
 * input schemas it publishes, enforced ONCE at the invoke chokepoint
 * (`validateInput` in `core/pipeline.ts`, called from `invokeById` step 4b)
 * BEFORE the source/bridge handler runs.
 *
 * Strictness contract (lightweight, hand-rolled — NOT a JSON-Schema engine):
 *   - every `required` key present;
 *   - each PROVIDED property with a primitive `type` matches it;
 *   - unknown top-level keys rejected ONLY when `additionalProperties:false`;
 *   - entries with no schema / no properties+required pass through unchanged.
 *
 * Violations fail the invoke with the EXISTING `schema_validation_failed` code
 * (HTTP 422), in the uniform InvokeResponse-shaped denial body.
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
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";
import { validateInput } from "@plexus/runtime/core/pipeline.ts";

// ── Mock entries exercising each strictness rule ──────────────────────────────

// required `path:string`, optional `count:integer`; default additionalProperties.
const TYPED_ENTRY: CapabilityEntry = {
  id: "mock.typed",
  source: "mock",
  kind: "capability",
  label: "Typed entry",
  describe: "Has a typed input schema. Use to test validation.",
  io: {
    input: {
      type: "object",
      properties: { path: { type: "string" }, count: { type: "integer" } },
      required: ["path"],
    },
  },
  grants: ["read"],
  transport: "local-rest",
};

// additionalProperties:false — extras rejected.
const STRICT_ENTRY: CapabilityEntry = {
  id: "mock.strict",
  source: "mock",
  kind: "capability",
  label: "Strict entry",
  describe: "Rejects unknown keys. Use to test additionalProperties:false.",
  io: {
    input: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  grants: ["read"],
  transport: "local-rest",
};

// NO io schema at all — must pass through unaffected.
const SCHEMALESS_ENTRY: CapabilityEntry = {
  id: "mock.schemaless",
  source: "mock",
  kind: "capability",
  label: "Schemaless entry",
  describe: "Declares no input schema. Use to test pass-through.",
  grants: ["read"],
  transport: "local-rest",
};

const MOCK_ENTRIES = [TYPED_ENTRY, STRICT_ENTRY, SCHEMALESS_ENTRY];

/** Mock bridge: echoes input. Records the ids that actually reached dispatch. */
const dispatched: { ids: string[] } = { ids: [] };

class MockBridge implements CapabilityBridge {
  readonly source = "mock";
  constructor(
    private readonly deps: BridgeDeps,
    private readonly _sessionId: string,
  ) {}
  getCapabilities(): CapabilityEntry[] {
    return MOCK_ENTRIES;
  }
  route(id: CapabilityId) {
    return MOCK_ENTRIES.some((e) => e.id === id) ? ("handled" as const) : ("passthrough" as const);
  }
  async invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    dispatched.ids.push(req.id);
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
      throw new Error("scan not used in validation tests");
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

// ── harness ───────────────────────────────────────────────────────────────────
const config = loadConfig();
const HOST = expectedHost(config);
let tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-iotest-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const sources = mockRegistry();
  const capabilities = createCapabilityRegistry(sources);
  for (const e of MOCK_ENTRIES)
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(e.id, e);
  const { app, state } = createAppWithState(config, {
    sources,
    capabilities,
    authorizer: new AutoApproveAuthorizer(),
  });
  return { app, state };
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
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId: "agent-1" } }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grantToken(
  app: ReturnType<typeof freshApp>["app"],
  sessionId: string,
  id: string,
) {
  const grantRes = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
  });
  return (await grantRes.json()) as ScopedToken;
}

beforeEach(() => {
  dispatched.ids = [];
});

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

// ── pure-function unit checks (no HTTP) ───────────────────────────────────────
describe("validateInput (unit)", () => {
  const schema = TYPED_ENTRY.io!.input;

  it("missing required key → error naming the key", () => {
    expect(validateInput(schema, {})).toContain("path");
  });

  it("wrong primitive type → error naming the key", () => {
    const e = validateInput(schema, { path: 123 });
    expect(e).toContain("path");
    expect(e).toContain("string");
  });

  it("integer must be a whole number", () => {
    expect(validateInput(schema, { path: "a", count: 1.5 })).toContain("count");
    expect(validateInput(schema, { path: "a", count: 3 })).toBeUndefined();
  });

  it("valid input passes", () => {
    expect(validateInput(schema, { path: "a.md" })).toBeUndefined();
  });

  it("extras allowed by default (no additionalProperties:false)", () => {
    expect(validateInput(schema, { path: "a.md", extra: true })).toBeUndefined();
  });

  it("additionalProperties:false rejects an unknown key", () => {
    const strict = STRICT_ENTRY.io!.input;
    expect(validateInput(strict, { name: "x", bogus: 1 })).toContain("bogus");
    expect(validateInput(strict, { name: "x" })).toBeUndefined();
  });

  it("no schema / no properties+required passes through", () => {
    expect(validateInput(undefined, { anything: 1 })).toBeUndefined();
    expect(validateInput(true, { anything: 1 })).toBeUndefined();
    expect(validateInput({ type: "object" }, { anything: 1 })).toBeUndefined();
  });
});

// ── end-to-end through the invoke chokepoint ──────────────────────────────────
describe("io.input validation at the invoke chokepoint", () => {
  it("missing required → schema_validation_failed (422), never dispatched", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantToken(app, hs.sessionId, "mock.typed");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.typed", input: {} }),
    });
    expect(res.status).toBe(422);
    const b = (await res.json()) as InvokeResponse;
    expect(b.ok).toBe(false);
    expect(b.error?.code).toBe("schema_validation_failed");
    expect(b.error?.message).toContain("path");
    expect(dispatched.ids).not.toContain("mock.typed");
  });

  it("wrong primitive type → schema_validation_failed (422)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantToken(app, hs.sessionId, "mock.typed");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.typed", input: { path: 42 } }),
    });
    expect(res.status).toBe(422);
    const b = (await res.json()) as InvokeResponse;
    expect(b.error?.code).toBe("schema_validation_failed");
    expect(dispatched.ids).not.toContain("mock.typed");
  });

  it("valid input passes through to the bridge", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantToken(app, hs.sessionId, "mock.typed");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.typed", input: { path: "a.md", count: 2 } }),
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as InvokeResponse;
    expect(b.ok).toBe(true);
    expect(dispatched.ids).toContain("mock.typed");
  });

  it("an entry with no schema is unaffected", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);
    const token = await grantToken(app, hs.sessionId, "mock.schemaless");
    const res = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.schemaless", input: { whatever: 1 } }),
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as InvokeResponse;
    expect(b.ok).toBe(true);
    expect(dispatched.ids).toContain("mock.schemaless");
  });

  it("additionalProperties:false rejects an unknown key (default allows extras)", async () => {
    const { app, state } = freshApp();
    const hs = await handshake(app, state);

    // Strict entry: an extra key is rejected.
    const strictToken = await grantToken(app, hs.sessionId, "mock.strict");
    const rejected = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${strictToken.token}` },
      body: JSON.stringify({ id: "mock.strict", input: { name: "ok", bogus: 1 } }),
    });
    expect(rejected.status).toBe(422);
    const rb = (await rejected.json()) as InvokeResponse;
    expect(rb.error?.code).toBe("schema_validation_failed");
    expect(rb.error?.message).toContain("bogus");

    // Default (typed) entry: an extra key is allowed.
    const typedToken = await grantToken(app, hs.sessionId, "mock.typed");
    const allowed = await req(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${typedToken.token}` },
      body: JSON.stringify({ id: "mock.typed", input: { path: "a.md", extra: true } }),
    });
    expect(allowed.status).toBe(200);
    const ab = (await allowed.json()) as InvokeResponse;
    expect(ab.ok).toBe(true);
  });
});
