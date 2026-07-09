/**
 * Audit REQUEST/RESULT capture (web-admin Activity view: "至少请求和返回要展示").
 *
 * Each `invoke` audit item now carries `input` (the request args) and `output`
 * (the result, or `{ error }` for a denial/failure), surfaced VERBATIM through
 * GET /admin/api/audit. CRITICAL contract: the SINGLE audit writer redacts (per
 * `AuditRedactionPolicy.redactedKeys`) AND size-caps these fields, so a secret in
 * the call input is NEVER persisted, and an unbounded blob never lands on disk.
 *
 * Two layers:
 *   1. the writer in isolation (redaction + truncation of input/output);
 *   2. the full path handshake → grant → invoke → GET /admin/api/audit, asserting
 *      the activity item the frontend consumes carries redacted input + output.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
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
  AuditEvent,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, AutoApproveAuthorizer } from "@plexus/runtime/auth/index.ts";
import { createAuditWriter } from "@plexus/runtime/audit/index.ts";

const tmpDirs: string[] = [];
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

// ── 1. The writer in isolation: redaction + truncation of input/output ────────
describe("audit writer: redacts + truncates captured input/output", () => {
  it("masks secret-bearing keys and clips long strings, never leaking the secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-auditw-"));
    tmpDirs.push(dir);
    const writer = createAuditWriter(dir);

    const longValue = "Z".repeat(1200);
    const persisted = await writer.write({
      type: "invoke",
      capabilityId: "mock.note.read",
      outcome: "ok",
      input: {
        path: "a.md",
        token: "sk-SUPER-SECRET-VALUE",
        nested: { connectionKey: "plx_live_LEAK", note: longValue },
      },
      output: { echoed: { path: "a.md", token: "sk-SUPER-SECRET-VALUE" }, blob: longValue },
    });

    const input = persisted.input as Record<string, unknown>;
    const output = persisted.output as Record<string, unknown>;

    // Shape preserved, plain values kept.
    expect(input.path).toBe("a.md");
    // Secret VALUES masked (key survives so the shape stays auditable).
    expect(input.token).toBe("[redacted]");
    expect((input.nested as Record<string, unknown>).connectionKey).toBe("[redacted]");
    // Long string truncated + marked (capped well below the original 1200).
    const note = (input.nested as Record<string, unknown>).note as string;
    expect(note.length).toBeLessThan(600);
    expect(note).toContain("chars]");
    // Output is captured + redacted the same way.
    expect((output.echoed as Record<string, unknown>).token).toBe("[redacted]");

    // The redaction CONTRACT: the raw secret never reaches disk, anywhere.
    // createAuditWriter(dir) roots the JSONL AT `dir` (the default only appends
    // "audit" when no dir is given), so read straight from `dir`.
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const content = readFileSync(join(dir, file), "utf8");
    expect(content).not.toContain("sk-SUPER-SECRET-VALUE");
    expect(content).not.toContain("plx_live_LEAK");
    // And no unbounded blob: the 1200-char string is not persisted whole.
    expect(content).not.toContain(longValue);
  });

  it("caps oversized arrays/objects (no unbounded blob)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plexus-auditw-"));
    tmpDirs.push(dir);
    const writer = createAuditWriter(dir);
    const persisted = await writer.write({
      type: "invoke",
      capabilityId: "mock.bulk",
      outcome: "ok",
      output: { items: Array.from({ length: 200 }, (_v, i) => i) },
    });
    const items = (persisted.output as { items: unknown[] }).items;
    // Capped to the array ceiling + one truncation marker entry.
    expect(items.length).toBeLessThanOrEqual(51);
    expect(items[items.length - 1]).toContain("items]");
  });
});

// ── 2. End-to-end: the activity item served by GET /admin/api/audit ───────────
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

/** A bridge that captures input + output on its invoke audit (like the real bridges). */
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
    const entry = this.deps.getEntry(req.id)!;
    const output = { echoed: req.input ?? {} };
    const audit = await this.deps.audit({
      type: "invoke",
      agentId: ctx.agentId ?? "",
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      capabilityId: entry.id,
      verbs: entry.grants,
      outcome: "ok",
      detail: { transport: entry.transport },
      input: req.input,
      output,
    });
    return { id: entry.id, ok: true, output, auditId: audit.id };
  }
  async disconnect(): Promise<void> {}
}

function mockRegistry(): SourceRegistry {
  const module: SourceModule = {
    id: "mock",
    label: "Mock",
    transport: "local-rest",
    createSource: () => {
      throw new Error("scan not used");
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

const config = loadConfig();
const HOST = expectedHost(config);

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-auditio-"));
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
  return { app, state, dir, key: state.connectionKey.current() };
}

function reqApp(app: ReturnType<typeof freshApp>["app"], path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handshake(app: ReturnType<typeof freshApp>["app"], key: string) {
  const res = await reqApp(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId: "agent-1" } }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function auditItems(
  app: ReturnType<typeof freshApp>["app"],
  key: string,
): Promise<AuditEvent[]> {
  const res = await reqApp(app, "/admin/api/audit", { headers: { "X-Plexus-Connection-Key": key } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: AuditEvent[] }).events;
}

describe("GET /admin/api/audit: invoke items carry request + result", () => {
  it("a successful invoke surfaces redacted input + output", async () => {
    const { app, key } = freshApp();
    const hs = await handshake(app, key);
    const grantRes = await reqApp(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { "mock.note.read": "allow" } }),
    });
    const token = (await grantRes.json()) as ScopedToken;

    await reqApp(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({
        id: "mock.note.read",
        input: { path: "secret.md", token: "sk-LEAK-ME", note: "n".repeat(900) },
      }),
    });

    const events = await auditItems(app, key);
    const invoke = events.find((e) => e.type === "invoke" && e.outcome === "ok");
    expect(invoke).toBeDefined();
    const input = invoke!.input as Record<string, unknown>;
    expect(input.path).toBe("secret.md");
    // Secret in the request is redacted before it ever reaches the admin surface.
    expect(input.token).toBe("[redacted]");
    expect((input.note as string).length).toBeLessThan(600);
    // The result is captured too (the Activity view's "result" pane).
    const output = invoke!.output as { echoed: Record<string, unknown> };
    expect(output.echoed.path).toBe("secret.md");
    expect(output.echoed.token).toBe("[redacted]");

    // Belt-and-suspenders: the raw secret is nowhere in the served payload.
    const res = await reqApp(app, "/admin/api/audit", {
      headers: { "X-Plexus-Connection-Key": key },
    });
    expect(await res.text()).not.toContain("sk-LEAK-ME");
  });

  it("GET /admin/api/audit/:id returns one event's input + output (the Realtime row expander)", async () => {
    const { app, key } = freshApp();
    const hs = await handshake(app, key);
    const grantRes = await reqApp(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { "mock.note.read": "allow" } }),
    });
    const token = (await grantRes.json()) as ScopedToken;
    await reqApp(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.read", input: { path: "one.md" } }),
    });

    const events = await auditItems(app, key);
    const invoke = events.find((e) => e.type === "invoke" && e.outcome === "ok");
    expect(invoke).toBeDefined();

    // The single-event detail endpoint the ledger fetches on expand.
    const one = await reqApp(app, `/admin/api/audit/${invoke!.id}`, {
      headers: { "X-Plexus-Connection-Key": key },
    });
    expect(one.status).toBe(200);
    const { event } = (await one.json()) as { event: AuditEvent };
    expect(event.id).toBe(invoke!.id);
    expect((event.input as Record<string, unknown>).path).toBe("one.md");
    expect(event.output).toBeDefined();

    // Unknown id → 404, not a leak of some other event.
    const miss = await reqApp(app, "/admin/api/audit/evt_does-not-exist", {
      headers: { "X-Plexus-Connection-Key": key },
    });
    expect(miss.status).toBe(404);
  });

  it("a denied invoke surfaces input + the error as output", async () => {
    const { app, key } = freshApp();
    const hs = await handshake(app, key);
    // Grant only read; attempt the un-granted WRITE → grant_required denial.
    const grantRes = await reqApp(app, "/grants", {
      method: "PUT",
      body: JSON.stringify({ sessionId: hs.sessionId, grants: { "mock.note.read": "allow" } }),
    });
    const token = (await grantRes.json()) as ScopedToken;
    await reqApp(app, "/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${token.token}` },
      body: JSON.stringify({ id: "mock.note.write", input: { path: "x.md" } }),
    });

    const events = await auditItems(app, key);
    const denied = events.find((e) => e.type === "invoke" && e.outcome === "denied");
    expect(denied).toBeDefined();
    expect((denied!.input as Record<string, unknown>).path).toBe("x.md");
    const out = denied!.output as { error: { code: string; message: string } };
    expect(out.error.code).toBe("grant_required");
    expect(typeof out.error.message).toBe("string");
  });
});
