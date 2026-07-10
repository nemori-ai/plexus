/**
 * Apple Notes FIRST-PARTY source (read + CREATE-ONLY write) — hermetic, fake-provider.
 *
 * Proves (all with the in-memory `FakeNotesProvider`, NO macOS TCC):
 *  - the source registers as FIRST-PARTY (reserved source id / provenance).
 *  - scan() yields three reads + the ONE create write (+ a how-to-use skill),
 *    well-formed against the frozen CapabilityEntry contract.
 *  - THE PRODUCT DECISION: no update/delete/move/rename capability EXISTS — the
 *    entry set has exactly one write, and no id/label/describe advertises a
 *    mutation of existing notes.
 *  - the registry routes the entries; summaries carry the grant cost.
 *  - folders.list / notes.search / notes.read happy paths return the fixtures;
 *    search is bounded (limit clamped, default 20) and requires a query.
 *  - the WRITE notes.create MUTATES the fake store and a subsequent search/read
 *    shows the new note (the create→read round-trip).
 *  - health() reflects the provider's available(): ok for the fake; unavailable
 *    with the precise Automation reason (System Settings › Privacy & Security ›
 *    Automation) when denied — WITHOUT blocking registration.
 */

import { describe, it, expect } from "bun:test";

import { buildTransports } from "@plexus/runtime/transports/index.ts";
import {
  createCapabilityRegistry,
  RESERVED_SOURCE_IDS,
  provenanceFor,
} from "@plexus/runtime/core/capability-registry.ts";
import {
  appleNotesSourceModule,
  appleNotesEntries,
  AppleNotesSource,
  APPLE_NOTES_SOURCE_ID,
  NOTES_FOLDERS_LIST_ID,
  NOTES_SEARCH_ID,
  NOTES_READ_ID,
  NOTES_CREATE_ID,
  NOTES_HOW_TO_USE_SKILL_ID,
} from "@plexus/runtime/sources/index.ts";
import { AppleNotesBridge } from "@plexus/runtime/sources/apple-notes/bridge.ts";
import {
  FakeNotesProvider,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  clampLimit,
  type NotesProvider,
  type NoteHit,
} from "@plexus/runtime/sources/apple-notes/provider.ts";
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
      throw new Error("apple-notes capabilities are served by in-process handlers");
    },
    getEntry: (id) => byId.get(id) as never,
    invokeById: async () => {
      throw new Error("apple-notes does not re-enter the pipeline");
    },
  };
  return { deps, events };
}

const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

/** Build a bridge over a FRESH fake provider (so mutation tests are isolated). */
function bridgeWithFake(provider?: NotesProvider): AppleNotesBridge {
  const entries = appleNotesEntries();
  const { deps } = stubDeps(entries);
  return new AppleNotesBridge(deps, "s1", entries, provider ?? new FakeNotesProvider());
}

async function invoke(
  bridge: AppleNotesBridge,
  id: string,
  input: Record<string, unknown> = {},
): Promise<InvokeResponse> {
  return bridge.invoke({ id, input } as InvokeRequest, ctx);
}

// ── tests ───────────────────────────────────────────────────────────────────────

describe("apple-notes: first-party provenance", () => {
  it("is a reserved first-party source id (provenance first-party)", () => {
    expect(RESERVED_SOURCE_IDS.has(APPLE_NOTES_SOURCE_ID)).toBe(true);
    expect(provenanceFor(APPLE_NOTES_SOURCE_ID)).toBe("first-party");
  });

  it("module id/transport are the reserved id over ipc", () => {
    expect(appleNotesSourceModule.id).toBe(APPLE_NOTES_SOURCE_ID);
    expect(appleNotesSourceModule.transport).toBe("ipc");
  });
});

describe("apple-notes: CREATE-ONLY write surface (the product decision)", () => {
  it("the entry set is EXACTLY the 3 reads + 1 create + 1 skill — nothing else", () => {
    const ids = appleNotesEntries().map((e) => e.id).sort();
    expect(ids).toEqual(
      [
        NOTES_FOLDERS_LIST_ID,
        NOTES_SEARCH_ID,
        NOTES_READ_ID,
        NOTES_CREATE_ID,
        NOTES_HOW_TO_USE_SKILL_ID,
      ].sort(),
    );
  });

  it("NO update/delete/move/rename capability exists (structurally absent, not denied)", () => {
    const entries = appleNotesEntries();
    const forbidden = /(update|delete|remove|move|rename|edit|trash)/i;
    for (const e of entries) {
      expect(forbidden.test(e.id)).toBe(false);
      expect(forbidden.test(e.label)).toBe(false);
    }
    // Exactly ONE entry carries a write grant — the create.
    const writers = entries.filter((e) => e.grants.includes("write"));
    expect(writers.map((e) => e.id)).toEqual([NOTES_CREATE_ID]);
    // No entry carries execute.
    expect(entries.some((e) => e.grants.includes("execute"))).toBe(false);
  });

  it("the provider seam itself has no mutating method beyond createNote", () => {
    const provider = new FakeNotesProvider();
    // The seam's surface: available + 3 reads + createNote. Nothing else callable.
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(provider)).filter(
      (n) => n !== "constructor" && typeof (provider as unknown as Record<string, unknown>)[n] === "function",
    );
    const mutators = proto.filter((n) => /(update|delete|remove|move|rename)/i.test(n));
    expect(mutators).toEqual([]);
    expect(proto).toContain("createNote");
  });
});

describe("apple-notes source: scan() yields well-formed entries", () => {
  it("grants are per-cap exactly as designed", async () => {
    const source = new AppleNotesSource(platformStub(), { provider: new FakeNotesProvider() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    expect(byId.get(NOTES_FOLDERS_LIST_ID)!.grants).toEqual(["read"]);
    expect(byId.get(NOTES_SEARCH_ID)!.grants).toEqual(["read"]);
    expect(byId.get(NOTES_READ_ID)!.grants).toEqual(["read"]);
    expect(byId.get(NOTES_CREATE_ID)!.grants).toEqual(["write"]);
    // The create describe is honest about mutating + create-only.
    const createDescribe = byId.get(NOTES_CREATE_ID)!.describe;
    expect(createDescribe).toContain("MUTATES");
    expect(createDescribe.toLowerCase()).toContain("create-only");

    // The how-to-use skill is read-as-context and attached from every capability.
    const skill = byId.get(NOTES_HOW_TO_USE_SKILL_ID)!;
    expect(skill.kind).toBe("skill");
    expect(skill.transport).toBe("skill");
    expect(skill.grants).toEqual([]);
    expect(skill.body?.format).toBe("markdown");
    expect(skill.body?.markdown).toContain("CREATE-ONLY");
    for (const e of entries.filter((x) => x.kind === "capability")) {
      expect(e.skills?.some((s) => s.id === NOTES_HOW_TO_USE_SKILL_ID)).toBe(true);
    }
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const entries = appleNotesEntries();
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];

    for (const e of entries) {
      expect(typeof e.id).toBe("string");
      expect(e.id.startsWith("apple-notes.")).toBe(true);
      expect(e.source).toBe(APPLE_NOTES_SOURCE_ID);
      expect(validKinds).toContain(e.kind);
      expect(e.describe.length).toBeGreaterThan(20);
      for (const v of e.grants) expect(validVerbs).toContain(v);
      if (e.kind === "skill") {
        expect(e.transport).toBe("skill");
        expect(e.body).toBeDefined();
      } else {
        expect(e.transport).toBe("ipc");
        expect(e.io).toBeDefined();
        // io schemas declare draft 2020-12.
        expect((e.io!.input as { $schema?: string }).$schema).toBe(
          "https://json-schema.org/draft/2020-12/schema",
        );
      }
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("apple-notes: registry routability + grant cost", () => {
  it("entries appear in the registry; create costs write, reads cost read", async () => {
    const reg = createCapabilityRegistry(testRegistry([appleNotesSourceModule]));
    await reg.refresh();

    const ids = reg.all().map((e) => e.id);
    expect(ids).toContain(NOTES_SEARCH_ID);
    expect(ids).toContain(NOTES_CREATE_ID);

    const createSummary = reg.summaries().find((s) => s.id === NOTES_CREATE_ID)!;
    expect(createSummary.kind).toBe("capability");
    expect(createSummary.grants).toEqual(["write"]);

    const searchSummary = reg.summaries().find((s) => s.id === NOTES_SEARCH_ID)!;
    expect(searchSummary.grants).toEqual(["read"]);
  });
});

describe("apple-notes: read happy paths (fake provider)", () => {
  it("folders.list returns the fixture folders with accounts", async () => {
    const bridge = bridgeWithFake();
    const res = await invoke(bridge, NOTES_FOLDERS_LIST_ID);
    expect(res.ok).toBe(true);
    const folders = (res.output as { folders: { name: string; account: string }[] }).folders;
    expect(folders.map((f) => f.name)).toEqual(["Notes", "Recipes", "Work"]);
    expect(folders.every((f) => f.account === "iCloud")).toBe(true);
  });

  it("notes.search matches title AND body text, returns bounded projections", async () => {
    const bridge = bridgeWithFake();
    // "focaccia" appears in note-1's TITLE and note-3's BODY.
    const res = await invoke(bridge, NOTES_SEARCH_ID, { query: "focaccia" });
    expect(res.ok).toBe(true);
    const notes = (res.output as { notes: NoteHit[] }).notes;
    expect(notes.map((n) => n.id).sort()).toEqual(["note-1", "note-3"]);
    for (const hit of notes) {
      // Projection only — id/title/folder/date/snippet, never the html body.
      expect(typeof hit.snippet).toBe("string");
      expect(hit.snippet.length).toBeLessThanOrEqual(201); // 200 + ellipsis
      expect(hit.modifiedAt).toMatch(/^\d{4}-/);
      expect((hit as unknown as Record<string, unknown>).html).toBeUndefined();
    }
  });

  it("notes.search honors + clamps limit (default 20, cap 50) and requires a query", async () => {
    const bridge = bridgeWithFake();
    const limited = await invoke(bridge, NOTES_SEARCH_ID, { query: "focaccia", limit: 1 });
    expect((limited.output as { notes: NoteHit[] }).notes.length).toBe(1);

    // The clamp itself: default when absent/garbage; floor 1; cap 50.
    expect(clampLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampLimit("lots")).toBe(DEFAULT_SEARCH_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(9999)).toBe(MAX_SEARCH_LIMIT);

    const missing = await invoke(bridge, NOTES_SEARCH_ID, {});
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("schema_validation_failed");
  });

  it("notes.read by id returns BOTH plain text and raw HTML", async () => {
    const bridge = bridgeWithFake();
    const res = await invoke(bridge, NOTES_READ_ID, { id: "note-1" });
    expect(res.ok).toBe(true);
    const note = res.output as { id: string; title: string; text: string; html: string; folder: string };
    expect(note.id).toBe("note-1");
    expect(note.title).toBe("Focaccia recipe");
    expect(note.folder).toBe("Recipes");
    expect(note.html).toContain("<div>");
    expect(note.text).toContain("500g flour");
    expect(note.text).not.toContain("<div>");
  });

  it("notes.read by exact title works; unknown ref is a graceful not_found", async () => {
    const bridge = bridgeWithFake();
    const byTitle = await invoke(bridge, NOTES_READ_ID, { title: "Packing list" });
    expect(byTitle.ok).toBe(true);
    expect((byTitle.output as { id: string }).id).toBe("note-3");

    const missing = await invoke(bridge, NOTES_READ_ID, { id: "note-does-not-exist" });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("transport_error");
    expect(missing.error?.message).toContain("no note found");

    const noRef = await invoke(bridge, NOTES_READ_ID, {});
    expect(noRef.ok).toBe(false);
    expect(noRef.error?.code).toBe("schema_validation_failed");
  });
});

describe("apple-notes: WRITE create→read round-trip (fake store mutates)", () => {
  it("create mutates the store; a subsequent search AND read show the new note", async () => {
    // ONE shared fake provider so the write persists across invokes.
    const provider = new FakeNotesProvider();
    const bridge = bridgeWithFake(provider);

    const before = await invoke(bridge, NOTES_SEARCH_ID, { query: "Standup follow-ups" });
    expect((before.output as { notes: NoteHit[] }).notes.length).toBe(0);

    const created = await invoke(bridge, NOTES_CREATE_ID, {
      title: "Standup follow-ups",
      body: "Ping Sam about the ADR.\nBook the retro room.",
      folder: "Work",
    });
    expect(created.ok).toBe(true);
    const out = created.output as { id: string; title: string; folder: string };
    expect(out.title).toBe("Standup follow-ups");
    expect(out.folder).toBe("Work");
    expect(typeof out.id).toBe("string");

    // Round-trip: search finds it, read returns its content by the returned id.
    const after = await invoke(bridge, NOTES_SEARCH_ID, { query: "retro room" });
    const hits = (after.output as { notes: NoteHit[] }).notes;
    expect(hits.map((h) => h.id)).toContain(out.id);

    const read = await invoke(bridge, NOTES_READ_ID, { id: out.id });
    expect(read.ok).toBe(true);
    const note = read.output as { text: string; html: string };
    expect(note.text).toContain("Ping Sam about the ADR.");
    expect(note.html).toContain("<div>");
  });

  it("create requires a title; creating into a nonexistent folder fails gracefully", async () => {
    const bridge = bridgeWithFake();
    const noTitle = await invoke(bridge, NOTES_CREATE_ID, { body: "orphan" });
    expect(noTitle.ok).toBe(false);
    expect(noTitle.error?.code).toBe("schema_validation_failed");

    const badFolder = await invoke(bridge, NOTES_CREATE_ID, { title: "X", folder: "No Such Folder" });
    expect(badFolder.ok).toBe(false);
    expect(badFolder.error?.message).toContain("folder not found");
  });
});

describe("apple-notes source: health reflects available() (never blocks registration)", () => {
  it("ok with the fake provider (no macOS permission needed)", async () => {
    const source = new AppleNotesSource(platformStub(), { provider: new FakeNotesProvider() });
    const h = await source.health();
    expect(h.status).toBe("ok");
    const req = await source.checkRequirements();
    expect(req.ok).toBe(true);
  });

  it("unavailable with the precise Automation instruction when denied — scan() still exposes everything", async () => {
    const source = new AppleNotesSource(platformStub(), {
      provider: new FakeNotesProvider({ notAuthorized: true }),
    });
    const h = await source.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("System Settings › Privacy & Security › Automation");
    // Health does NOT block registration: scan() still surfaces the full entry set.
    const ids = (await source.scan()).map((e) => e.id);
    expect(ids).toContain(NOTES_CREATE_ID);
    expect(ids).toContain(NOTES_SEARCH_ID);
  });

  it("an un-granted provider surfaces a graceful not_authorized on invoke (no crash)", async () => {
    const bridge = bridgeWithFake(new FakeNotesProvider({ notAuthorized: true }));
    const res = await invoke(bridge, NOTES_FOLDERS_LIST_ID);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    expect(res.error?.message).toContain("Automation");
  });
});
