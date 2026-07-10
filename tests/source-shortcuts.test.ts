/**
 * shortcuts — the Apple Shortcuts first-party source (list = read, run = EXECUTE).
 *
 * Proves the execute-gate slice for the `shortcuts` source, the claudecode/codex
 * record-mode precedent applied to user-defined automations:
 *  (1) ENTRIES: `shortcuts.list` is `grants:["read"]`; `shortcuts.run` is
 *      `grants:["execute"]` (⇒ PENDS for the owner) + a how-to skill; every entry
 *      well-formed against the frozen CapabilityEntry shape. The module is in MODULES.
 *  (2) LIST happy path: the bridge returns the provider's shortcuts + folders.
 *  (3) RECORD-MODE (gate OFF, default): NOTHING executes — the provider is never
 *      called; the result is `ok:true, launched:false` carrying the record-mode
 *      reason, and the audit records the exact `shortcuts run …` argv that WOULD
 *      have run (with the input text masked by the placeholder).
 *  (4) GATE ON (`PLEXUS_SHORTCUTS_LAUNCH=1`) + fake provider: the fake EXECUTES
 *      through the same gate the real CLI would.
 *  (5) TIMEOUT: the CLI runner kills at the deadline (`timedOut:true`); the provider
 *      maps that to `ok:false` with a timeout reason; the bridge clamps overrides.
 *  (6) MISSING BINARY (non-macOS): the provider reports `binaryMissing`; the bridge
 *      degrades to the `source_unavailable` ErrorCode; source health is
 *      "unavailable" with a reason — never a throw, never hidden entries.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MODULES } from "@plexus/runtime/sources/index.ts";
import { ShortcutsBridge } from "@plexus/runtime/sources/shortcuts/bridge.ts";
import { RECORD_MODE_REASON } from "@plexus/runtime/sources/shortcuts/bridge.ts";
import { ShortcutsSource, shortcutsSourceModule } from "@plexus/runtime/sources/shortcuts/manifest.ts";
import {
  shortcutsEntries,
  SHORTCUTS_LIST_ID,
  SHORTCUTS_RUN_ID,
  SHORTCUTS_HOW_TO_USE_ID,
  SHORTCUTS_SOURCE_ID,
} from "@plexus/runtime/sources/shortcuts/entries.ts";
import {
  buildRunArgs,
  clampRunTimeout,
  defaultCliRunner,
  DEFAULT_RUN_TIMEOUT_MS,
  FakeShortcutsProvider,
  INPUT_PLACEHOLDER,
  MAX_RUN_TIMEOUT_MS,
  MIN_RUN_TIMEOUT_MS,
  RealShortcutsProvider,
  selectShortcutsProvider,
  shortcutsLaunchEnabled,
  SHORTCUTS_BINARY,
  type CliRunner,
} from "@plexus/runtime/sources/shortcuts/provider.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  EntryKind,
  GrantVerb,
  InvokeContext,
  PlatformServices,
} from "@plexus/protocol";

// Sandbox PLEXUS_HOME (for the WHOLE file) so the launch gate (shortcutsLaunchEnabled →
// realLaunchEnabled) reads an EMPTY source-settings.json and falls to the env flag — the
// invariant these tests assert. Without this it would read the DEVELOPER's real ~/.plexus
// console toggle and the gate tests would depend on out-of-repo machine state.
const PRIOR_PLEXUS_HOME = process.env.PLEXUS_HOME;
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "plexus-shortcuts-home-"));
process.env.PLEXUS_HOME = SANDBOX_HOME;
afterEach(() => {
  // never leak the gate / fake env into the rest of the suite.
  delete process.env.PLEXUS_SHORTCUTS_LAUNCH;
  delete process.env.PLEXUS_FAKE_SHORTCUTS;
});
afterAll(() => {
  try {
    rmSync(SANDBOX_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (PRIOR_PLEXUS_HOME === undefined) delete process.env.PLEXUS_HOME;
  else process.env.PLEXUS_HOME = PRIOR_PLEXUS_HOME;
});

const CTX: InvokeContext = { jti: "jti-1", sessionId: "s1", agentId: "agentX", scopes: [] };

/** A bridge deps stub that records audit events + serves entries from a snapshot. */
function bridgeDeps(entries = shortcutsEntries()): { deps: BridgeDeps; events: AuditEventInput[] } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const events: AuditEventInput[] = [];
  const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
    events.push(e);
    return { ...e, id: `a-${events.length}`, at: new Date().toISOString() } as unknown as AuditEvent;
  };
  const deps: BridgeDeps = {
    audit,
    getTransport: () => {
      throw new Error("shortcuts capabilities are served by in-process handlers; no transport needed");
    },
    getEntry: (id) => byId.get(id),
    invokeById: async () => {
      throw new Error("shortcuts does not re-enter the pipeline");
    },
  };
  return { deps, events };
}

function fakeBridge(provider = new FakeShortcutsProvider()) {
  const { deps, events } = bridgeDeps();
  const bridge = new ShortcutsBridge(deps, "s1", shortcutsEntries(), provider);
  return { bridge, events, provider };
}

// ══════════════════════════════════════════════════════════════════════════════
// (1) ENTRIES — the grant verbs are the contract
// ══════════════════════════════════════════════════════════════════════════════
describe("shortcuts entries: read list + EXECUTE run + how-to skill", () => {
  it("shortcuts.run carries the execute grant verb (⇒ PENDS for the owner)", () => {
    const byId = new Map(shortcutsEntries().map((e) => [e.id, e]));
    const run = byId.get(SHORTCUTS_RUN_ID)!;
    expect(run.grants).toEqual(["execute"]);
    expect(run.kind).toBe("capability");
    expect(run.transport).toBe("ipc");
    expect(run.source).toBe(SHORTCUTS_SOURCE_ID);
    // The input schema is `{ name: string, input?: string, timeoutMs?: number }`.
    const input = run.io?.input;
    expect((input as { required?: string[] }).required).toEqual(["name"]);
    expect((input as { properties?: Record<string, unknown> }).properties).toHaveProperty("input");
    expect((input as { properties?: Record<string, unknown> }).properties).toHaveProperty("timeoutMs");
    // The describe is honest about what this IS: a user-defined automation, owner-gated.
    expect(run.describe).toMatch(/USER-DEFINED AUTOMATION/i);
    expect(run.describe).toMatch(/OWNER-GATED/i);
    expect(run.describe).toMatch(/use when/i);
    // First-party provenance marker.
    expect((run.extras as { firstParty?: boolean }).firstParty).toBe(true);
  });

  it("shortcuts.list is grants:['read'] (discovery only)", () => {
    const list = shortcutsEntries().find((e) => e.id === SHORTCUTS_LIST_ID)!;
    expect(list.grants).toEqual(["read"]);
    expect(list.kind).toBe("capability");
    expect(list.describe).toMatch(/use when/i);
  });

  it("ships a how-to-use SKILL (read-as-context, no grants, has a body)", () => {
    const skill = shortcutsEntries().find((e) => e.id === SHORTCUTS_HOW_TO_USE_ID)!;
    expect(skill.kind).toBe("skill");
    expect(skill.transport).toBe("skill");
    expect(skill.grants).toEqual([]);
    expect(skill.body?.format).toBe("markdown");
    expect((skill.body?.markdown ?? "").length).toBeGreaterThan(50);
    // The bundled skill teaches list-then-run + record mode + the execute gate.
    const md = skill.body?.markdown ?? "";
    expect(md).toMatch(/record mode/i);
    expect(md).toMatch(/execute/i);
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];
    const entries = shortcutsEntries();
    for (const e of entries) {
      expect(e.id.startsWith("shortcuts.")).toBe(true);
      expect(e.source).toBe(SHORTCUTS_SOURCE_ID);
      expect(validKinds).toContain(e.kind);
      expect(e.describe.length).toBeGreaterThan(20);
      for (const v of e.grants) expect(validVerbs).toContain(v);
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
  });

  it("the module is registered in MODULES (append-only wiring)", () => {
    expect(MODULES.some((m) => m.id === SHORTCUTS_SOURCE_ID)).toBe(true);
    expect(shortcutsSourceModule.transport).toBe("ipc");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (2) LIST happy path — fake provider, headless
// ══════════════════════════════════════════════════════════════════════════════
describe("shortcuts.list: the read discovery path", () => {
  it("returns the shortcut names (+ folders) from the provider and audits a read", async () => {
    const { bridge, events } = fakeBridge();
    expect(bridge.route(SHORTCUTS_LIST_ID)).toBe("handled");

    const res = await bridge.invoke({ id: SHORTCUTS_LIST_ID, input: {} }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as { shortcuts: { name: string; folder?: string }[]; folders: string[] };
    expect(out.shortcuts.map((s) => s.name)).toEqual([
      "Good Morning",
      "Add to Grocery List",
      "Make QR Code",
    ]);
    expect(out.folders).toEqual(["Routines", "Home"]);

    const ev = events.find((e) => e.capabilityId === SHORTCUTS_LIST_ID)!;
    expect(ev.verbs).toEqual(["read"]);
    expect(ev.outcome).toBe("ok");
  });

  it("PLEXUS_FAKE_SHORTCUTS=1 selects the fake provider (headless tests/probes)", async () => {
    process.env.PLEXUS_FAKE_SHORTCUTS = "1";
    const provider = selectShortcutsProvider();
    expect(provider).toBeInstanceOf(FakeShortcutsProvider);
    expect((await provider.available()).ok).toBe(true);
    delete process.env.PLEXUS_FAKE_SHORTCUTS;
    expect(selectShortcutsProvider()).toBeInstanceOf(RealShortcutsProvider);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (3) RECORD-MODE (gate OFF, the default) — recorded, NOT executed
// ══════════════════════════════════════════════════════════════════════════════
describe("shortcuts.run record-mode (gate OFF): assembled + audited, never executed", () => {
  it("returns launched:false with the record-mode reason; the provider is NEVER called", async () => {
    const { bridge, events, provider } = fakeBridge();
    delete process.env.PLEXUS_SHORTCUTS_LAUNCH; // record-mode (the default)
    expect(shortcutsLaunchEnabled()).toBe(false);

    const res = await bridge.invoke(
      { id: SHORTCUTS_RUN_ID, input: { name: "Good Morning", input: "wake up" } },
      CTX,
    );

    expect(res.ok).toBe(true); // record-mode is a clean, honest no-op success
    const out = res.output as Record<string, unknown>;
    expect(out.launched).toBe(false);
    expect(out.ok).toBe(true);
    expect(out.output).toBe("");
    expect(out.exitCode).toBeNull();
    expect(out.reason).toBe(RECORD_MODE_REASON);
    expect(String(out.reason)).toContain("record mode");

    // NOTHING executed — the gate sits ABOVE the provider seam.
    expect(provider.runs).toHaveLength(0);

    // The audit carries the EXECUTE verb + the exact command that WOULD have run,
    // with the input text masked by the placeholder (never the raw text).
    const ev = events.find((e) => e.capabilityId === SHORTCUTS_RUN_ID)!;
    expect(ev.verbs).toEqual(["execute"]);
    expect(ev.outcome).toBe("ok");
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.realLaunch).toBe(false);
    expect(detail.launched).toBe(false);
    expect(detail.argv).toEqual([SHORTCUTS_BINARY, "run", "Good Morning", "-i", INPUT_PLACEHOLDER]);
    expect(JSON.stringify(detail)).not.toContain("wake up");
  });

  it("without input text the recorded argv has no -i flag", async () => {
    const { bridge, events } = fakeBridge();
    await bridge.invoke({ id: SHORTCUTS_RUN_ID, input: { name: "Make QR Code" } }, CTX);
    const detail = events.find((e) => e.capabilityId === SHORTCUTS_RUN_ID)!.detail as {
      argv: string[];
    };
    expect(detail.argv).toEqual([SHORTCUTS_BINARY, "run", "Make QR Code"]);
  });

  it("a missing name is rejected with schema_validation_failed (nothing runs, nothing recorded as run)", async () => {
    const { bridge, provider } = fakeBridge();
    const res = await bridge.invoke({ id: SHORTCUTS_RUN_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
    expect(provider.runs).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (4) GATE ON — the fake executes THROUGH the same gate the real CLI would
// ══════════════════════════════════════════════════════════════════════════════
describe("shortcuts.run with the gate ON (PLEXUS_SHORTCUTS_LAUNCH=1): executes the provider", () => {
  it("runs the fake shortcut and returns its output (launched:true)", async () => {
    const { bridge, events, provider } = fakeBridge();
    process.env.PLEXUS_SHORTCUTS_LAUNCH = "1";
    expect(shortcutsLaunchEnabled()).toBe(true);

    const res = await bridge.invoke(
      { id: SHORTCUTS_RUN_ID, input: { name: "Add to Grocery List", input: "oat milk" } },
      CTX,
    );

    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out.launched).toBe(true);
    expect(out.output).toBe("fake-ran: Add to Grocery List ← oat milk");
    expect(out.exitCode).toBe(0);
    expect(out.timedOut).toBe(false);

    // The provider really ran, once, with the clamped default timeout threaded.
    expect(provider.runs).toHaveLength(1);
    expect(provider.runs[0]).toEqual({
      name: "Add to Grocery List",
      input: "oat milk",
      timeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    });

    const ev = events.find((e) => e.capabilityId === SHORTCUTS_RUN_ID)!;
    expect(ev.verbs).toEqual(["execute"]);
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.realLaunch).toBe(true);
    expect(detail.launched).toBe(true);
  });

  it("an unknown shortcut name fails cleanly as transport_error (fake exit 1)", async () => {
    const { bridge } = fakeBridge();
    process.env.PLEXUS_SHORTCUTS_LAUNCH = "1";
    const res = await bridge.invoke({ id: SHORTCUTS_RUN_ID, input: { name: "No Such Thing" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    expect(res.error?.message).toContain("No Such Thing");
  });

  it("clamps an agent-supplied timeoutMs into [MIN, MAX]", async () => {
    const { bridge, provider } = fakeBridge();
    process.env.PLEXUS_SHORTCUTS_LAUNCH = "1";
    await bridge.invoke(
      { id: SHORTCUTS_RUN_ID, input: { name: "Make QR Code", timeoutMs: 10 } },
      CTX,
    );
    await bridge.invoke(
      { id: SHORTCUTS_RUN_ID, input: { name: "Make QR Code", timeoutMs: 99_999_999 } },
      CTX,
    );
    expect(provider.runs[0]!.timeoutMs).toBe(MIN_RUN_TIMEOUT_MS);
    expect(provider.runs[1]!.timeoutMs).toBe(MAX_RUN_TIMEOUT_MS);
    expect(clampRunTimeout(undefined)).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (5) TIMEOUT handling — killed at the deadline, reported honestly
// ══════════════════════════════════════════════════════════════════════════════
describe("shortcuts timeout: the run is killed at the deadline and reported", () => {
  it("defaultCliRunner SIGKILLs a hung process and reports timedOut:true", async () => {
    const started = Date.now();
    const res = await defaultCliRunner({ command: "/bin/sh", args: ["-c", "sleep 30"], timeoutMs: 150 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull(); // killed, not exited
    expect(Date.now() - started).toBeLessThan(5_000); // did not wait for the sleep
  });

  it("the provider maps a timed-out run to ok:false with a timeout reason", async () => {
    const runner: CliRunner = async (spec) => {
      expect(spec.timeoutMs).toBe(2_000); // the per-call timeout is threaded through
      return { stdout: "partial", stderr: "", exitCode: null, timedOut: true };
    };
    const provider = new RealShortcutsProvider(runner);
    const res = await provider.runShortcut({ name: "Slow One", timeoutMs: 2_000 });
    expect(res.ok).toBe(false);
    expect(res.launched).toBe(true);
    expect(res.timedOut).toBe(true);
    expect(res.reason).toMatch(/timed out after 2000ms/);
  });

  it("buildRunArgs is pure + deterministic (the exact CLI shape)", () => {
    expect(buildRunArgs("Good Morning")).toEqual(["run", "Good Morning"]);
    expect(buildRunArgs("Good Morning", "/tmp/in.txt")).toEqual([
      "run",
      "Good Morning",
      "-i",
      "/tmp/in.txt",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (6) MISSING BINARY (non-macOS) — degrade to source_unavailable, health unavailable
// ══════════════════════════════════════════════════════════════════════════════
describe("shortcuts on a machine without the `shortcuts` CLI: degrade, never crash", () => {
  /** A runner whose spawns fail like a missing binary does (ENOENT). */
  const enoentRunner: CliRunner = async () => {
    throw Object.assign(new Error("spawn shortcuts ENOENT"), { code: "ENOENT" });
  };

  it("gate ON + binary absent ⇒ ok:false, source_unavailable, launched:false", async () => {
    const { deps, events } = bridgeDeps();
    const bridge = new ShortcutsBridge(deps, "s1", shortcutsEntries(), new RealShortcutsProvider(enoentRunner));
    process.env.PLEXUS_SHORTCUTS_LAUNCH = "1";

    const res = await bridge.invoke({ id: SHORTCUTS_RUN_ID, input: { name: "Anything" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("source_unavailable");
    expect(res.error?.message).toContain("macOS");
    const ev = events.find((e) => e.capabilityId === SHORTCUTS_RUN_ID)!;
    expect(ev.outcome).toBe("error");
  });

  it("checkRequirements()/health() report 'unavailable' with a reason — never throw", async () => {
    const src = new ShortcutsSource({} as unknown as PlatformServices, {
      provider: new RealShortcutsProvider(enoentRunner),
    });
    const req = await src.checkRequirements();
    expect(req.ok).toBe(false);
    expect(req.reason).toContain("macOS");
    const health = await src.health();
    expect(health.status).toBe("unavailable");
    expect(health.status === "unavailable" && health.detail).toContain("macOS");
  });

  it("scan() ALWAYS returns the full ungated entry set (binary present or not)", async () => {
    const src = new ShortcutsSource({} as unknown as PlatformServices, {
      provider: new RealShortcutsProvider(enoentRunner),
    });
    const entries = await src.scan();
    expect(entries.map((e) => e.id)).toEqual([SHORTCUTS_LIST_ID, SHORTCUTS_RUN_ID, SHORTCUTS_HOW_TO_USE_ID]);
  });
});
