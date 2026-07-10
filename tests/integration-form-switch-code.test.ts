import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityEntry, SourceRegistry, SourceModule, Transport, TransportKind, CapabilityBridge, BridgeDeps } from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";

const READ: CapabilityEntry = { id: "mock.doc.read", source: "mock", kind: "capability", label: "Read", describe: "r", grants: ["read"], transport: "local-rest" };
const MOCK = [READ];
class B implements CapabilityBridge { readonly source = "mock"; constructor(private d: BridgeDeps, private s: string) {} getCapabilities() { return MOCK; } route(id: string) { return MOCK.some(e => e.id === id) ? "handled" as const : "passthrough" as const; } async invoke(): Promise<any> { return { ok: true }; } async disconnect() {} }
function reg(): SourceRegistry { const m: SourceModule = { id: "mock", label: "M", transport: "local-rest", createSource: () => { throw new Error("x"); }, createBridge: (d, s) => new B(d, s) }; return { all: () => [m], get: (id) => id === "mock" ? m : undefined, getTransport: (k: TransportKind) => ({ kind: k, dispatch: async () => ({ ok: true }) }) as Transport }; }

const config = loadConfig();
const HOST = expectedHost(config);
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "repro-")); process.env.PLEXUS_HOME = home; });
afterEach(() => { delete process.env.PLEXUS_HOME; rmSync(home, { recursive: true, force: true }); });
function fresh() { _resetSecretCacheForTests(); const sources = reg(); const capabilities = createCapabilityRegistry(sources); for (const e of MOCK) (capabilities as any).entries.set(e.id, e); return createAppWithState(config, { sources, capabilities }); }
function rq(app: any, path: string, init?: RequestInit) { return app.request("http://" + HOST + path, { ...init, headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) } }); }
async function connect(app: any, key: string, id: string, type = "claude-code") { const r = await rq(app, "/admin/api/agents/connect", { method: "POST", headers: { "x-plexus-connection-key": key }, body: JSON.stringify({ agentId: id, agentType: type, capabilities: ["mock.doc.read"] }) }); return (await r.json()) as any; }
async function integ(app: any, key: string, id: string, as?: string) { const r = await rq(app, `/integration/${id}${as ? `?as=${as}` : ""}`, { headers: { "x-plexus-connection-key": key } }); return { status: r.status, body: (await r.json()) as any }; }
async function enroll(app: any, code: string) { const r = await rq(app, "/agents/enroll", { method: "POST", body: JSON.stringify({ code }) }); return (await r.json()) as any; }

// Switching a freshly-connected (PENDING) agent's delivery form is a `?as=` PROJECTION. It used
// to never mint on a projection, so the projected command came out CODE-FREE ("you already hold a
// credential" — wrong: the agent is pending) and Generic CLI showed no enroll code. A pending agent
// has no PAT to protect, so it now mints even on a projection; an ACTIVE agent's PAT stays protected.
describe("integration form-switch — a pending agent keeps a working one-time code across a ?as= switch", () => {
  it("connect (cc) then ?as=generic → the projected form carries enrollCode + enrollCommand", async () => {
    const { app, state } = fresh();
    const key = state.connectionKey.current();
    await connect(app, key, "raven", "claude-code");
    const g = await integ(app, key, "raven", "generic");
    expect(g.status).toBe(200);
    expect(g.body.alreadyEnrolled).toBe(false);
    expect(g.body.enrollCode).toMatch(/^plx_enroll_/);
    expect(g.body.enrollCommand).toContain("plexus enroll plx_enroll_");
  });

  it("connect (cc) then ?as=in-context → the projected form carries the enrollCode", async () => {
    const { app, state } = fresh();
    const key = state.connectionKey.current();
    await connect(app, key, "raven2", "claude-code");
    const ic = await integ(app, key, "raven2", "in-context");
    expect(ic.body.alreadyEnrolled).toBe(false);
    expect(ic.body.enrollCode).toMatch(/^plx_enroll_/);
  });

  it("an ACTIVE agent projected to generic still does NOT mint (live PAT protected)", async () => {
    const { app, state } = fresh();
    const key = state.connectionKey.current();
    const c = await connect(app, key, "active-one", "claude-code");
    await enroll(app, c.code); // redeem → active
    expect(state.agentEnrollment.isActive("active-one")).toBe(true);
    const g = await integ(app, key, "active-one", "generic");
    expect(g.body.alreadyEnrolled).toBe(true);
    expect(g.body.enrollCode).toBeUndefined(); // no mint → live PAT untouched
    expect(state.agentEnrollment.isActive("active-one")).toBe(true); // still active
  });
});
