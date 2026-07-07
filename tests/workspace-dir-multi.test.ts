/**
 * workspace-dir — SAME-KIND MULTI-INSTANCE (managed directory sources).
 *
 * The `workspace-dir` kind adapter lets a user expose N directories, each as its OWN
 * managed source (own id, own path, own grants). This test pins the crux invariants:
 *
 *   1. TWO instances (different ids, different roots) register TWO independent
 *      capability sets — `<id>.list|read|write|how-to-use` — with no id collision.
 *   2. NO CROSS-INTERCEPTION: each instance's handlers are closed over ITS root —
 *      instance A serves A's files only; a file that exists only under B's root is
 *      NOT readable through A (and vice versa); A's write lands under A's root only.
 *   3. CONFINEMENT per instance: traversal out of A's root is rejected even though
 *      B's root is a sibling directory (no "the other instance's root is fair game").
 *   4. INDEPENDENT GRANTS: removing instance A purges A's grants and leaves B's.
 *   5. RECONFIGURE PURGE SEMANTICS (security surface):
 *        - route.path change   → purge (new confinement target);
 *        - approval flip       → purge in BOTH directions (see manage.ts ruling);
 *        - label-only change   → NO purge.
 *   6. BUILDER GUARDS: the reserved `workspace` id and an empty path are rejected
 *      (a managed instance must never shadow the singleton nor fall back to
 *      PLEXUS_WORKSPACE_DIR).
 *
 * Uses a throwaway PLEXUS_HOME + throwaway temp roots — never touches ~/.plexus.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  InvokeContext,
  SourceRegistry,
  Transport,
  TransportKind,
} from "@plexus/protocol";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";
import { buildTransports } from "@plexus/runtime/transports/index.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { createGrantStore } from "@plexus/runtime/core/grants.ts";
import { createManagedSources } from "@plexus/runtime/sources/config/manage.ts";
import type { ConfiguredSource } from "@plexus/runtime/sources/config/types.ts";
import { MODULES } from "@plexus/runtime/sources/index.ts";
import {
  workspaceDirManifest,
  workspaceDirHealth,
  WORKSPACE_DIR_KIND,
  WORKSPACE_SOURCE_ID,
} from "@plexus/runtime/sources/index.ts";

const tmpDirs: string[] = [];
let home: string;

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  home = tempDir("plexus-wsdir-home-");
  process.env.PLEXUS_HOME = home;
});

afterEach(() => {
  delete process.env.PLEXUS_HOME;
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Two sibling roots under ONE parent (so `..` traversal from A would reach B). */
function makeRoots(): { parent: string; rootA: string; rootB: string } {
  const parent = tempDir("plexus-wsdir-roots-");
  const rootA = join(parent, "A");
  const rootB = join(parent, "B");
  mkdirSync(rootA, { recursive: true });
  mkdirSync(rootB, { recursive: true });
  writeFileSync(join(rootA, "a.md"), "# A\nonly-in-A\n");
  writeFileSync(join(rootB, "b.md"), "# B\nonly-in-B\n");
  return { parent, rootA, rootB };
}

function cfgFor(id: string, path: string, extra?: Partial<ConfiguredSource>): ConfiguredSource {
  return {
    id,
    kind: WORKSPACE_DIR_KIND,
    label: `Dir ${id}`,
    enabled: true,
    transport: "ipc",
    route: { path },
    ...extra,
  };
}

/** Fresh registry + grants + managed-sources over the REAL source registry. */
function freshDeps() {
  const platform = getPlatformServices();
  const sources = createSourceRegistry(platform);
  const capabilities = createCapabilityRegistry(sources);
  const grants = createGrantStore();
  const managed = createManagedSources({ capabilities, grants });
  return { sources, capabilities, grants, managed };
}

/** BridgeDeps stub over the live capability registry (records audit inputs). */
function bridgeDeps(capabilities: ReturnType<typeof createCapabilityRegistry>): {
  deps: BridgeDeps;
  events: AuditEventInput[];
} {
  const events: AuditEventInput[] = [];
  const transports = buildTransports(getPlatformServices());
  const deps: BridgeDeps = {
    audit: async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
    },
    getTransport: (k: TransportKind): Transport => transports[k],
    getEntry: (id) => capabilities.get(id),
    invokeById: async (req) => ({ id: req.id, ok: true, output: {}, auditId: "x" }),
  };
  return { deps, events };
}

const CTX: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

describe("workspace-dir: two instances = two independent capability sets", () => {
  it("registers <id>.list|read|write|how-to-use for BOTH ids, live + persisted", async () => {
    const { rootA, rootB } = makeRoots();
    const { capabilities, managed } = freshDeps();

    const resA = await managed.add(cfgFor("notes-a", rootA));
    const resB = await managed.add(cfgFor("notes-b", rootB));
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    for (const id of ["notes-a", "notes-b"]) {
      for (const verb of ["list", "read", "write", "how-to-use"]) {
        expect(capabilities.get(`${id}.${verb}`)).toBeDefined();
      }
    }
    // The two sets are disjoint by construction (ids derive from the source id).
    expect(resA.registered.every((cid) => cid.startsWith("notes-a."))).toBe(true);
    expect(resB.registered.every((cid) => cid.startsWith("notes-b."))).toBe(true);
    // Persisted desired state holds both.
    expect(managed.list().map((s) => s.id).sort()).toEqual(["notes-a", "notes-b"]);
  });

  it("P2: the capability describe reads cleanly (no 'directory directory' duplication)", async () => {
    const { rootA } = makeRoots();
    const { capabilities, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA)); // label "Dir notes-a"
    for (const verb of ["list", "read", "write"]) {
      const describe = capabilities.get(`notes-a.${verb}`)!.describe;
      expect(describe).not.toContain("directory directory");
      expect(describe).toContain('"Dir notes-a" directory');
    }
  });

  it("each instance's ops are keyed by ITS source id (no cross-interception surface)", async () => {
    const { rootA, rootB } = makeRoots();
    const { capabilities, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));
    await managed.add(cfgFor("notes-b", rootB));

    const opOf = (cid: string): string =>
      ((capabilities.get(cid)?.extras?.route as { op?: string } | undefined)?.op ?? "");
    expect(opOf("notes-a.read")).toBe("notes-a.read");
    expect(opOf("notes-b.read")).toBe("notes-b.read");
    expect(opOf("notes-a.write")).toBe("notes-a.write");
    expect(opOf("notes-b.write")).toBe("notes-b.write");
  });
});

describe("workspace-dir: per-instance confinement through the real bridges", () => {
  it("A reads A's files; B's files are NOT reachable through A (and vice versa)", async () => {
    const { rootA, rootB } = makeRoots();
    const { sources, capabilities, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));
    await managed.add(cfgFor("notes-b", rootB));

    const { deps } = bridgeDeps(capabilities);
    // The registry overlay resolves the runtime-registered modules (same seam the
    // invoke pipeline uses) — each id gets ITS OWN bridge with ITS OWN handlers.
    const bridgeA = (sources as SourceRegistry).get("notes-a")!.createBridge(deps, "s1");
    const bridgeB = (sources as SourceRegistry).get("notes-b")!.createBridge(deps, "s1");

    // A serves a.md; B serves b.md.
    const readA = await bridgeA.invoke({ id: "notes-a.read", input: { path: "a.md" } }, CTX);
    expect(readA.ok).toBe(true);
    expect((readA.output as { content: string }).content).toContain("only-in-A");

    const readB = await bridgeB.invoke({ id: "notes-b.read", input: { path: "b.md" } }, CTX);
    expect(readB.ok).toBe(true);
    expect((readB.output as { content: string }).content).toContain("only-in-B");

    // The OTHER instance's file is NOT served (different root ⇒ not found, never content).
    const cross = await bridgeA.invoke({ id: "notes-a.read", input: { path: "b.md" } }, CTX);
    expect(cross.ok).toBe(false);
    expect(JSON.stringify(cross)).not.toContain("only-in-B");

    // Bridge A does not own B's capability id at all (route() is passthrough).
    expect(bridgeA.route("notes-b.read")).toBe("passthrough");
    expect(bridgeB.route("notes-a.read")).toBe("passthrough");
  });

  it("traversal from A toward B's sibling root is REJECTED (confinement per instance)", async () => {
    const { rootA } = makeRoots();
    const { sources, capabilities, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));

    const { deps } = bridgeDeps(capabilities);
    const bridgeA = (sources as SourceRegistry).get("notes-a")!.createBridge(deps, "s1");

    const escape = await bridgeA.invoke(
      { id: "notes-a.read", input: { path: "../B/b.md" } },
      CTX,
    );
    expect(escape.ok).toBe(false);
    expect(escape.error?.code).toBe("transport_error");
    expect(JSON.stringify(escape)).not.toContain("only-in-B");
  });

  it("A's write lands under A's root ONLY, and round-trips through A's read", async () => {
    const { rootA, rootB } = makeRoots();
    const { sources, capabilities, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));
    await managed.add(cfgFor("notes-b", rootB));

    const { deps } = bridgeDeps(capabilities);
    const bridgeA = (sources as SourceRegistry).get("notes-a")!.createBridge(deps, "s1");

    const write = await bridgeA.invoke(
      { id: "notes-a.write", input: { path: "new.md", content: "written-via-A" } },
      CTX,
    );
    expect(write.ok).toBe(true);
    expect(existsSync(join(rootA, "new.md"))).toBe(true);
    expect(existsSync(join(rootB, "new.md"))).toBe(false);

    const back = await bridgeA.invoke({ id: "notes-a.read", input: { path: "new.md" } }, CTX);
    expect((back.output as { content: string }).content).toContain("written-via-A");
  });
});

describe("workspace-dir: independent grants + remove purges only the removed instance", () => {
  it("removing A purges A's grants and leaves B's intact", async () => {
    const { rootA, rootB } = makeRoots();
    const { capabilities, grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));
    await managed.add(cfgFor("notes-b", rootB));

    const stamp = {
      verbs: ["read"] as ["read"],
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...stamp });
    grants.put({ agentId: "agent-x", capabilityId: "notes-b.read", ...stamp });

    await managed.remove("notes-a");

    expect(capabilities.get("notes-a.read")).toBeUndefined();
    expect(grants.get("agent-x", "notes-a.read")).toBeUndefined();
    // B untouched: capability live, grant intact.
    expect(capabilities.get("notes-b.read")).toBeDefined();
    expect(grants.get("agent-x", "notes-b.read")).toBeDefined();
  });
});

describe("workspace-dir: reconfigure purge semantics (security surface)", () => {
  const grantStamp = {
    verbs: ["read"] as ["read"],
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it("route.path change PURGES the instance's grants (new confinement target)", async () => {
    const { rootA, rootB } = makeRoots();
    const { grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...grantStamp });

    const res = await managed.reconfigure("notes-a", { route: { path: rootB } });
    expect(res.ok).toBe(true);
    // The prior approval pointed at the OLD directory — it must NOT carry over.
    expect(grants.get("agent-x", "notes-a.read")).toBeUndefined();
  });

  it("approval flip auto→ask PURGES (grants acquired under auto were never human-reviewed)", async () => {
    const { rootA } = makeRoots();
    const { grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA)); // approval defaults to auto
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...grantStamp });

    const res = await managed.reconfigure("notes-a", { approval: "ask" });
    expect(res.ok).toBe(true);
    expect(grants.get("agent-x", "notes-a.read")).toBeUndefined();
    expect(managed.list().find((s) => s.id === "notes-a")?.approval).toBe("ask");
  });

  it("approval flip ask→auto PURGES too (the 'protected' premise the approvals were given under is gone)", async () => {
    const { rootA } = makeRoots();
    const { grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA, { approval: "ask" }));
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...grantStamp });

    const res = await managed.reconfigure("notes-a", { approval: "auto" });
    expect(res.ok).toBe(true);
    expect(grants.get("agent-x", "notes-a.read")).toBeUndefined();
  });

  it("a label-only reconfigure does NOT purge (no security surface touched)", async () => {
    const { rootA } = makeRoots();
    const { grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...grantStamp });

    const res = await managed.reconfigure("notes-a", { label: "Renamed" });
    expect(res.ok).toBe(true);
    expect(grants.get("agent-x", "notes-a.read")).toBeDefined();
  });
});

// S2 — the CLI/web-admin/`POST /sources` mutation is `add()`, NOT `reconfigure()`. An
// add that OVERWRITES an existing id with a changed security surface must purge too, or a
// prior auto standing grant would keep reading a now-"Protected" folder.
describe("workspace-dir: add()-overwrite purges the security surface change (S2)", () => {
  const grantStamp = {
    verbs: ["read"] as ["read"],
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    trustWindow: { kind: "7d" as const },
    standing: true,
  };

  it("re-add flipping auto→ask PURGES the prior standing grant (the fix for the silent lie)", async () => {
    const { rootA } = makeRoots();
    const { grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA)); // auto
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...grantStamp });
    expect(grants.get("agent-x", "notes-a.read")).toBeDefined();

    // The UI/CLI re-adds the SAME id with approval:"ask" (no reconfigure subcommand).
    const res = await managed.add(cfgFor("notes-a", rootA, { approval: "ask" }));
    expect(res.ok).toBe(true);
    // The prior AUTO grant must be gone — else hasPriorApproval short-circuits the new
    // "ask" posture and the agent keeps reading for up to the 7d window.
    expect(grants.get("agent-x", "notes-a.read")).toBeUndefined();
    expect(managed.list().find((s) => s.id === "notes-a")?.approval).toBe("ask");
  });

  it("re-add changing route.path PURGES (new confinement target)", async () => {
    const { rootA, rootB } = makeRoots();
    const { grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA));
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...grantStamp });

    const res = await managed.add(cfgFor("notes-a", rootB));
    expect(res.ok).toBe(true);
    expect(grants.get("agent-x", "notes-a.read")).toBeUndefined();
  });

  it("re-add with the SAME surface (label-only) does NOT purge (idempotent re-register)", async () => {
    const { rootA } = makeRoots();
    const { grants, managed } = freshDeps();
    await managed.add(cfgFor("notes-a", rootA, { label: "Notes" }));
    grants.put({ agentId: "agent-x", capabilityId: "notes-a.read", ...grantStamp });

    const res = await managed.add(cfgFor("notes-a", rootA, { label: "Renamed Notes" }));
    expect(res.ok).toBe(true);
    expect(grants.get("agent-x", "notes-a.read")).toBeDefined();
  });
});

describe("workspace-dir: builder guards + health", () => {
  it("rejects the reserved `workspace` id (never shadow the compile-time singleton)", () => {
    expect(() => workspaceDirManifest("/tmp/x", WORKSPACE_SOURCE_ID)).toThrow(/reserved/);
  });

  // S1 — first-party impersonation. EVERY reserved first-party id must be rejected, not
  // just `workspace` (a managed register is `trusted:true` and bypasses the wire-register
  // reservation gate, so this builder is the only guard).
  it("rejects EVERY reserved first-party id (workspace + every compile-time MODULE + obsidian/mock)", () => {
    const reserved = [
      "workspace",
      "obsidian",
      "mock",
      ...MODULES.map((m) => m.id),
    ];
    for (const id of new Set(reserved)) {
      expect(() => workspaceDirManifest("/tmp/x", id)).toThrow(/reserved/);
    }
  });

  it("a NON-reserved id is accepted (the happy path stays open)", () => {
    expect(() => workspaceDirManifest("/tmp/x", "notes-a")).not.toThrow();
    expect(() => workspaceDirManifest("/tmp/x", "my-obsidian")).not.toThrow();
  });

  it("managed.add of a reserved id fails cleanly (materialize failed), no registration/hot-swap", async () => {
    const { capabilities, managed } = freshDeps();
    // `codex`/`apple-calendar`/`obsidian` are reserved; a managed workspace-dir under one
    // must NOT register (which would misclassify as first-party or hot-swap a real source).
    for (const id of ["codex", "apple-calendar", "obsidian"]) {
      const res = await managed.add(cfgFor(id, "/tmp/x"));
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("materialize failed");
      expect(res.reason).toContain("reserved");
    }
    expect(managed.list()).toHaveLength(0);
    // No capability got registered under any reserved id.
    expect(capabilities.get("codex.read")).toBeUndefined();
    expect(capabilities.get("obsidian.read")).toBeUndefined();
    void capabilities;
  });

  it("rejects an empty path (never fall back to PLEXUS_WORKSPACE_DIR)", () => {
    expect(() => workspaceDirManifest("", "notes-a")).toThrow(/route\.path/);
  });

  it("rejects a RELATIVE path (P1 — never confine to the process cwd)", () => {
    expect(() => workspaceDirManifest("relative/notes", "notes-a")).toThrow(/ABSOLUTE/);
  });

  it("managed.add with a missing path fails cleanly (materialize failed), no mutation", async () => {
    const { managed } = freshDeps();
    const res = await managed.add(cfgFor("notes-a", ""));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("materialize failed");
    expect(managed.list()).toHaveLength(0);
  });

  it("health: a real dir is ok; a missing dir is unavailable with a precise reason", async () => {
    const { rootA } = makeRoots();
    expect((await workspaceDirHealth(rootA)).status).toBe("ok");
    const missing = await workspaceDirHealth(join(rootA, "ghost"));
    expect(missing.status).toBe("unavailable");
    expect(missing.detail).toContain("not found");
  });
});
