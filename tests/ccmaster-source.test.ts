/**
 * t8 — cc-master FIRST-PARTY source: checkRequirements, scan/entries
 * well-formedness, and registry grant+invoke routability (Acceptance Scenario A).
 *
 * Proves:
 *  - checkRequirements() detects Claude Code (resolveBinary "claude") + reports the
 *    live cc-master install state (read from an injected TEMP .claude dir; never the
 *    real ~/.claude).
 *  - scan() exposes the orchestration WORKFLOW + its MEMBERS (so members[] resolve
 *    to present entries) + skill entries, all well-formed against the frozen
 *    CapabilityEntry contract.
 *  - after registering the module, `cc-master.orchestration.run` appears in the
 *    registry/manifest and is grant+invoke-routable (the workflow transport fans
 *    out to its members through the uniform pipeline).
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTransports } from "../src/transports/index.ts";
import { createCapabilityRegistry } from "../src/core/capability-registry.ts";
import {
  ccMasterSourceModule,
  ccMasterEntries,
  CcMasterSource,
  ORCHESTRATION_RUN_ID,
} from "../src/sources/index.ts";
import { CC_MASTER_PLUGIN_KEY } from "../src/sources/cc-master/install.ts";
import { BaseCapabilityBridge } from "../src/sources/base.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityId,
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

function platformStub(claudePath: string | undefined): PlatformServices {
  return {
    platform: "darwin",
    async resolveBinary(name) {
      return name === "claude" ? claudePath : undefined;
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
  const transports = buildTransports(platformStub("/usr/local/bin/claude"));
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id),
    getTransport: (kind: TransportKind): Transport => transports[kind],
  };
}

describe("cc-master source: checkRequirements", () => {
  it("ok when `claude` resolves; reports install state from an injected temp dir", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "plexus-ccm-"));
    try {
      const source = new CcMasterSource(platformStub("/usr/local/bin/claude"), { claudeDir });
      const req = await source.checkRequirements();
      expect(req.ok).toBe(true);
      expect(req.resolved).toContain("claude=/usr/local/bin/claude");
      // fresh temp dir ⇒ not installed yet
      expect(req.resolved).toContain("not installed");
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  it("reports enabled when the injected temp settings already has cc-master", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "plexus-ccm-"));
    try {
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: { [CC_MASTER_PLUGIN_KEY]: true },
          extraKnownMarketplaces: {
            "cc-master": { source: { source: "github", repo: "nemori-ai/cc-master" } },
          },
        }),
      );
      const source = new CcMasterSource(platformStub("/usr/local/bin/claude"), { claudeDir });
      const req = await source.checkRequirements();
      expect(req.ok).toBe(true);
      expect(req.resolved).toContain("cc-master enabled");
      expect(req.resolved).toContain("marketplace known");
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  it("NOT ok when `claude` is absent (orchestration runs inside Claude Code)", async () => {
    const source = new CcMasterSource(platformStub(undefined), { claudeDir: tmpdir() });
    const req = await source.checkRequirements();
    expect(req.ok).toBe(false);
    expect(req.reason).toContain("Claude Code");
  });
});

describe("cc-master source: scan() + entry well-formedness", () => {
  it("exposes the orchestration workflow + its members + skills", async () => {
    const source = new CcMasterSource(platformStub("/usr/local/bin/claude"), { claudeDir: tmpdir() });
    const entries = await source.scan();
    const byId = new Map(entries.map((e) => [e.id, e]));

    const wf = byId.get(ORCHESTRATION_RUN_ID)!;
    expect(wf.kind).toBe("workflow");
    expect(wf.transport).toBe("workflow");
    expect(wf.grants).toEqual(["execute"]);
    expect(wf.source).toBe("cc-master");

    // Members MUST resolve to PRESENT entries (transitive grants have real targets).
    expect(wf.members?.length).toBe(3);
    for (const m of wf.members!) {
      const member = byId.get(m.id);
      expect(member).toBeDefined();
      // The workflow's verbs on a member must be a subset of that member's required grants.
      for (const v of m.verbs) {
        expect(member!.grants).toContain(v);
      }
    }

    // Skills surfaced as kind:"skill", read-as-context (transport "skill", no grants).
    const skills = entries.filter((e) => e.kind === "skill");
    expect(skills.length).toBeGreaterThanOrEqual(2);
    for (const s of skills) {
      expect(s.transport).toBe("skill");
      expect(s.grants).toEqual([]);
      expect(s.body?.format).toBe("markdown");
    }
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", async () => {
    const entries = ccMasterEntries();
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];

    for (const e of entries) {
      // Identity + ID-DERIVATION RULE: id is <sourceSlug>.<noun>.<verb>; source recoverable.
      expect(typeof e.id).toBe("string");
      expect(e.id.startsWith("cc-master.")).toBe(true);
      expect(e.source).toBe("cc-master");
      expect(validKinds).toContain(e.kind);
      expect(typeof e.label).toBe("string");
      expect(e.describe.length).toBeGreaterThan(20);
      expect(Array.isArray(e.grants)).toBe(true);
      for (const v of e.grants) expect(validVerbs).toContain(v);

      // Transport must agree with kind for the two sentinel kinds.
      if (e.kind === "workflow") expect(e.transport).toBe("workflow");
      if (e.kind === "skill") expect(e.transport).toBe("skill");
      // A workflow MUST carry members; a skill MUST carry a body.
      if (e.kind === "workflow") expect((e.members?.length ?? 0)).toBeGreaterThan(0);
      if (e.kind === "skill") expect(e.body).toBeDefined();
    }

    // ids are unique.
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("cc-master: registry routability (grant + invoke surfaces)", () => {
  it("orchestration.run appears in the registry/manifest after registering the module", async () => {
    const reg = createCapabilityRegistry(testRegistry([ccMasterSourceModule]));
    await reg.refresh();

    const ids = reg.all().map((e) => e.id);
    expect(ids).toContain(ORCHESTRATION_RUN_ID);

    const wf = reg.getEntry(ORCHESTRATION_RUN_ID)!;
    expect(wf.transport).toBe("workflow");
    // Members resolve to present registry entries (transitive grant targets are real).
    for (const m of wf.members!) {
      expect(reg.getEntry(m.id)).toBeDefined();
    }

    // It also surfaces in the .well-known summary projection (with the grant cost).
    const summary = reg.summaries().find((s) => s.id === ORCHESTRATION_RUN_ID)!;
    expect(summary.kind).toBe("workflow");
    expect(summary.grants).toEqual(["execute"]);
  });

  it("orchestration.run is invoke-routable: the workflow transport fans out to members", async () => {
    const entries = ccMasterEntries();
    const byId = new Map(entries.map((e) => [e.id, e]));

    const events: AuditEventInput[] = [];
    const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
      events.push(e);
      return { ...e, id: `a-${events.length}`, at: new Date().toISOString() };
    };

    const invokedMembers: CapabilityId[] = [];
    const invokeById = async (req: InvokeRequest, _c: InvokeContext): Promise<InvokeResponse> => {
      invokedMembers.push(req.id);
      return { id: req.id, ok: true, output: { ran: req.id }, auditId: "member" };
    };

    const transports = buildTransports(platformStub("/usr/local/bin/claude"));
    const deps: BridgeDeps = {
      audit,
      getTransport: (k: TransportKind): Transport => transports[k],
      getEntry: (id) => byId.get(id),
      invokeById,
    };

    const bridge = new BaseCapabilityBridge("cc-master", deps, "s1", entries);
    const ctx: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

    // route() owns the workflow id; invoke() resolves the workflow transport (no kind
    // branch) and fans out to the members IN ORDER through the same pipeline.
    expect(bridge.route(ORCHESTRATION_RUN_ID)).toBe("handled");
    const res = await bridge.invoke({ id: ORCHESTRATION_RUN_ID, input: { goal: "ship plexus" } }, ctx);

    expect(res.ok).toBe(true);
    expect(invokedMembers).toEqual([
      "cc-master.board.create",
      "cc-master.agent.dispatch",
      "cc-master.board.status",
    ]);
    expect(events.filter((e) => e.capabilityId === ORCHESTRATION_RUN_ID).length).toBe(1);
  });
});
