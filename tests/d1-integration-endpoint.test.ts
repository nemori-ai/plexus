/**
 * D1-ENDPOINT — `GET /integration/:agentId` (agent-skill-compile §5, ADR-8, §9 Q#6).
 *
 * Proves the DELIVER half of "connect an agent": for an ALREADY-CONNECTED agent the
 * endpoint returns the copy-able ONE-COMMAND install — a fresh single-use enrollment
 * code riding the `installCommand`, plus the rendered CC-plugin files — gated by the
 * Floor oracle (G3 assertVerified) so an over-reaching artifact is never served.
 *
 *   - MGMT-GATED: without the connection-key it is 401 (never agent-reachable).
 *   - 200 with the key: a usable installCommand carrying a `plx_enroll_…` code + files
 *     that PASS `verifyPlugin` against the Floor; the code is REDEEMABLE (fresh, single-use).
 *   - ONLY GRANTED caps appear (a cap the agent was never granted is absent).
 *   - NO durable PAT + NO admin connection-key is served in any file.
 *   - A never-connected agent → 404.
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
  WellKnownDocument,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { buildWellKnown } from "@plexus/runtime/core/well-known.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { verifyPlugin } from "@plexus/runtime/integration/index.ts";

const READ_ENTRY: CapabilityEntry = {
  id: "mock.doc.read",
  source: "mock",
  kind: "capability",
  label: "Read a mock doc",
  describe: "Read a doc.",
  io: { input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  grants: ["read"],
  transport: "local-rest",
};
const WRITE_ENTRY: CapabilityEntry = {
  id: "mock.doc.write",
  source: "mock",
  kind: "capability",
  label: "Write a mock doc",
  describe: "Write a doc.",
  grants: ["write"],
  transport: "local-rest",
};
const MOCK_ENTRIES = [READ_ENTRY, WRITE_ENTRY];

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
    return { id: req.id, ok: true, output: { echoed: req.input ?? {} }, auditId: "test-audit" };
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
  home = mkdtempSync(join(tmpdir(), "plexus-d1-"));
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

/** POST /admin/api/agents/connect with the management key. */
async function connect(app: App, key: string, agentId: string, capabilities: string[]) {
  const res = await req(app, "/admin/api/agents/connect", {
    method: "POST",
    headers: { "x-plexus-connection-key": key },
    body: JSON.stringify({ agentId, capabilities }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** GET /integration/:agentId with the management key. */
async function getIntegration(app: App, key: string, agentId: string) {
  const res = await req(app, `/integration/${agentId}`, {
    headers: { "x-plexus-connection-key": key },
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** The Floor the endpoint compiles against (same doc the discovery handler serves). */
function floorOf(): WellKnownDocument {
  return buildWellKnown(config, MOCK_ENTRIES.map((e) => ({
    id: e.id,
    source: e.source,
    kind: e.kind,
    label: e.label,
    summary: e.describe,
    grants: e.grants,
    transport: e.transport,
  })));
}

describe("D1-ENDPOINT — GET /integration/:agentId", () => {
  it("mgmt-gated: without the connection-key it is 401 (never agent-reachable)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read"]);
    const res = await req(app, "/integration/agent-A"); // no key
    expect(res.status).toBe(401);
  });

  it("a wrong connection-key is also 401", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read"]);
    const res = await req(app, "/integration/agent-A", {
      headers: { "x-plexus-connection-key": "plx_wrong_key" },
    });
    expect(res.status).toBe(401);
  });

  it("a never-connected agent is 404", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    const { status, body } = await getIntegration(app, key, "ghost");
    expect(status).toBe(404);
    expect(body.error.code).toBe("unknown_agent");
  });

  it("200: returns a copy-able install carrying a FRESH single-use code + plugin files that pass verifyPlugin", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read"]);

    const { status, body } = await getIntegration(app, key, "agent-A");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe("agent-A");
    expect(body.dirName).toBe("plexus@agent-A");
    expect(typeof body.version).toBe("string");
    expect(Array.isArray(body.files)).toBe(true);

    // The copy-able install carries a fresh one-time code in an ENV var (ADR-8 shape).
    expect(body.installCommand).toContain("curl -fsSL");
    expect(body.installCommand).toContain("/integration/agent-A/install.sh");
    const codeMatch = body.installCommand.match(/PLEXUS_ENROLL_CODE="(plx_enroll_[^"]+)"/);
    expect(codeMatch).not.toBeNull();
    const code = codeMatch![1] as string;

    // The SAME live code is also exposed as a top-level `enrollCode` field (as generic/in-context
    // do), so the console has ONE authoritative live-code field across all forms — a delivery-form
    // switch then carries the LIVE code, never connect's superseded one.
    expect(body.enrollCode).toBe(code);

    // The rendered files pass the Floor oracle (G3) — never serve an over-reaching artifact.
    const rendered = { dirName: body.dirName, pluginName: "plexus", marketplaceName: "plexus", version: body.version, files: body.files, installCommand: body.installCommand };
    const verdict = verifyPlugin(rendered as any, floorOf(), { expectedCapabilityIds: ["mock.doc.read"] });
    expect(verdict.ok).toBe(true);

    // The served code is REAL + single-use: it redeems for a durable PAT at the public enroll surface.
    const enrollRes = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) });
    expect(enrollRes.status).toBe(200);
    const enroll = (await enrollRes.json()) as { pat?: string; agentId?: string };
    expect(enroll.pat).toMatch(/^plx_agent_/);
    expect(enroll.agentId).toBe("agent-A");
    // Single-use: a second redeem of the same code fails.
    const replay = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) });
    expect(replay.status).not.toBe(200);
  });

  it("each GET mints a FRESH code (codes are single-use), superseding the prior one", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read"]);
    const first = (await getIntegration(app, key, "agent-A")).body;
    const second = (await getIntegration(app, key, "agent-A")).body;
    const c1 = first.installCommand.match(/PLEXUS_ENROLL_CODE="([^"]+)"/)![1];
    const c2 = second.installCommand.match(/PLEXUS_ENROLL_CODE="([^"]+)"/)![1];
    expect(c1).not.toBe(c2);
    // The superseded first code no longer redeems.
    const stale = await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code: c1 }) });
    expect(stale.status).not.toBe(200);
  });

  it("only GRANTED caps appear + NO durable PAT or admin connection-key is served in any file", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    // Grant ONLY the read cap; the write cap is advertised by the Floor but NOT granted.
    await connect(app, key, "agent-A", ["mock.doc.read"]);

    const { body } = await getIntegration(app, key, "agent-A");
    expect(body.capabilities).toEqual(["mock.doc.read"]);

    const allContent = body.files.map((f: any) => f.content).join("\n");
    // The write cap the agent was never granted must not appear anywhere in the artifact.
    expect(allContent).not.toContain("mock.doc.write");
    // No durable PAT baked into any file (Inv III).
    expect(allContent).not.toMatch(/plx_agent_[A-Za-z0-9_-]{16,}/);
    // No baked one-time code in any file (it rides the command only).
    expect(allContent).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
    // The admin connection-key never leaks into a served file.
    expect(allContent).not.toContain(key);
  });

  // ── Bug A — re-viewing an ALREADY-ACTIVE agent must NOT silently de-enroll it ──────────────
  it("re-fetch after enroll keeps the agent ACTIVE + its PAT valid (no mint); explicit ?reissue=1 resets", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read"]);

    // (1) Fetch the install (mints a code for the pending agent), then REDEEM it → the agent goes
    //     ACTIVE and holds a durable PAT.
    const first = await getIntegration(app, key, "agent-A");
    const code = (first.body.installCommand as string).match(/PLEXUS_ENROLL_CODE="([^"]+)"/)![1]!;
    const enroll = (await (
      await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) })
    ).json()) as { pat: string };
    const pat = enroll.pat;
    expect(pat).toMatch(/^plx_agent_/);
    expect(state.agentEnrollment.isActive("agent-A")).toBe(true);
    expect(state.agentEnrollment.verifyPat(pat)).toBe("agent-A");

    // (2) RE-FETCH the install for the now-active agent WITHOUT reissue. This is the bug scenario:
    //     it must NOT mint / reset the row / drop the PAT.
    const again = await getIntegration(app, key, "agent-A");
    expect(again.status).toBe(200);
    expect(again.body.alreadyEnrolled).toBe(true);
    expect(again.body.reissued).toBe(false);
    expect(again.body.codeExpiresAt).toBeUndefined();
    // No live one-time code in the install command (it is the code-free re-materialize form).
    expect(again.body.installCommand).not.toMatch(/PLEXUS_ENROLL_CODE=/);
    expect(again.body.installCommand).toContain("/integration/agent-A/install.sh");
    // It still serves the compiled artifact (files + granted caps) — just without de-enrolling.
    expect(Array.isArray(again.body.files)).toBe(true);
    expect(again.body.capabilities).toEqual(["mock.doc.read"]);
    // THE FIX: the agent is STILL active and the ORIGINAL PAT still verifies.
    expect(state.agentEnrollment.isActive("agent-A")).toBe(true);
    expect(state.agentEnrollment.verifyPat(pat)).toBe("agent-A");

    // (3) The EXPLICIT re-issue path DOES reset (lost-PAT / re-install), invalidating the old PAT.
    const re = await req(app, "/integration/agent-A?reissue=1", {
      headers: { "x-plexus-connection-key": key },
    });
    const reBody = (await re.json()) as any;
    expect(reBody.reissued).toBe(true);
    expect(typeof reBody.codeExpiresAt).toBe("string");
    const newCode = (reBody.installCommand as string).match(/PLEXUS_ENROLL_CODE="([^"]+)"/)![1]!;
    expect(newCode).not.toBe(code);
    // The old PAT is now dead; the row is back to pending.
    expect(state.agentEnrollment.verifyPat(pat)).toBeNull();
    expect(state.agentEnrollment.isActive("agent-A")).toBe(false);
    // The freshly re-issued code redeems into a NEW working PAT.
    const re2 = (await (
      await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code: newCode }) })
    ).json()) as { pat: string };
    expect(re2.pat).toMatch(/^plx_agent_/);
    expect(state.agentEnrollment.verifyPat(re2.pat)).toBe("agent-A");
  });

  it("a revoked agent is 404 (nothing to reissue)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connect(app, key, "agent-A", ["mock.doc.read"]);
    // Revoke the agent → its enrollment row is tombstoned.
    await req(app, "/admin/api/agents/revoke", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId: "agent-A" }),
    });
    const { status } = await getIntegration(app, key, "agent-A");
    expect(status).toBe(404);
  });

  // ── GENERIC delivery — agentType-aware: the portable shape, not a compiled CC plugin ────────
  /** Connect an agent with an explicit agentType (default helper omits it). */
  async function connectTyped(app: App, key: string, agentId: string, agentType: string, capabilities: string[]) {
    const res = await req(app, "/admin/api/agents/connect", {
      method: "POST",
      headers: { "x-plexus-connection-key": key },
      body: JSON.stringify({ agentId, agentType, capabilities }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("generic agent: mgmt JSON returns a code-free setupCommand + instruction + separate enrollCode", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connectTyped(app, key, "gen-A", "generic", ["mock.doc.read"]);

    const { status, body } = await getIntegration(app, key, "gen-A");
    expect(status).toBe(200);
    expect(body.agentType).toBe("generic");
    // Portable shape — a code-free setup command + copy-able instruction text.
    expect(body.setupCommand).toContain("/integration/gen-A/setup.sh");
    expect(body.setupCommand).not.toMatch(/plx_enroll_/);
    expect(typeof body.instruction).toBe("string");
    expect(body.instruction).toContain("<!-- BEGIN PLEXUS -->");
    // The one-time code is delivered SEPARATELY (never inside a served artifact).
    expect(body.enrollCode).toMatch(/^plx_enroll_/);
    // The enroll command is spelled with the ABSOLUTE per-agent launcher (the launcher is not on
    // the shell PATH — agent-integration-project-scope §4.1/§4.5), under the gateway's resolved home.
    expect(body.enrollCommand).toBe(`${home}/agents/gen-A/bin/plexus enroll ${body.enrollCode}`);
    // The instruction is token-COMPLETE and teaches that same absolute launcher path.
    expect(body.instruction).not.toContain("{{PLEXUS_");
    expect(body.instruction).toContain(`${home}/agents/gen-A/bin/plexus`);
    // The code does NOT appear in the setup command or the instruction (Inv III).
    expect(body.setupCommand).not.toContain(body.enrollCode);
    expect(body.instruction).not.toContain(body.enrollCode);
    // The FORM-AGNOSTIC manual is present + code-free/key-free on the generic path too.
    expect(typeof body.manual).toBe("string");
    expect(body.manual).toContain("<!-- BEGIN PLEXUS MANUAL -->");
    expect(body.manual).not.toContain(body.enrollCode);
    expect(body.manual).not.toContain(key);
    expect(body.manual).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
    expect(body.manual).not.toMatch(/plx_agent_[A-Za-z0-9_-]{16,}/);
    // No compiled-plugin fields on the generic path.
    expect(body.files).toBeUndefined();

    // The served code is REAL + single-use.
    const enroll = (await (
      await req(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code: body.enrollCode }) })
    ).json()) as { pat?: string; agentId?: string };
    expect(enroll.pat).toMatch(/^plx_agent_/);
    expect(enroll.agentId).toBe("gen-A");
  });

  it("generic agent: PUBLIC setup.sh is key-free, code-free, and embeds the sanctioned engine", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connectTyped(app, key, "gen-A", "generic", ["mock.doc.read"]);

    // Reachable WITHOUT the connection-key (a cold agent has none).
    const res = await req(app, "/integration/gen-A/setup.sh");
    expect(res.status).toBe(200);
    const body = await res.text();
    // No baked one-time code, no durable PAT, no admin connection-key.
    expect(body).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
    expect(body).not.toMatch(/plx_agent_[A-Za-z0-9_-]{16,}/);
    expect(body).not.toContain(key);
    // It installs the sanctioned CLI (embeds the engine) + lands the instruction.
    expect(body).toContain("PLEXUS_EOF_ENGINE");
    expect(body).toContain("<!-- BEGIN PLEXUS -->");
    // Project-scope shape (agent-integration-project-scope §4): the launcher lands inside the
    // state home; AGENTS.md defaults to the project ($PWD); {{PLEXUS_CMD}} is filled at run time.
    expect(body).toContain('LAUNCHER="$PLEXUS_HOME/agents/$AGENT_ID/bin/plexus"');
    expect(body).toContain('AGENTS_FILE="${AGENTS_FILE:-$PWD/AGENTS.md}"');
    expect(body).toContain('sed "s#{{PLEXUS_CMD}}#$LAUNCHER#g"');
    expect(body).not.toContain(".local/bin");
  });

  it("claude-code agent still gets the compiled plugin + a canonical agentType (B1 single-dispatch)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connectTyped(app, key, "cc-A", "claude-code", ["mock.doc.read"]);
    const { body } = await getIntegration(app, key, "cc-A");
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.installCommand).toContain("/integration/cc-A/install.sh");
    expect(body.setupCommand).toBeUndefined();
    // B1 — the CC branch also returns the canonical agentType, so the console dispatches on ONE field.
    expect(body.agentType).toBe("claude-code");
    // The FORM-AGNOSTIC manual (the Manual tab is form-agnostic) is present + code-free on CC too.
    expect(typeof body.manual).toBe("string");
    expect(body.manual).toContain("<!-- BEGIN PLEXUS MANUAL -->");
    expect(body.manual).not.toContain(key);
    expect(body.manual).not.toMatch(/plx_enroll_[A-Za-z0-9_-]{16,}/);
    expect(body.manual).not.toMatch(/plx_agent_[A-Za-z0-9_-]{16,}/);
  });

  // ── A2 — the two PUBLIC bootstraps are agentType-gated (no cross-serve; no cap-set leak) ─────
  it("A2: install.sh is 404 for a GENERIC agent (its cap-set never leaks over the public route)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connectTyped(app, key, "gen-A", "generic", ["mock.doc.read"]);
    // No mgmt key — a cold agent's curl. install.sh is the CC bootstrap; a generic agent must 404.
    const res = await req(app, "/integration/gen-A/install.sh");
    expect(res.status).toBe(404);
    const body = await res.text();
    // Uniform "not connected" text — no agentId echo (enumeration oracle) + NO granted cap leaked.
    expect(body).not.toContain("gen-A");
    expect(body).not.toContain("mock.doc.read");
  });

  it("A2: setup.sh is 404 for a CLAUDE-CODE agent (generic bootstrap never served to CC)", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connectTyped(app, key, "cc-A", "claude-code", ["mock.doc.read"]);
    const res = await req(app, "/integration/cc-A/setup.sh");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("cc-A");
  });

  it("A2: install.sh still serves a claude-code agent; setup.sh still serves a generic agent", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connectTyped(app, key, "cc-A", "claude-code", ["mock.doc.read"]);
    await connectTyped(app, key, "gen-A", "generic", ["mock.doc.read"]);
    expect((await req(app, "/integration/cc-A/install.sh")).status).toBe(200);
    expect((await req(app, "/integration/gen-A/setup.sh")).status).toBe(200);
  });

  it("C7: an unknown agent's install.sh/setup.sh 404 is the SAME uniform text as a wrong-type 404", async () => {
    const { app, state } = freshApp();
    const key = state.connectionKey.current();
    await connectTyped(app, key, "gen-A", "generic", ["mock.doc.read"]);
    const unknownInstall = await (await req(app, "/integration/ghost/install.sh")).text();
    const wrongTypeInstall = await (await req(app, "/integration/gen-A/install.sh")).text();
    expect(unknownInstall).toBe(wrongTypeInstall); // indistinguishable — no enumeration oracle
  });
});
