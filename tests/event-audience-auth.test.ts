import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEntry, GrantPendingResponse, SourceRegistry } from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { GrantService } from "@plexus/runtime/core/grant-service.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";

const dirs: string[] = [];
const entries: CapabilityEntry[] = ["own", "foreign"].map((source) => ({
  id: `${source}.write`, source, kind: "capability", label: source,
  describe: "Fixture write", grants: ["write"], transport: "local-rest",
}));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-event-auth-"));
  dirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const config = loadConfig();
  const sources: SourceRegistry = {
    all: () => [], get: () => undefined,
    getTransport: (kind) => ({ kind, dispatch: async () => { throw new Error("fixture must not dispatch"); } }),
  };
  const capabilities = createCapabilityRegistry(sources);
  for (const entry of entries) {
    (capabilities as unknown as { entries: Map<string, CapabilityEntry> }).entries.set(entry.id, entry);
  }
  const authorizer = defaultAuthorizer({ managedSources: () => new Set(["own", "foreign"]) });
  const { app, state } = createAppWithState(config, { sources, capabilities, authorizer });
  const grants = new GrantService(state, authorizer);
  const request = (path: string, sessionId?: string) => app.request(`http://${expectedHost(config)}${path}`, {
    headers: { host: expectedHost(config), ...(sessionId ? { "X-Plexus-Session": sessionId } : {}) },
  });
  const agent = (id: string, capabilityId = "own.write") => {
    const redeemed = state.agentEnrollment.redeemEnrollmentCode(state.agentEnrollment.mintEnrollmentCode(id).code);
    if (!redeemed.ok) throw new Error("fixture enrollment failed");
    state.agentSubsets.set(id, [capabilityId]);
    return state.sessions.open(redeemed.pat, undefined, id);
  };
  return { request, state, grants, agent };
}

async function open(f: ReturnType<typeof fixture>, sessionId: string) {
  const response = await f.request("/events", sessionId);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await reader.read();
  return reader;
}

async function throughMarker(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  while (!text.includes('"revision":987654')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("stream closed before marker");
    text += new TextDecoder().decode(chunk.value);
  }
  return text;
}

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe("agent event audience and context authority", () => {
  it("requires a live enrolled session, never an anonymous or unknown identity", async () => {
    const f = fixture();
    for (const sessionId of [undefined, "unknown", f.state.sessions.open(f.state.connectionKey.current()).id,
      f.state.sessions.open(f.state.connectionKey.current(), undefined, "not-enrolled").id]) {
      const response = await f.request("/events", sessionId);
      await response.body?.cancel();
      expect(response.status).toBe(401);
    }
    const session = f.agent("a");
    const reader = await open(f, session.id);
    await reader.cancel();
  });

  it("filters event details against current visibility and proven token ownership", async () => {
    const f = fixture();
    const session = f.agent("a");
    session.issuedJtis.add("own-jti");
    const reader = await open(f, session.id);
    f.state.events.publish({ type: "source_status", source: "foreign", available: false, reason: "foreign-secret" });
    f.state.events.publish({ type: "source_status", source: "own", available: false, reason: "raw-secret" });
    f.state.events.publish({ type: "token_revoked", jti: "foreign-jti", reason: "foreign-secret" });
    f.state.events.publish({ type: "token_revoked", jti: "own-jti", reason: "raw-secret" });
    f.state.events.publish({ type: "manifest_changed", revision: 1, changed: { added: ["own.write", "foreign.write"] } });
    f.state.agentSubsets.set("a", []);
    f.state.events.publish({ type: "source_status", source: "own", available: true });
    f.state.events.publish({ type: "manifest_changed", revision: 987654 });
    const text = await throughMarker(reader);
    expect(text).toContain('"source":"own","available":false');
    expect(text).toContain("own-jti");
    expect(text).toContain("own.write");
    expect(text).not.toContain("foreign");
    expect(text).not.toContain("raw-secret");
    expect(text).not.toContain('"available":true');
    await reader.cancel();
  });

  it("grant token events/status are readable only by the live original session and agent", async () => {
    const f = fixture();
    const owner = f.agent("a");
    const foreign = f.agent("b");
    const renewed = f.state.sessions.open(owner.bootstrapKey, undefined, "a");
    const readers = await Promise.all([owner, foreign, renewed].map((s) => open(f, s.id)));
    const pending = await f.grants.grant({ sessionId: owner.id, grants: { "own.write": { decision: "allow", verbs: ["write"] } } }, owner) as GrantPendingResponse;
    expect(pending.pendingId).toBeDefined();
    await f.grants.approve(pending.pendingId);
    f.state.events.publish({ type: "manifest_changed", revision: 987654 });
    const texts = await Promise.all(readers.map(throughMarker));
    expect(texts[0]).toContain('"type":"grant_resolved"');
    expect(texts[0]).toContain('"token":');
    for (const text of texts.slice(1)) expect(text).not.toContain(pending.pendingId);
    for (const reader of readers) await reader.cancel();
    expect((await f.request(`/grants/status?pendingId=${pending.pendingId}`, owner.id)).status).toBe(200);
    owner.invalidated = true;
    expect((await f.request(`/grants/status?pendingId=${pending.pendingId}`, owner.id)).status).toBe(403);
  });

  it("invoke events require the run owner and a currently visible capability", async () => {
    const f = fixture();
    const session = f.agent("a");
    const reader = await open(f, session.id);
    const own = f.state.invokeRuns.open({ capabilityId: "own.write", agentId: "a", sessionId: session.id, jti: "own" })!;
    const foreign = f.state.invokeRuns.open({ capabilityId: "own.write", agentId: "b", sessionId: "other", jti: "foreign" })!;
    for (const run of [foreign, own]) f.state.events.publish({ type: "invoke_resolved", runId: run.runId, id: run.capabilityId, status: "succeeded" });
    f.state.agentSubsets.set("a", []);
    f.state.events.publish({ type: "invoke_resolved", runId: own.runId, id: own.capabilityId, status: "failed" });
    f.state.events.publish({ type: "manifest_changed", revision: 987654 });
    const text = await throughMarker(reader);
    expect(text).toContain(own.runId);
    expect(text).not.toContain(foreign.runId);
    expect(text).not.toContain('"status":"failed"');
    await reader.cancel();
  });

  for (const cause of ["expiry", "session-revoke", "enrollment-revoke", "pat-reissue"] as const) {
    it(`closes on ${cause} at emission and at idle keepalive`, async () => {
      for (const idle of [false, true]) {
        const f = fixture();
        const session = f.agent("a");
        const timer = spyOn(globalThis, "setInterval");
        const reader = await open(f, session.id);
        const tick = timer.mock.calls.at(-1)?.[0];
        timer.mockRestore();
        if (cause === "expiry") session.expiresAt = new Date(0).toISOString();
        else if (cause === "session-revoke") session.invalidated = true;
        else if (cause === "enrollment-revoke") f.state.agentEnrollment.revoke("a");
        else f.agent("a");
        if (idle) {
          if (typeof tick !== "function") { await reader.cancel(); throw new Error("missing authorization keepalive"); }
          tick();
        } else f.state.events.publish({ type: "manifest_changed", revision: 987654 });
        const closed = await reader.read();
        await reader.cancel();
        expect(closed.done).toBe(true);
      }
    });
  }

  it("bundle context is private to its live owning agent, including renewed sessions", async () => {
    const f = fixture();
    const owner = f.agent("a");
    const foreign = f.agent("b");
    const renewed = f.state.sessions.open(owner.bootstrapKey, undefined, "a");
    const result = await f.grants.createBundle({ name: "Private task", agentId: "a", grants: [{ id: "own.write" }],
      context: [{ kind: "inline", label: "private", markdown: "private-task-body" }] });
    if (!result.ok) throw new Error(result.reason);
    const path = `/grants/context?bundle=${result.bundle.bundleId}`;
    for (const session of [owner, renewed]) {
      const response = await f.request(path, session.id);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("private-task-body");
    }
    for (const id of [foreign.id, f.state.sessions.open(f.state.connectionKey.current()).id]) {
      const response = await f.request(path, id);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("private-task-body");
    }
    f.state.agentEnrollment.revoke("a");
    const response = await f.request(path, owner.id);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("private-task-body");
  });
});
