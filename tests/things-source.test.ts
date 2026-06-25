/**
 * Things 3 FIRST-PARTY source — provider seam (fake), entries (read + write caps),
 * registry routability, the add→list round-trip, and health-from-available().
 *
 * Things demonstrates a DIFFERENT surface class:
 *   - READ via the AppleScript dictionary (`things.todos.list`, `things.projects.list`).
 *   - WRITE via the Things URL-scheme (`things.todos.add`).
 *
 * Proves (with the HERMETIC fake provider — NO real Things access):
 *  - the module registers as FIRST-PARTY (reserved source id ⇒ provenance "first-party");
 *  - scan() yields the two READ caps + the WRITE cap (+ the how-to skill), well-formed;
 *  - the WRITE cap is `grants:["write"]`; the READ caps are `grants:["read"]`;
 *  - `things.todos.list` returns the fake's sample to-dos;
 *  - `things.todos.add` MUTATES the fake store, and a follow-up list SHOWS it (round-trip);
 *  - health() reflects provider.available() (ok for fake; unavailable for a not-installed
 *    real provider, with the install/automation reason).
 */

import { describe, it, expect } from "bun:test";

import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { provenanceFor } from "@plexus/runtime/core/capability-registry.ts";
import {
  thingsSourceModule,
  ThingsSource,
  ThingsBridge,
  thingsEntries,
  FakeThingsProvider,
  RealThingsProvider,
  THINGS_SOURCE_ID,
  TODOS_LIST_ID,
  PROJECTS_LIST_ID,
  TODOS_ADD_ID,
  HOW_TO_USE_ID,
} from "@plexus/runtime/sources/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityId,
  EntryKind,
  GrantVerb,
  InvokeContext,
  PlatformServices,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";

function platformStub(): PlatformServices {
  return {
    platform: "darwin",
    async resolveBinary() {
      return undefined;
    },
    async getEnrichedPath() {
      return "/usr/bin";
    },
    async locateLocalService() {
      return undefined;
    },
    spawnProcess() {
      throw new Error("not used");
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function testRegistry(modules: SourceModule[]): SourceRegistry {
  const transports = buildTransports(platformStub());
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport => transports[kind],
  };
}

/** A bridge deps stub that records audit events + serves entries from a snapshot. */
function bridgeDeps(entries = thingsEntries()): { deps: BridgeDeps; events: AuditEventInput[] } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const events: AuditEventInput[] = [];
  const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
    events.push(e);
    return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
  };
  const transports = buildTransports(platformStub());
  const deps: BridgeDeps = {
    audit,
    getTransport: (k: TransportKind): Transport => transports[k],
    getEntry: (id) => byId.get(id),
    invokeById: async (req) => ({ id: req.id, ok: true, output: {}, auditId: "x" }),
  };
  return { deps, events };
}

const CTX: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

describe("things source: provenance + scan() entries", () => {
  it("is FIRST-PARTY (reserved source id derived from MODULES)", () => {
    // The module is registered in MODULES ⇒ RESERVED_SOURCE_IDS ⇒ first-party provenance.
    expect(provenanceFor(THINGS_SOURCE_ID)).toBe("first-party");
  });

  it("scan() yields the two READ caps + the WRITE cap + the how-to skill", async () => {
    const source = new ThingsSource(platformStub(), new FakeThingsProvider());
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    expect(byId.has(TODOS_LIST_ID)).toBe(true);
    expect(byId.has(PROJECTS_LIST_ID)).toBe(true);
    expect(byId.has(TODOS_ADD_ID)).toBe(true);
    expect(byId.has(HOW_TO_USE_ID)).toBe(true);

    // READ caps are grants:["read"]; the WRITE cap is grants:["write"].
    expect(byId.get(TODOS_LIST_ID)!.grants).toEqual(["read"]);
    expect(byId.get(PROJECTS_LIST_ID)!.grants).toEqual(["read"]);
    expect(byId.get(TODOS_ADD_ID)!.grants).toEqual(["write"]);

    // The skill is read-as-context (transport "skill", no grants, has a body).
    const skill = byId.get(HOW_TO_USE_ID)!;
    expect(skill.kind).toBe("skill");
    expect(skill.transport).toBe("skill");
    expect(skill.grants).toEqual([]);
    expect(skill.body?.format).toBe("markdown");
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const entries = thingsEntries();
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];

    for (const e of entries) {
      expect(e.id.startsWith("things.")).toBe(true);
      expect(e.source).toBe("things");
      expect(validKinds).toContain(e.kind);
      expect(e.describe.length).toBeGreaterThan(20);
      for (const v of e.grants) expect(validVerbs).toContain(v);
      if (e.kind === "skill") {
        expect(e.transport).toBe("skill");
        expect(e.body).toBeDefined();
      }
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // ids unique
  });
});

describe("things source: registry routability", () => {
  it("the three capabilities appear in the registry after registering the module", async () => {
    const reg = createCapabilityRegistry(testRegistry([thingsSourceModule]));
    await reg.refresh();

    const ids = reg.all().map((e) => e.id);
    expect(ids).toContain(TODOS_LIST_ID);
    expect(ids).toContain(PROJECTS_LIST_ID);
    expect(ids).toContain(TODOS_ADD_ID);

    // The write cap surfaces in the .well-known summary projection with its grant cost.
    const add = reg.summaries().find((s) => s.id === TODOS_ADD_ID)!;
    expect(add.grants).toEqual(["write"]);
    const list = reg.summaries().find((s) => s.id === TODOS_LIST_ID)!;
    expect(list.grants).toEqual(["read"]);
  });
});

describe("things bridge: read + write through the injected fake provider", () => {
  it("things.todos.list returns the fake's sample to-dos", async () => {
    const { deps } = bridgeDeps();
    const fake = new FakeThingsProvider();
    const bridge = new ThingsBridge(deps, "s1", thingsEntries(), fake);

    expect(bridge.route(TODOS_LIST_ID)).toBe("handled");
    const res = await bridge.invoke({ id: TODOS_LIST_ID, input: {} }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { todos: Array<{ title: string }>; count: number };
    expect(out.count).toBe(2);
    expect(out.todos.map((t) => t.title)).toContain("Buy oat milk");
  });

  it("things.projects.list returns the fake's sample projects", async () => {
    const { deps } = bridgeDeps();
    const bridge = new ThingsBridge(deps, "s1", thingsEntries(), new FakeThingsProvider());
    const res = await bridge.invoke({ id: PROJECTS_LIST_ID, input: {} }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { projects: Array<{ title: string }> };
    expect(out.projects.map((p) => p.title)).toContain("Ship Plexus");
  });

  it("things.todos.add MUTATES the fake store, and a follow-up list SHOWS it (round-trip)", async () => {
    const { deps, events } = bridgeDeps();
    const fake = new FakeThingsProvider();
    const bridge = new ThingsBridge(deps, "s1", thingsEntries(), fake);

    const before = fake.count();
    const add = await bridge.invoke(
      { id: TODOS_ADD_ID, input: { title: "Water the plants", when: "today", list: "Home" } },
      CTX,
    );
    expect(add.ok).toBe(true);
    const addOut = add.output as { ok: boolean; url: string; id?: string };
    expect(addOut.ok).toBe(true);
    // The URL-scheme add really built a things:///add?... URL.
    expect(addOut.url).toContain("things:///add?");
    expect(addOut.url).toContain("title=Water+the+plants");

    // The fake store grew by one.
    expect(fake.count()).toBe(before + 1);

    // The add was audited with the WRITE verb.
    const addAudit = events.find((e) => e.capabilityId === TODOS_ADD_ID);
    expect(addAudit?.verbs).toEqual(["write"]);

    // Round-trip: a follow-up list now shows the new to-do.
    const list = await bridge.invoke({ id: TODOS_LIST_ID, input: {} }, CTX);
    const out = list.output as { todos: Array<{ title: string }> };
    expect(out.todos.map((t) => t.title)).toContain("Water the plants");
  });

  it("things.todos.add rejects a missing title with schema_validation_failed", async () => {
    const { deps } = bridgeDeps();
    const bridge = new ThingsBridge(deps, "s1", thingsEntries(), new FakeThingsProvider());
    const res = await bridge.invoke({ id: TODOS_ADD_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });
});

describe("things source: health reflects provider.available()", () => {
  it("fake provider ⇒ ok", async () => {
    const source = new ThingsSource(platformStub(), new FakeThingsProvider());
    expect((await source.health()).status).toBe("ok");
    expect((await source.checkRequirements()).ok).toBe(true);
  });

  it("a not-installed real provider ⇒ unavailable with the install/automation reason", async () => {
    // Real provider whose injected capture always fails (Things3 not scriptable) — NO
    // real osascript runs; the capture is a stub returning a non-zero exit.
    const real = new RealThingsProvider({
      capture: async () => ({ stdout: "", stderr: "Application isn't running", exitCode: 1 }),
    });
    const source = new ThingsSource(platformStub(), real);
    const h = await source.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("Things 3 not found");
  });

  it("a real provider whose osascript probe SUCCEEDS ⇒ ok", async () => {
    const real = new RealThingsProvider({
      capture: async () => ({ stdout: "3.20.6\n", stderr: "", exitCode: 0 }),
    });
    const source = new ThingsSource(platformStub(), real);
    expect((await source.health()).status).toBe("ok");
  });
});

describe("things real provider: AppleScript parsing + URL-scheme write (capture stubbed)", () => {
  it("listTodos parses the delimited osascript rows into to-dos", async () => {
    // The real provider's AppleScript emits FIELD/ROW-delimited rows; verify parsing
    // WITHOUT touching the OS by stubbing the capture with a canned delimited payload.
    const US = "\x1f";
    const RS = "\x1e";
    const row = (id: string, title: string, notes: string, status: string, list: string) =>
      [id, title, notes, status, list].join(US) + RS;
    const payload = row("t1", "Alpha", "n1", "open", "Inbox") + row("t2", "Beta", "", "completed", "Work");
    const real = new RealThingsProvider({
      capture: async () => ({ stdout: payload, stderr: "", exitCode: 0 }),
    });
    const todos = await real.listTodos();
    expect(todos.length).toBe(2);
    expect(todos[0]).toMatchObject({ id: "t1", title: "Alpha", status: "open", list: "Inbox" });
    expect(todos[1]).toMatchObject({ id: "t2", title: "Beta", status: "completed" });
  });

  it("addTodo opens a things:///add URL and reports ok by exit code", async () => {
    const opened: string[][] = [];
    const real = new RealThingsProvider({
      capture: async (spec) => {
        opened.push([spec.command, ...spec.args]);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const res = await real.addTodo({ title: "Hi there", notes: "body", when: "today" });
    expect(res.ok).toBe(true);
    // The captured argv opened the URL-scheme add URL.
    const argv = opened[0]!;
    expect(argv[0]).toBe("open");
    expect(argv[1]).toContain("things:///add?");
    expect(argv[1]).toContain("title=Hi+there");
    expect(argv[1]).toContain("when=today");
  });
});
