/**
 * Apple Reminders FIRST-PARTY source (read + write) — hermetic, fake-provider-driven.
 *
 * Proves (all with the in-memory `FakeRemindersProvider`, NO macOS TCC):
 *  - the source registers as FIRST-PARTY (reserved source id / provenance).
 *  - scan() yields the read + write capabilities (+ a how-to-use skill), well-formed
 *    against the frozen CapabilityEntry contract, with the write capabilities
 *    declaring `grants:["write"]`.
 *  - the registry routes the entries; `.well-known`-style summaries carry the grant cost.
 *  - the read capabilities return the fixture lists/reminders.
 *  - the WRITE `reminders.create` MUTATES the fake store and a subsequent
 *    `reminders.list` shows the new reminder (the create→list round-trip).
 *  - `reminders.complete` flips completion (a second write).
 *  - health() reflects the provider's available(): ok for the fake; unavailable with a
 *    precise TCC reason when the provider reports access denied.
 */

import { describe, it, expect } from "bun:test";

import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import {
  RESERVED_SOURCE_IDS,
  provenanceFor,
} from "@plexus/runtime/core/capability-registry.ts";
import {
  appleRemindersSourceModule,
  appleRemindersEntries,
  AppleRemindersSource,
  APPLE_REMINDERS_SOURCE_ID,
  REMINDERS_LIST_ID,
  REMINDERS_CREATE_ID,
} from "@plexus/runtime/sources/index.ts";
import {
  LISTS_LIST_ID,
  REMINDERS_COMPLETE_ID,
} from "@plexus/runtime/sources/apple-reminders/entries.ts";
import { AppleRemindersBridge } from "@plexus/runtime/sources/apple-reminders/bridge.ts";
import {
  FakeRemindersProvider,
  type RemindersProvider,
} from "@plexus/runtime/sources/apple-reminders/provider.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  EntryKind,
  GrantVerb,
  InvokeContext,
  InvokeRequest,
  InvokeResponse,
  PlatformServices,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";

// ── stubs ─────────────────────────────────────────────────────────────────────

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

/** A minimal BridgeDeps: audit collects; the in-process handlers need nothing else. */
function stubDeps(entries: { id: string }[]): { deps: BridgeDeps; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const deps: BridgeDeps = {
    audit: async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a-${events.length}`, at: new Date().toISOString() } as unknown as AuditEvent;
    },
    getTransport: () => {
      throw new Error("apple-reminders capabilities are served by in-process handlers");
    },
    getEntry: (id) => byId.get(id) as never,
    invokeById: async () => {
      throw new Error("apple-reminders does not re-enter the pipeline");
    },
  };
  return { deps, events };
}

const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

/** Build a bridge over a FRESH fake provider (so mutation tests are isolated). */
function bridgeWithFake(provider?: RemindersProvider): AppleRemindersBridge {
  const entries = appleRemindersEntries();
  const { deps } = stubDeps(entries);
  return new AppleRemindersBridge(deps, "s1", entries, provider ?? new FakeRemindersProvider());
}

async function invoke(
  bridge: AppleRemindersBridge,
  id: string,
  input: Record<string, unknown> = {},
): Promise<InvokeResponse> {
  return bridge.invoke({ id, input } as InvokeRequest, ctx);
}

// ── tests ───────────────────────────────────────────────────────────────────────

describe("apple-reminders: first-party provenance", () => {
  it("is a reserved first-party source id (provenance first-party)", () => {
    expect(RESERVED_SOURCE_IDS.has(APPLE_REMINDERS_SOURCE_ID)).toBe(true);
    expect(provenanceFor(APPLE_REMINDERS_SOURCE_ID)).toBe("first-party");
  });

  it("appears in the connector catalog as a first-party builtin (derived from MODULES)", async () => {
    // The module is in MODULES, so it is reserved/first-party above. That is the
    // provenance contract; the catalog derivation is exercised by connectors-catalog.test.ts.
    expect(appleRemindersSourceModule.id).toBe(APPLE_REMINDERS_SOURCE_ID);
    expect(appleRemindersSourceModule.transport).toBe("ipc");
  });
});

describe("apple-reminders source: scan() yields read + write capabilities, well-formed", () => {
  it("exposes two reads, the WRITE create, the write complete, and a skill", async () => {
    const source = new AppleRemindersSource(platformStub(), { provider: new FakeRemindersProvider() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    // Reads.
    expect(byId.get(LISTS_LIST_ID)!.grants).toEqual(["read"]);
    expect(byId.get(REMINDERS_LIST_ID)!.grants).toEqual(["read"]);
    // WRITE — the sensitive native write declares grants:["write"].
    expect(byId.get(REMINDERS_CREATE_ID)!.grants).toEqual(["write"]);
    expect(byId.get(REMINDERS_COMPLETE_ID)!.grants).toEqual(["write"]);
    // The create describe is honest about mutating the user's Reminders.
    expect(byId.get(REMINDERS_CREATE_ID)!.describe.toLowerCase()).toContain("mutate");

    // The how-to-use skill is read-as-context.
    const skills = entries.filter((e) => e.kind === "skill");
    expect(skills.length).toBe(1);
    expect(skills[0]!.transport).toBe("skill");
    expect(skills[0]!.grants).toEqual([]);
    expect(skills[0]!.body?.format).toBe("markdown");
    expect(skills[0]!.body?.markdown).toContain("WRITE grant");
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const entries = appleRemindersEntries();
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];

    for (const e of entries) {
      expect(typeof e.id).toBe("string");
      expect(e.id.startsWith("apple-reminders.")).toBe(true);
      expect(e.source).toBe(APPLE_REMINDERS_SOURCE_ID);
      expect(validKinds).toContain(e.kind);
      expect(e.describe.length).toBeGreaterThan(20);
      for (const v of e.grants) expect(validVerbs).toContain(v);
      if (e.kind === "skill") {
        expect(e.transport).toBe("skill");
        expect(e.body).toBeDefined();
      } else {
        expect(e.transport).toBe("ipc");
        expect(e.io).toBeDefined();
      }
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("apple-reminders: registry routability + write-grant cost", () => {
  it("entries appear in the registry; the create capability's grant cost is write", async () => {
    const reg = createCapabilityRegistry(testRegistry([appleRemindersSourceModule]));
    await reg.refresh();

    const ids = reg.all().map((e) => e.id);
    expect(ids).toContain(REMINDERS_LIST_ID);
    expect(ids).toContain(REMINDERS_CREATE_ID);

    const createSummary = reg.summaries().find((s) => s.id === REMINDERS_CREATE_ID)!;
    expect(createSummary.kind).toBe("capability");
    expect(createSummary.grants).toEqual(["write"]);

    const listSummary = reg.summaries().find((s) => s.id === REMINDERS_LIST_ID)!;
    expect(listSummary.grants).toEqual(["read"]);
  });
});

describe("apple-reminders: read capabilities return fixtures (fake provider)", () => {
  it("lists.list returns the fixture lists", async () => {
    const bridge = bridgeWithFake();
    const res = await invoke(bridge, LISTS_LIST_ID);
    expect(res.ok).toBe(true);
    const lists = (res.output as { lists: { name: string }[] }).lists;
    expect(lists.map((l) => l.name)).toEqual(["Reminders", "Groceries"]);
  });

  it("reminders.list returns sample reminders and honors the completed filter", async () => {
    const bridge = bridgeWithFake();
    const all = await invoke(bridge, REMINDERS_LIST_ID, {});
    const reminders = (all.output as { reminders: { title: string }[] }).reminders;
    expect(reminders.map((r) => r.title)).toContain("Ship Plexus v1");

    const open = await invoke(bridge, REMINDERS_LIST_ID, { completed: false });
    const openItems = (open.output as { reminders: { completed: boolean }[] }).reminders;
    expect(openItems.every((r) => r.completed === false)).toBe(true);

    const groceries = await invoke(bridge, REMINDERS_LIST_ID, { list: "Groceries" });
    const gItems = (groceries.output as { reminders: { list: string }[] }).reminders;
    expect(gItems.every((r) => r.list === "Groceries")).toBe(true);
  });
});

describe("apple-reminders: WRITE create→list round-trip (fake store mutates)", () => {
  it("create mutates the fake store; a subsequent list shows the new reminder", async () => {
    // ONE shared fake provider so the write persists across the two invokes.
    const provider = new FakeRemindersProvider();
    const bridge = bridgeWithFake(provider);

    // Before: the new title is not present.
    const before = await invoke(bridge, REMINDERS_LIST_ID, { list: "Groceries" });
    const beforeTitles = (before.output as { reminders: { title: string }[] }).reminders.map((r) => r.title);
    expect(beforeTitles).not.toContain("Buy oat milk");

    // WRITE: create the reminder.
    const created = await invoke(bridge, REMINDERS_CREATE_ID, {
      title: "Buy oat milk",
      list: "Groceries",
      notes: "the barista kind",
    });
    expect(created.ok).toBe(true);
    const createdOut = created.output as { id: string; list: string; title: string; completed: boolean };
    expect(createdOut.title).toBe("Buy oat milk");
    expect(createdOut.list).toBe("Groceries");
    expect(createdOut.completed).toBe(false);
    expect(typeof createdOut.id).toBe("string");

    // After: the list now shows it (the round-trip proof).
    const after = await invoke(bridge, REMINDERS_LIST_ID, { list: "Groceries" });
    const afterItems = (after.output as { reminders: { id: string; title: string }[] }).reminders;
    expect(afterItems.map((r) => r.title)).toContain("Buy oat milk");
    expect(afterItems.find((r) => r.title === "Buy oat milk")!.id).toBe(createdOut.id);
  });

  it("create requires a title (schema_validation_failed otherwise)", async () => {
    const bridge = bridgeWithFake();
    const res = await invoke(bridge, REMINDERS_CREATE_ID, {});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });

  it("complete flips a reminder to completed (second write)", async () => {
    const provider = new FakeRemindersProvider();
    const bridge = bridgeWithFake(provider);
    const res = await invoke(bridge, REMINDERS_COMPLETE_ID, { id: "rem-1" });
    expect(res.ok).toBe(true);
    expect((res.output as { completed: boolean }).completed).toBe(true);

    const done = await invoke(bridge, REMINDERS_LIST_ID, { completed: true });
    const doneIds = (done.output as { reminders: { id: string }[] }).reminders.map((r) => r.id);
    expect(doneIds).toContain("rem-1");
  });
});

describe("apple-reminders source: health reflects available()", () => {
  it("ok with the fake provider (no macOS permission needed)", async () => {
    const source = new AppleRemindersSource(platformStub(), { provider: new FakeRemindersProvider() });
    const h = await source.health();
    expect(h.status).toBe("ok");
    const req = await source.checkRequirements();
    expect(req.ok).toBe(true);
  });

  it("unavailable with a precise TCC reason when the provider reports denied (NOT a registration block)", async () => {
    const denied: RemindersProvider = {
      async available() {
        return {
          ok: false,
          reason: "Reminders access not granted — approve Plexus in System Settings ▸ Privacy ▸ Reminders",
        };
      },
      async listLists() {
        return [];
      },
      async listReminders() {
        return [];
      },
      async createReminder() {
        throw new Error("denied");
      },
      async completeReminder() {
        throw new Error("denied");
      },
    };
    const source = new AppleRemindersSource(platformStub(), { provider: denied });
    const h = await source.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("System Settings");
    expect(h.detail).toContain("Reminders");
    // Health does NOT block registration: scan() still surfaces the full entry set.
    const ids = (await source.scan()).map((e) => e.id);
    expect(ids).toContain(REMINDERS_CREATE_ID);
  });
});
