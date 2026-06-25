/**
 * Workspace FIRST-PARTY source — provider seam (fake temp-dir), entries (read/list +
 * write caps), registry routability, the write→read round-trip, health-from-available(),
 * AND the path-confinement negatives (the security core) for BOTH read and write.
 *
 * The workspace exposes ONE authorized directory as a path-confined surface:
 *   - READ/LIST via the confined fs (`workspace.list`, `workspace.read`, grants:["read"]).
 *   - WRITE via the confined fs (`workspace.write`, grants:["write"]) — a write grant on a
 *     first-party source PENDS for the owner upstream (UserConfirmAuthorizer); the source
 *     itself writes no authz code.
 *
 * Proves (with the HERMETIC fake provider — a throwaway temp dir, NO user dir):
 *  - the module registers as FIRST-PARTY (reserved source id ⇒ provenance "first-party");
 *  - scan() yields the two READ caps + the WRITE cap (+ the how-to skill), well-formed;
 *  - the WRITE cap is grants:["write"]; the READ caps are grants:["read"];
 *  - `workspace.write` writes a file, and a follow-up `workspace.read` SHOWS it (round-trip);
 *  - health() reflects provider.available() (ok for fake; unavailable for a missing dir);
 *  - CONFINEMENT (read AND write): a `..` traversal / absolute / symlink-escape is REJECTED
 *    — confineToVault throws, and an invoke with a traversal path returns
 *    { ok:false, error.code:"transport_error" } with the out-of-dir content NOT present.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { provenanceFor } from "@plexus/runtime/core/capability-registry.ts";
import {
  confineToVault,
  VaultConfinementError,
} from "@plexus/runtime/sources/obsidian/vault-reader.ts";
import {
  workspaceSourceModule,
  WorkspaceSource,
  WorkspaceBridge,
  workspaceEntries,
  FakeWorkspaceProvider,
  RealWorkspaceProvider,
  WorkspaceConfinementError,
  WORKSPACE_SOURCE_ID,
  WORKSPACE_LIST_ID,
  WORKSPACE_READ_ID,
  WORKSPACE_WRITE_ID,
  WORKSPACE_HOW_TO_USE_ID,
} from "@plexus/runtime/sources/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  EntryKind,
  GrantVerb,
  InvokeContext,
  PlatformServices,
  SourceModule,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Create a fresh authorized workspace dir with a couple of files + a secret OUTSIDE it. */
function makeWorkspace(): { root: string; outsideSecret: string } {
  const parent = mkdtempSync(join(tmpdir(), "plexus-workspace-"));
  tmpDirs.push(parent);
  const root = join(parent, "Authorized");
  mkdirSync(join(root, "refs"), { recursive: true });
  writeFileSync(join(root, "me.md"), "# Me\nI like pixel-art cats.\n");
  writeFileSync(join(root, "refs", "notes.md"), "# Notes\nPomodoro apps I tried.\n");
  // A sensitive file OUTSIDE the workspace, as a confinement target.
  const outsideSecret = join(parent, "SECRET.txt");
  writeFileSync(outsideSecret, "TOP SECRET — must never be readable/writable via the workspace.\n");
  return { root, outsideSecret };
}

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
function bridgeDeps(entries = workspaceEntries()): { deps: BridgeDeps; events: AuditEventInput[] } {
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

describe("workspace source: provenance + scan() entries", () => {
  it("is FIRST-PARTY (reserved source id derived from MODULES)", () => {
    expect(provenanceFor(WORKSPACE_SOURCE_ID)).toBe("first-party");
  });

  it("scan() yields the two READ caps + the WRITE cap + the how-to skill", async () => {
    const source = new WorkspaceSource(platformStub(), new FakeWorkspaceProvider());
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    expect(byId.has(WORKSPACE_LIST_ID)).toBe(true);
    expect(byId.has(WORKSPACE_READ_ID)).toBe(true);
    expect(byId.has(WORKSPACE_WRITE_ID)).toBe(true);
    expect(byId.has(WORKSPACE_HOW_TO_USE_ID)).toBe(true);

    // READ/LIST caps are grants:["read"]; the WRITE cap is grants:["write"].
    expect(byId.get(WORKSPACE_LIST_ID)!.grants).toEqual(["read"]);
    expect(byId.get(WORKSPACE_READ_ID)!.grants).toEqual(["read"]);
    expect(byId.get(WORKSPACE_WRITE_ID)!.grants).toEqual(["write"]);

    // The skill is read-as-context (transport "skill", no grants, has a body).
    const skill = byId.get(WORKSPACE_HOW_TO_USE_ID)!;
    expect(skill.kind).toBe("skill");
    expect(skill.transport).toBe("skill");
    expect(skill.grants).toEqual([]);
    expect(skill.body?.format).toBe("markdown");
    expect(skill.body?.markdown).toContain("PENDS");
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const entries = workspaceEntries();
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];

    for (const e of entries) {
      expect(e.id.startsWith("workspace.")).toBe(true);
      expect(e.source).toBe("workspace");
      expect(validKinds).toContain(e.kind);
      expect(e.describe.length).toBeGreaterThan(20);
      for (const v of e.grants) expect(validVerbs).toContain(v);
      if (e.kind === "capability") {
        expect(e.transport).toBe("ipc");
        expect((e.extras as { firstParty?: boolean })?.firstParty).toBe(true);
      }
      if (e.kind === "skill") {
        expect(e.transport).toBe("skill");
        expect(e.body).toBeDefined();
      }
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // ids unique
  });
});

describe("workspace source: registry routability", () => {
  it("the three capabilities appear in the registry after registering the module", async () => {
    const reg = createCapabilityRegistry(testRegistry([workspaceSourceModule]));
    await reg.refresh();

    const ids = reg.all().map((e) => e.id);
    expect(ids).toContain(WORKSPACE_LIST_ID);
    expect(ids).toContain(WORKSPACE_READ_ID);
    expect(ids).toContain(WORKSPACE_WRITE_ID);

    // The write cap surfaces in the .well-known summary projection with its grant cost.
    const write = reg.summaries().find((s) => s.id === WORKSPACE_WRITE_ID)!;
    expect(write.grants).toEqual(["write"]);
    const list = reg.summaries().find((s) => s.id === WORKSPACE_LIST_ID)!;
    expect(list.grants).toEqual(["read"]);
  });
});

describe("workspace bridge: read/list + write through the injected fake provider", () => {
  it("workspace.list lists the authorized dir contents", async () => {
    const { root } = makeWorkspace();
    const { deps } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));

    expect(bridge.route(WORKSPACE_LIST_ID)).toBe("handled");
    const res = await bridge.invoke({ id: WORKSPACE_LIST_ID, input: {} }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { type: string; entries: { name: string }[] };
    expect(out.type).toBe("dir");
    expect(out.entries.map((e) => e.name)).toContain("me.md");
    expect(out.entries.map((e) => e.name)).toContain("refs");
  });

  it("workspace.read returns a real file's content", async () => {
    const { root } = makeWorkspace();
    const { deps } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));

    const res = await bridge.invoke({ id: WORKSPACE_READ_ID, input: { path: "refs/notes.md" } }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { type: string; content: string; relativePath: string };
    expect(out.type).toBe("file");
    expect(out.content).toContain("Pomodoro apps I tried");
    expect(out.relativePath).toBe("refs/notes.md");
  });

  it("workspace.write writes a file, and a follow-up read SHOWS it (round-trip)", async () => {
    const { root } = makeWorkspace();
    const { deps, events } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));

    const write = await bridge.invoke(
      { id: WORKSPACE_WRITE_ID, input: { path: "PRD.html", content: "<h1>Pomodoro PRD</h1>" } },
      CTX,
    );
    expect(write.ok).toBe(true);
    const writeOut = write.output as { ok: boolean; relativePath: string; bytes: number };
    expect(writeOut.ok).toBe(true);
    expect(writeOut.relativePath).toBe("PRD.html");
    expect(writeOut.bytes).toBeGreaterThan(0);

    // The write was audited with the WRITE verb.
    const writeAudit = events.find((e) => e.capabilityId === WORKSPACE_WRITE_ID);
    expect(writeAudit?.verbs).toEqual(["write"]);

    // The file really landed under the authorized root.
    expect(existsSync(join(root, "PRD.html"))).toBe(true);

    // Round-trip: a follow-up read shows the written content.
    const read = await bridge.invoke({ id: WORKSPACE_READ_ID, input: { path: "PRD.html" } }, CTX);
    const out = read.output as { content: string };
    expect(out.content).toContain("Pomodoro PRD");
  });

  it("workspace.read rejects a missing path with schema_validation_failed", async () => {
    const { root } = makeWorkspace();
    const { deps } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));
    const res = await bridge.invoke({ id: WORKSPACE_READ_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });

  it("workspace.write rejects missing content with schema_validation_failed", async () => {
    const { root } = makeWorkspace();
    const { deps } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));
    const res = await bridge.invoke({ id: WORKSPACE_WRITE_ID, input: { path: "x.txt" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });
});

// ── Unit-level confinement assertions (the security core, read AND write) ──────
describe("workspace path confinement (read AND write)", () => {
  it("confineToVault REJECTS a `..` traversal escape", () => {
    const { root } = makeWorkspace();
    expect(() => confineToVault(root, "../SECRET.txt")).toThrow(VaultConfinementError);
    expect(() => confineToVault(root, "refs/../../SECRET.txt")).toThrow(VaultConfinementError);
    // The re-exported alias is the SAME error class.
    expect(() => confineToVault(root, "../SECRET.txt")).toThrow(WorkspaceConfinementError);
  });

  it("confineToVault REJECTS an absolute path", () => {
    const { root, outsideSecret } = makeWorkspace();
    expect(() => confineToVault(root, outsideSecret)).toThrow(VaultConfinementError);
    expect(() => confineToVault(root, "/etc/passwd")).toThrow(VaultConfinementError);
  });

  it("confineToVault REJECTS a symlink inside the workspace that points outside", () => {
    const { root, outsideSecret } = makeWorkspace();
    const link = join(root, "escape.txt");
    symlinkSync(outsideSecret, link);
    expect(() => confineToVault(root, "escape.txt")).toThrow(VaultConfinementError);
  });
});

describe("workspace bridge: confinement through the invoke pipeline (read AND write)", () => {
  it("a traversal READ invoke is REJECTED, and the secret content is NOT returned", async () => {
    const { root } = makeWorkspace();
    const { deps } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));

    const res = await bridge.invoke({ id: WORKSPACE_READ_ID, input: { path: "../SECRET.txt" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    // Crucially, the out-of-dir secret content is NOT returned.
    expect(JSON.stringify(res)).not.toContain("TOP SECRET");
  });

  it("an absolute-path READ invoke is REJECTED", async () => {
    const { root, outsideSecret } = makeWorkspace();
    const { deps } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));

    const res = await bridge.invoke({ id: WORKSPACE_READ_ID, input: { path: outsideSecret } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    expect(JSON.stringify(res)).not.toContain("TOP SECRET");
  });

  it("a traversal WRITE invoke is REJECTED, and nothing is written outside the dir", async () => {
    const { root, outsideSecret } = makeWorkspace();
    const { deps } = bridgeDeps();
    const bridge = new WorkspaceBridge(deps, "s1", workspaceEntries(), new FakeWorkspaceProvider({ root }));

    const res = await bridge.invoke(
      { id: WORKSPACE_WRITE_ID, input: { path: "../HACKED.txt", content: "pwned" } },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    // The escape target was NOT created outside the workspace.
    expect(existsSync(join(root, "..", "HACKED.txt"))).toBe(false);
    // And the existing out-of-dir secret was NOT overwritten by an absolute write.
    const abs = await bridge.invoke(
      { id: WORKSPACE_WRITE_ID, input: { path: outsideSecret, content: "pwned" } },
      CTX,
    );
    expect(abs.ok).toBe(false);
    expect(abs.error?.code).toBe("transport_error");
  });
});

describe("workspace source: health reflects provider.available()", () => {
  it("fake provider ⇒ ok", async () => {
    const source = new WorkspaceSource(platformStub(), new FakeWorkspaceProvider());
    expect((await source.health()).status).toBe("ok");
    expect((await source.checkRequirements()).ok).toBe(true);
  });

  it("a real provider at a REAL dir ⇒ ok", async () => {
    const { root } = makeWorkspace();
    const source = new WorkspaceSource(platformStub(), new RealWorkspaceProvider(root));
    expect((await source.health()).status).toBe("ok");
  });

  it("a real provider at a MISSING dir ⇒ unavailable with a precise reason", async () => {
    const parent = mkdtempSync(join(tmpdir(), "plexus-workspace-missing-"));
    tmpDirs.push(parent);
    const missing = join(parent, "Ghost");
    const source = new WorkspaceSource(platformStub(), new RealWorkspaceProvider(missing));
    const h = await source.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("workspace directory not found");
  });

  it("a real provider with NO configured dir ⇒ unavailable", async () => {
    const source = new WorkspaceSource(platformStub(), new RealWorkspaceProvider(""));
    const h = await source.health();
    expect(h.status).toBe("unavailable");
    expect(h.detail).toContain("no workspace directory configured");
  });
});
