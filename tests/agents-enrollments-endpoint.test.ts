/**
 * AGENT-ENROLLMENTS — GET /admin/api/agents/enrollments (agent-skill-compile §3 Auth model).
 *
 * The Agents tab knows an agent's GRANTS but not its ENROLLMENT lifecycle. This mgmt-gated
 * read projects the per-agent enrollment ledger so the console can distinguish a
 * provisioned-but-not-yet-redeemed agent ("pending", awaiting install) from an enrolled one
 * ("active"). Proves:
 *   - 401 without the management connection-key (never agent-reachable);
 *   - after connect(A) the row is `pending` (code minted, PAT not yet redeemed);
 *   - after redeem the row flips `active`;
 *   - the response NEVER leaks the persisted codeHash / patHash — only agentId + status +
 *     lifecycle timestamps.
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
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

const WRITE_ENTRY: CapabilityEntry = {
  id: "mock.doc.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock doc",
  describe: "Write a doc.",
  grants: ["write"],
  transport: "local-rest",
};
const MOCK_ENTRIES = [WRITE_ENTRY];

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
  home = mkdtempSync(join(tmpdir(), "plexus-enroll-ep-"));
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

function req(app: App, path: string, init?: RequestInit) {
  return app.request("http://" + HOST + path, {
    ...init,
    headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function connect(app: App, key: string, agentId: string, capabilities: string[]) {
  const res = await req(app, "/admin/api/agents/connect", {
    method: "POST",
    headers: { "x-plexus-connection-key": key },
    body: JSON.stringify({ agentId, capabilities }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function enrollments(app: App, key: string) {
  const res = await req(app, "/admin/api/agents/enrollments", {
    headers: { "x-plexus-connection-key": key },
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("GET /admin/api/agents/enrollments", () => {
  it("mgmt-gated: without the connection-key it is 401 (never agent-reachable)", async () => {
    const { app } = freshApp();
    const res = await req(app, "/admin/api/agents/enrollments");
    expect(res.status).toBe(401);
  });

  it("shows a freshly-connected agent as `pending` (code minted, not yet redeemed)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.write"]);

    const { status, body } = await enrollments(app, key);
    expect(status).toBe(200);
    const row = body.agents.find((a: any) => a.agentId === "agent-A");
    expect(row).toBeDefined();
    expect(row.status).toBe("pending");
    expect(typeof row.issuedAt).toBe("string");
    // No PAT yet → no redeemedAt / revokedAt.
    expect(row.redeemedAt).toBeUndefined();
    expect(row.revokedAt).toBeUndefined();
  });

  it("flips to `active` after the code is redeemed for a PAT", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.write"]);

    // Redeem the one-time code → durable PAT, via the public agent enroll surface.
    const redeem = await req(app, "/agents/enroll", {
      method: "POST",
      body: JSON.stringify({ code: conn.code }),
    });
    expect(redeem.status).toBe(200);

    const { body } = await enrollments(app, key);
    const row = body.agents.find((a: any) => a.agentId === "agent-A");
    expect(row.status).toBe("active");
    expect(typeof row.redeemedAt).toBe("string");
  });

  it("NEVER leaks the code/PAT hashes — only agentId + status + timestamps", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { body: conn } = await connect(app, key, "agent-A", ["mock.doc.write"]);
    await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code: conn.code }) });

    const { body } = await enrollments(app, key);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("codeHash");
    expect(serialized).not.toContain("patHash");
    // Defensive: the raw code hash must not appear either.
    const row = body.agents.find((a: any) => a.agentId === "agent-A");
    expect(Object.keys(row).sort()).toEqual(
      ["agentId", "codeExpiresAt", "issuedAt", "redeemedAt", "status"].sort(),
    );
  });
});
