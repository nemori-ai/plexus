/**
 * Apple Calendar FIRST-PARTY source — scan/health unit + END-TO-END through the gateway.
 *
 * The source is registered in `MODULES` + reserved in `RESERVED_SOURCE_IDS`, so it boots
 * as a first-party source with NO `registerExtension` call. Under `PLEXUS_FAKE_APPLE=1`
 * the OS-access seam selects the FAKE provider, so the whole flow is hermetic (no macOS,
 * no TCC). Asserts:
 *   - the source registers as FIRST-PARTY; `scan()` yields the two read capabilities + skill;
 *   - both capabilities are read-only (grants ["read"], no write/execute), skill attached;
 *   - health() reflects provider.available() (ok under fake; unavailable+reason when denied);
 *   - through the real pipeline (handshake → grant read → invoke): calendars.list returns
 *     the fake calendars; events.list returns fake events for a valid window; a >60-day or
 *     reversed window is rejected (invalid_input) BEFORE the provider; a TCC denial surfaces
 *     as a graceful not-authorized transport_error.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  HandshakeResponse,
  InvokeContext,
  InvokeResponse,
  ScopedToken,
} from "@plexus/protocol";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { _resetSecretCacheForTests } from "@plexus/runtime/auth/index.ts";
import { provenanceFor } from "@plexus/runtime/core/capability-registry.ts";
import {
  AppleCalendarSource,
  APPLE_CALENDAR_SOURCE_ID,
  CALENDARS_LIST_ID,
  EVENTS_LIST_ID,
  CALENDAR_SKILL_ID,
  appleCalendarEntries,
} from "@plexus/runtime/sources/index.ts";
import { AppleCalendarBridge } from "@plexus/runtime/sources/apple-calendar/bridge.ts";
import { FakeCalendarProvider } from "@plexus/runtime/sources/apple-calendar/provider-fake.ts";

/** A minimal BridgeDeps stub (the bridge serves the read ops in-process; no transports needed). */
function stubDeps(): { deps: BridgeDeps; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  const byId = new Map(appleCalendarEntries().map((e) => [e.id, e]));
  const deps: BridgeDeps = {
    audit: async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
    },
    getTransport: () => {
      throw new Error("not used by the in-process read handlers");
    },
    getEntry: (id) => byId.get(id),
    invokeById: async (req) => ({ id: req.id, ok: true, output: {}, auditId: "x" }),
  };
  return { deps, events };
}

const config = loadConfig();
const HOST = expectedHost(config);
const tmpDirs: string[] = [];

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "plexus-applecal-"));
  tmpDirs.push(dir);
  process.env.PLEXUS_HOME = dir;
  _resetSecretCacheForTests();
  const { app, state } = createAppWithState(config);
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
  // AUTHORIZED SUBSET (ADR-023, fail-closed): an agent-bound session sees/grants only
  // what the owner authorized. Declare agent-1's subset = this source's capabilities so
  // these tests keep exercising the SOURCE e2e semantics, not the subset gate.
  state.agentSubsets.set("agent-1", [CALENDARS_LIST_ID, EVENTS_LIST_ID]);
  const key = state.connectionKey.current();
  const res = await req(app, "/link/handshake", {
    method: "POST",
    body: JSON.stringify({ connectionKey: key, client: { name: "test", agentId: "agent-1" } }),
  });
  return (await res.json()) as HandshakeResponse;
}

async function grant(app: ReturnType<typeof freshApp>["app"], sessionId: string, id: string): Promise<ScopedToken> {
  const res = await req(app, "/grants", {
    method: "PUT",
    body: JSON.stringify({ sessionId, grants: { [id]: "allow" } }),
  });
  return (await res.json()) as ScopedToken;
}

async function invoke(
  app: ReturnType<typeof freshApp>["app"],
  token: string,
  id: string,
  input: Record<string, unknown>,
): Promise<InvokeResponse> {
  const res = await req(app, "/invoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ id, input }),
  });
  return (await res.json()) as InvokeResponse;
}

beforeEach(() => {
  _resetSecretCacheForTests();
  process.env.PLEXUS_FAKE_APPLE = "1";
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
  delete process.env.PLEXUS_FAKE_APPLE;
});

// ── First-party provenance + scan/health (unit) ───────────────────────────────
describe("apple-calendar: first-party provenance + scan/health", () => {
  it("is reserved as a FIRST-PARTY source id", () => {
    expect(provenanceFor(APPLE_CALENDAR_SOURCE_ID)).toBe("first-party");
  });

  it("scan() yields the two read capabilities + the how-to-use skill, read-only", async () => {
    const source = new AppleCalendarSource({ provider: new FakeCalendarProvider() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    const cals = byId.get(CALENDARS_LIST_ID)!;
    const events = byId.get(EVENTS_LIST_ID)!;
    const skill = byId.get(CALENDAR_SKILL_ID)!;

    expect(cals.kind).toBe("capability");
    expect(cals.grants).toEqual(["read"]);
    expect(events.grants).toEqual(["read"]);
    expect(skill.kind).toBe("skill");
    expect(skill.body?.markdown).toContain("read-only");

    // The skill is attached to BOTH capabilities.
    expect(cals.skills?.some((s) => s.id === CALENDAR_SKILL_ID)).toBe(true);
    expect(events.skills?.some((s) => s.id === CALENDAR_SKILL_ID)).toBe(true);

    // READ-ONLY: no entry requires write/execute.
    for (const e of entries) {
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
    }
    expect(entries.filter((e) => e.kind === "capability").length).toBe(2);
  });

  it("health() reflects provider.available(): ok under fake, unavailable+reason when denied", async () => {
    const okSource = new AppleCalendarSource({ provider: new FakeCalendarProvider() });
    expect(await okSource.health()).toEqual({ status: "ok" });

    const deniedSource = new AppleCalendarSource({ provider: new FakeCalendarProvider({ notAuthorized: true }) });
    const h = await deniedSource.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("Calendar access not granted");
  });
});

// ── End-to-end through the gateway pipeline (fake provider via env) ────────────
describe("apple-calendar: end-to-end through the gateway (PLEXUS_FAKE_APPLE=1)", () => {
  it("boots as first-party, appears in the handshake manifest read-only, with health", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();

    const hs = await handshake(app, state);
    const cals = hs.manifest.entries.find((e) => e.id === CALENDARS_LIST_ID);
    const events = hs.manifest.entries.find((e) => e.id === EVENTS_LIST_ID);
    const skill = hs.manifest.entries.find((e) => e.id === CALENDAR_SKILL_ID);

    expect(cals?.provenance).toBe("first-party");
    expect(cals?.grants).toEqual(["read"]);
    expect(events?.grants).toEqual(["read"]);
    expect(skill?.kind).toBe("skill");
    expect(cals?.skills?.some((s) => s.id === CALENDAR_SKILL_ID)).toBe(true);

    // READ-ONLY: no apple-calendar entry requires write/execute.
    const appleEntries = hs.manifest.entries.filter((e) => e.source === APPLE_CALENDAR_SOURCE_ID);
    for (const e of appleEntries) {
      expect(e.grants).not.toContain("write");
      expect(e.grants).not.toContain("execute");
    }
    expect(appleEntries.filter((e) => e.kind === "capability").length).toBe(2);
  });

  it("calendars.list returns the fake calendar names", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, CALENDARS_LIST_ID);

    const out = await invoke(app, token.token, CALENDARS_LIST_ID, {});
    expect(out.ok).toBe(true);
    expect((out.output as { calendars: string[] }).calendars).toEqual(["Home", "Work", "Birthdays"]);
  });

  it("events.list returns fake events for a valid window", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, EVENTS_LIST_ID);

    const out = await invoke(app, token.token, EVENTS_LIST_ID, {
      start: "2026-06-24T00:00:00Z",
      end: "2026-06-25T00:00:00Z",
    });
    expect(out.ok).toBe(true);
    const events = (out.output as { events: { title: string }[] }).events;
    expect(events.map((e) => e.title)).toEqual(["Team sync"]);
  });

  it("events.list REJECTS a >60-day window (invalid_input)", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, EVENTS_LIST_ID);

    const out = await invoke(app, token.token, EVENTS_LIST_ID, {
      start: "2026-01-01T00:00:00Z",
      end: "2026-06-01T00:00:00Z", // ~151 days
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("transport_error");
    expect(out.error?.message).toMatch(/invalid input|window too large/i);
    expect((out.error?.detail as { reason?: string })?.reason).toBe("invalid_input");
  });

  it("events.list REJECTS a reversed window (end before start)", async () => {
    const { app, state } = freshApp();
    await state.capabilities.start();
    const hs = await handshake(app, state);
    const token = await grant(app, hs.sessionId, EVENTS_LIST_ID);

    const out = await invoke(app, token.token, EVENTS_LIST_ID, {
      start: "2026-06-30T00:00:00Z",
      end: "2026-06-23T00:00:00Z",
    });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toMatch(/after `start`/);
  });

  it("a TCC not-authorized error surfaces GRACEFULLY through the bridge (clear onboarding message, not a crash)", async () => {
    // Drive the bridge directly with a not-authorized provider — the real denial path.
    const { deps } = stubDeps();
    const bridge = new AppleCalendarBridge(
      deps,
      "s1",
      appleCalendarEntries(),
      new FakeCalendarProvider({ notAuthorized: true }),
    );
    const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

    const out = await bridge.invoke({ id: CALENDARS_LIST_ID, input: {} }, ctx);
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("transport_error");
    expect(out.error?.message).toContain("Calendar access not granted");
    expect((out.error?.detail as { reason?: string })?.reason).toBe("not_authorized");
  });

  it("the bridge returns fake events for a valid window and rejects an oversized one BEFORE the provider", async () => {
    let providerCalled = false;
    const provider = new FakeCalendarProvider();
    const tracking = new Proxy(provider, {
      get(target, prop, recv) {
        if (prop === "listEvents") {
          return (...args: Parameters<typeof target.listEvents>) => {
            providerCalled = true;
            return target.listEvents(...args);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const { deps } = stubDeps();
    const bridge = new AppleCalendarBridge(deps, "s1", appleCalendarEntries(), tracking);
    const ctx: InvokeContext = { jti: "jti-2", sessionId: "s1", agentId: "agentX", scopes: [] };

    // Oversized window → rejected before the provider is touched.
    const big = await bridge.invoke(
      { id: EVENTS_LIST_ID, input: { start: "2026-01-01T00:00:00Z", end: "2026-06-01T00:00:00Z" } },
      ctx,
    );
    expect(big.ok).toBe(false);
    expect((big.error?.detail as { reason?: string })?.reason).toBe("invalid_input");
    expect(providerCalled).toBe(false);

    // Valid window → fake events flow through.
    const ok = await bridge.invoke(
      { id: EVENTS_LIST_ID, input: { start: "2026-06-24T00:00:00Z", end: "2026-06-25T00:00:00Z" } },
      ctx,
    );
    expect(ok.ok).toBe(true);
    expect((ok.output as { events: { title: string }[] }).events.map((e) => e.title)).toEqual(["Team sync"]);
    expect(providerCalled).toBe(true);
  });
});
