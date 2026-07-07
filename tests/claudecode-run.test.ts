/**
 * claudecode.run — the SANDBOXED Claude Code capability (GOAL §4 / AC5 / AC6).
 *
 * Proves the confinement-capability slice:
 *  (1) ENTRIES: `claudecode.run` is `grants:["execute"]` (⇒ PENDS for the owner) + a
 *      how-to skill; every entry well-formed against the frozen CapabilityEntry shape.
 *  (2) RECORD-MODE (gate OFF, default): no spawn happens; the launcher / bridge report
 *      the EXACT `sandbox-exec -f <profile> -D JAIL=.. -D HOMEDIR=.. -D CLAUDE_BIN_DIR=..
 *      -D PLUGIN_DIR=.. <claude> -p <prompt> --dangerously-skip-permissions
 *      --permission-mode bypassPermissions` argv it WOULD run, plus `sandboxed:true` +
 *      the jail + confinement (the audit/wiring proof).
 *  (3) CWD-CONFINEMENT: a cwd that escapes the authorized dir (absolute-outside,
 *      `..` traversal) is REJECTED with VaultConfinementError; the bridge surfaces it
 *      as a clean transport_error (no spawn).
 *  (4) BRIDGE record-mode end-to-end: `claudecode.run` returns sandboxed metadata + the
 *      invoke is audited with `sandboxed:true` + the jail + mechanism (AC8).
 *  (5) HERMETIC LIVE SANDBOX NEGATIVE: with the gate ON, a FAKE `claude` shim (placed
 *      inside the granted CLAUDE_BIN_DIR) is spawned UNDER the REAL bundled
 *      `cc-confine.sb` profile + REAL `sandbox-exec`; it writes INSIDE the jail (works)
 *      and tries to write OUTSIDE (kernel-DENIED). This proves the profile genuinely
 *      confines — no real `claude`, no network, no LLM. Skipped (with a clear log) if
 *      `/usr/bin/sandbox-exec` is unavailable.
 */

import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSandboxedArgv,
  BYPASS_FLAGS,
  resolveConfineProfile,
  SANDBOX_EXEC,
  SandboxedClaudeLauncher,
} from "@plexus/runtime/sources/claudecode/launcher.ts";
import { defaultCapture, type CaptureResult } from "@plexus/runtime/sources/claudecode/launch.ts";
import { VaultConfinementError } from "@plexus/runtime/sources/obsidian/vault-reader.ts";
import { ClaudecodeBridge } from "@plexus/runtime/sources/claudecode/bridge.ts";
import {
  claudecodeEntries,
  CLAUDECODE_RUN_ID,
  HOW_TO_USE_ID,
} from "@plexus/runtime/sources/claudecode/entries.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityEntry,
  EntryKind,
  GrantVerb,
  InvokeContext,
} from "@plexus/protocol";

// ── temp-dir bookkeeping ──────────────────────────────────────────────────────
const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
// Sandbox PLEXUS_HOME (whole file) so the launch gate reads an EMPTY source-settings.json
// and falls to the env flag — the invariant these tests assert. Otherwise it would read the
// developer's real ~/.plexus console toggle. Kept out of `dirs` so afterEach never deletes it.
const PRIOR_PLEXUS_HOME = process.env.PLEXUS_HOME;
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "plexus-cc-home-"));
process.env.PLEXUS_HOME = SANDBOX_HOME;
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  // never leak the gate env into the rest of the suite.
  delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
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
function bridgeDeps(entries = claudecodeEntries()): { deps: BridgeDeps; events: AuditEventInput[] } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const events: AuditEventInput[] = [];
  const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
    events.push(e);
    return { ...e, id: `a-${events.length}`, at: new Date().toISOString() } as unknown as AuditEvent;
  };
  const deps: BridgeDeps = {
    audit,
    getTransport: () => {
      throw new Error("claudecode.run is served by an in-process handler; no transport needed");
    },
    getEntry: (id) => byId.get(id),
    invokeById: async () => {
      throw new Error("claudecode.run does not re-enter the pipeline");
    },
  };
  return { deps, events };
}

// ══════════════════════════════════════════════════════════════════════════════
// (1) ENTRIES
// ══════════════════════════════════════════════════════════════════════════════
describe("claudecode entries: execute capability + how-to skill", () => {
  it("claudecode.run is grants:['execute'] (⇒ PENDS for the owner)", () => {
    const byId = new Map(claudecodeEntries().map((e) => [e.id, e]));
    const run = byId.get(CLAUDECODE_RUN_ID)!;
    expect(run.grants).toEqual(["execute"]);
    expect(run.kind).toBe("capability");
    expect(run.transport).toBe("ipc");
    expect(run.source).toBe("claudecode");
    // The input schema is `{ prompt: string }` (required).
    const input = run.io?.input;
    expect(typeof input).toBe("object");
    expect((input as { required?: string[] }).required).toEqual(["prompt"]);
  });

  it("ships a how-to-use SKILL (read-as-context, no grants, has a body)", () => {
    const skill = claudecodeEntries().find((e) => e.id === HOW_TO_USE_ID)!;
    expect(skill.kind).toBe("skill");
    expect(skill.transport).toBe("skill");
    expect(skill.grants).toEqual([]);
    expect(skill.body?.format).toBe("markdown");
    expect((skill.body?.markdown ?? "").length).toBeGreaterThan(50);
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];
    const entries = claudecodeEntries();
    for (const e of entries) {
      expect(e.id.startsWith("claudecode.")).toBe(true);
      expect(e.source).toBe("claudecode");
      expect(validKinds).toContain(e.kind);
      expect(e.describe.length).toBeGreaterThan(20);
      for (const v of e.grants) expect(validVerbs).toContain(v);
    }
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (2) RECORD-MODE — the sandbox-exec wrapper argv is built correctly (no spawn)
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher record-mode (gate OFF): builds the sandbox-exec argv, NO spawn", () => {
  it("predicts the FULL `sandbox-exec -f <profile> -D ... claude -p ... --bypass` argv", async () => {
    const jail = tmp("plexus-jail-");
    let spawned = false;
    const launcher = new SandboxedClaudeLauncher({
      authorizedDir: jail,
      resolveBinary: async (n) => (n === "claude" ? "/usr/local/bin/claude" : undefined),
      rawCapture: async (): Promise<CaptureResult> => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    // Gate OFF (default) ⇒ record-mode.
    delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
    const res = await launcher.run({ prompt: "build it" });

    expect(spawned).toBe(false);
    expect(res.launched).toBe(false);
    expect(res.sandboxed).toBe(true);
    expect(res.ok).toBe(true); // record-mode is a clean no-op success

    // The wrapper: sandbox-exec -f <profile> -D JAIL=.. -D HOMEDIR=.. -D CLAUDE_BIN_DIR=.. -D PLUGIN_DIR=.. <claude> ...
    const argv = res.argv;
    expect(argv[0]).toBe(SANDBOX_EXEC);
    expect(argv).toContain("-f");
    expect(argv).toContain(resolveConfineProfile());
    expect(argv).toContain(`JAIL=${res.jail}`);
    expect(argv).toContain(`HOMEDIR=${process.env.HOME}`);
    expect(argv.some((a) => a.startsWith("CLAUDE_BIN_DIR="))).toBe(true);
    expect(argv).toContain("/usr/local/bin/claude");
    // CC's own headless invocation + the proven bypass flags.
    expect(argv).toContain("-p");
    expect(argv).toContain("build it");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("bypassPermissions");
    // confinement metadata for audit (AC5/AC8).
    expect(res.confinement.mechanism).toBe("sandbox-exec");
    expect(res.confinement.jail).toBe(res.jail);
  });

  it("buildSandboxedArgv is pure + deterministic (the wrapper shape)", () => {
    const { command, args } = buildSandboxedArgv({
      sandboxExec: "/usr/bin/sandbox-exec",
      profilePath: "/p/cc-confine.sb",
      jail: "/j",
      homedir: "/h",
      claudeBinDir: "/b",
      pluginDir: "/j",
      claudeBin: "/abs/claude",
      ccArgs: ["-p", "x", ...BYPASS_FLAGS],
    });
    expect(command).toBe("/usr/bin/sandbox-exec");
    expect(args).toEqual([
      "-f",
      "/p/cc-confine.sb",
      "-D",
      "JAIL=/j",
      "-D",
      "HOMEDIR=/h",
      "-D",
      "CLAUDE_BIN_DIR=/b",
      "-D",
      "PLUGIN_DIR=/j",
      "/abs/claude",
      "-p",
      "x",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (3) CWD-CONFINEMENT — out-of-dir / traversal rejected
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher cwd-confinement: rejects escapes BEFORE any spawn", () => {
  function launcherFor(jail: string): SandboxedClaudeLauncher {
    return new SandboxedClaudeLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/usr/local/bin/claude",
      rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
  }

  it("a sub-path of the authorized dir is allowed (confines to it)", () => {
    const jail = tmp("plexus-jail-");
    mkdirSync(join(jail, "sub"), { recursive: true });
    const confined = launcherFor(jail).confineCwd("sub");
    expect(confined.endsWith("/sub")).toBe(true);
  });

  it("a `..` traversal cwd is REJECTED with VaultConfinementError", () => {
    const jail = tmp("plexus-jail-");
    expect(() => launcherFor(jail).confineCwd("../escape")).toThrow(VaultConfinementError);
  });

  it("an absolute cwd OUTSIDE the authorized dir is REJECTED", () => {
    const jail = tmp("plexus-jail-");
    expect(() => launcherFor(jail).confineCwd("/etc")).toThrow(VaultConfinementError);
  });

  it("run() with an escaping cwd throws before spawning (record-mode OR live)", async () => {
    const jail = tmp("plexus-jail-");
    let spawned = false;
    const launcher = new SandboxedClaudeLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/usr/local/bin/claude",
      rawCapture: async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    await expect(launcher.run({ prompt: "x", cwd: "../../etc" })).rejects.toBeInstanceOf(
      VaultConfinementError,
    );
    expect(spawned).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (4) BRIDGE record-mode end-to-end + audit (AC8)
// ══════════════════════════════════════════════════════════════════════════════
describe("claudecode bridge: record-mode run + sandboxed audit (AC5/AC8)", () => {
  function fakeLauncher(jail: string): SandboxedClaudeLauncher {
    return new SandboxedClaudeLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/usr/local/bin/claude",
      rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
  }

  it("claudecode.run returns sandboxed metadata + jail; the invoke is audited as sandboxed", async () => {
    const jail = tmp("plexus-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), fakeLauncher(jail));

    expect(bridge.route(CLAUDECODE_RUN_ID)).toBe("handled");
    delete process.env.PLEXUS_CC_HEADLESS_LAUNCH; // record-mode
    const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: { prompt: "scaffold the app" } }, CTX);

    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out.sandboxed).toBe(true);
    expect(out.launched).toBe(false);
    // WIRE/AUDIT SPLIT: no machine fingerprint on the agent-facing result — jail path,
    // argv, and confinement diagnostics belong to the owner's audit record.
    expect(out.jail).toBeUndefined();
    expect(out.argv).toBeUndefined();
    expect(out.confinement).toBeUndefined();

    // Audit carries the EXECUTE verb + the sandbox posture + the full owner-facing
    // diagnostics, prompt masked (redaction-safe; AC8).
    const ev = events.find((e) => e.capabilityId === CLAUDECODE_RUN_ID)!;
    expect(ev.verbs).toEqual(["execute"]);
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.sandboxed).toBe(true);
    expect(detail.mechanism).toBe("sandbox-exec");
    expect(detail.op).toBe("run");
    expect(typeof detail.jail).toBe("string");
    expect(detail.argv as string[]).toContain(SANDBOX_EXEC);
    // never leaks the prompt text.
    expect(JSON.stringify(ev.detail)).not.toContain("scaffold the app");
  });

  it("a missing prompt is rejected with schema_validation_failed (no spawn)", async () => {
    const jail = tmp("plexus-jail-");
    const { deps } = bridgeDeps();
    const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), fakeLauncher(jail));
    const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });

  it("an escaping cwd surfaces as a clean transport_error (no crash)", async () => {
    const jail = tmp("plexus-jail-");
    const { deps } = bridgeDeps();
    const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), fakeLauncher(jail));
    const res = await bridge.invoke(
      { id: CLAUDECODE_RUN_ID, input: { prompt: "x", cwd: "../../etc" } },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    expect(res.error?.message).toContain("escapes the authorized dir");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (5) HERMETIC LIVE SANDBOX NEGATIVE — the bundled profile REALLY confines
// ══════════════════════════════════════════════════════════════════════════════
//
// With the gate ON, drive the REAL launcher flow (defaultCapture → real spawn) against
// a FAKE `claude` shim placed inside the granted CLAUDE_BIN_DIR. The shim writes a file
// INSIDE the jail (must succeed) and tries to write a file OUTSIDE the jail (must be
// kernel-DENIED under the real `cc-confine.sb`). No real `claude`, no network, no LLM.
const HAS_SANDBOX = existsSync(SANDBOX_EXEC);

describe("HERMETIC LIVE SANDBOX — the bundled cc-confine.sb profile confines a fake claude", () => {
  it.skipIf(!HAS_SANDBOX)(
    "fake claude writes INSIDE the jail (ok) but is DENIED writing OUTSIDE it",
    async () => {
      const root = tmp("plexus-sbx-");
      const jail = join(root, "jail");
      const binDir = join(root, "bin");
      mkdirSync(join(jail, ".tmp"), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const insidePath = join(jail, "inside.txt");
      const outsidePath = join(root, "outside.txt"); // sibling of the jail — must be unreachable

      // The fake `claude` shim lives in CLAUDE_BIN_DIR (a granted READ path). It ignores
      // its args and probes the jail boundary directly.
      const shim = join(binDir, "claude");
      writeFileSync(
        shim,
        [
          "#!/bin/bash",
          `echo in > "${insidePath}" && echo INSIDE_OK || echo INSIDE_FAIL`,
          `( echo out > "${outsidePath}" ) 2>/dev/null && echo OUTSIDE_WROTE || echo OUTSIDE_DENIED`,
          "exit 0",
        ].join("\n") + "\n",
      );
      chmodSync(shim, 0o755);

      const launcher = new SandboxedClaudeLauncher({
        authorizedDir: jail,
        resolveBinary: async (n) => (n === "claude" ? shim : undefined),
        // REAL spawn under REAL sandbox-exec with the REAL bundled profile.
        rawCapture: defaultCapture,
      });

      process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1"; // gate ON ⇒ real spawn
      const res = await launcher.run({ prompt: "probe the jail" });

      expect(res.launched).toBe(true);
      expect(res.sandboxed).toBe(true);
      // The shim ran under the sandbox and reported the boundary outcome.
      expect(res.output).toContain("INSIDE_OK");
      expect(res.output).toContain("OUTSIDE_DENIED");
      expect(res.output).not.toContain("OUTSIDE_WROTE");
      // THE PROOF (filesystem ground truth): inside written, outside never created.
      expect(existsSync(insidePath)).toBe(true);
      expect(existsSync(outsidePath)).toBe(false);
      // The spawned argv really invoked sandbox-exec with the bundled profile.
      expect(res.argv[0]).toBe(SANDBOX_EXEC);
      expect(res.argv).toContain(resolveConfineProfile());
    },
  );

  if (!HAS_SANDBOX) {
    it("documents that the live sandbox proof is skipped without /usr/bin/sandbox-exec", () => {
      // SANDBOX-FINDINGS.md (the spike) holds the recorded live proof on a full macOS box.
      expect(HAS_SANDBOX).toBe(false);
    });
  }
});
