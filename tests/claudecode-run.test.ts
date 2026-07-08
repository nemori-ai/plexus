/**
 * claudecode.run — the SANDBOXED Claude Code capability (GOAL §4 / AC5 / AC6).
 *
 * Proves the confinement-capability slice (NATIVE model — Plexus no longer wraps the
 * agent in its own seatbelt; the agent's OWN sandbox write-confines it):
 *  (1) ENTRIES: `claudecode.run` is `grants:["execute"]` (⇒ PENDS for the owner) + a
 *      how-to skill; every entry well-formed against the frozen CapabilityEntry shape.
 *  (2) RECORD-MODE (gate OFF, default): no spawn happens; the launcher / bridge report
 *      the EXACT native `<claude> -p <prompt> --dangerously-skip-permissions
 *      --permission-mode bypassPermissions` argv it WOULD run (NO sandbox-exec wrapper),
 *      plus `sandboxed:true` + the jail + confinement (mechanism `claude-native`).
 *  (3) CWD-CONFINEMENT: a cwd that escapes the authorized dir (absolute-outside,
 *      `..` traversal) is REJECTED with VaultConfinementError; the bridge surfaces it
 *      as a clean transport_error (no spawn).
 *  (4) BRIDGE record-mode end-to-end: `claudecode.run` returns sandboxed metadata + the
 *      invoke is audited with `sandboxed:true` + the jail + mechanism (AC8).
 *  (5) REAL NATIVE SPAWN (gate ON): a FAKE `claude` shim is spawned DIRECTLY (no wrapper)
 *      with cwd = the authorized dir; it echoes its cwd + argv, proving the native launch
 *      wiring. Write-confinement is the agent's OWN sandbox — no Plexus seatbelt.
 */

import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildNativeArgv,
  BYPASS_FLAGS,
  CLAUDE_NATIVE_MECHANISM,
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
// (2) RECORD-MODE — the NATIVE argv is built correctly (no wrapper, no spawn)
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher record-mode (gate OFF): builds the NATIVE claude argv, NO spawn", () => {
  it("predicts the FULL native `<claude> -p <prompt> --dangerously-skip-permissions …` argv", async () => {
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

    // NO wrapper: the agent binary is spawned DIRECTLY with its own args. CC's native
    // sandbox (kept by --dangerously-skip-permissions) write-confines it to the cwd.
    const argv = res.argv;
    expect(argv).toEqual([
      "/usr/local/bin/claude",
      "-p",
      "build it",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
    ]);
    // No sandbox-exec / seatbelt anywhere in the launch argv.
    expect(argv.some((a) => a.includes("sandbox-exec"))).toBe(false);
    expect(argv.some((a) => a.endsWith(".sb"))).toBe(false);
    // confinement metadata for audit — honestly the tool's OWN native sandbox.
    expect(res.confinement.mechanism).toBe(CLAUDE_NATIVE_MECHANISM);
    expect(res.confinement.mechanism).toBe("claude-native");
    expect(res.confinement.jail).toBe(res.jail);
  });

  it("buildNativeArgv is pure + deterministic (the native command shape)", () => {
    const { command, args } = buildNativeArgv({ claudeBin: "/abs/claude", prompt: "x" });
    expect(command).toBe("/abs/claude");
    expect(args).toEqual([
      "-p",
      "x",
      ...BYPASS_FLAGS,
    ]);
    expect(args).toEqual([
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
    expect(detail.mechanism).toBe("claude-native");
    expect(detail.op).toBe("run");
    expect(typeof detail.jail).toBe("string");
    // The audited argv is the NATIVE claude command (no sandbox-exec wrapper).
    expect(detail.argv as string[]).toContain("--dangerously-skip-permissions");
    expect((detail.argv as string[]).some((a) => a.includes("sandbox-exec"))).toBe(false);
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
    // SANITIZED, path-free message — never echoes the requested cwd or a host path.
    expect(res.error?.message).toBe(
      "the requested working directory is outside the authorized workspace",
    );
    expect(res.error?.message).not.toContain("etc");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (4b) SELF-HEAL a missing jail + NEVER leak the host path on failure
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher self-heals a missing jail; the bridge never leaks the host path", () => {
  it("a MISSING configured authorized dir no longer ENOENTs — mkdir creates it before realpath", async () => {
    const parent = tmp("plexus-parent-");
    const jail = join(parent, "not-created-yet"); // does NOT exist
    expect(existsSync(jail)).toBe(false);
    const launcher = new SandboxedClaudeLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/usr/local/bin/claude",
      rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    delete process.env.PLEXUS_CC_HEADLESS_LAUNCH; // record-mode
    // Before the fix this threw ENOENT on the FIRST line of run() (realpathSync).
    const res = await launcher.run({ prompt: "x" });
    expect(res.sandboxed).toBe(true);
    expect(existsSync(jail)).toBe(true); // the best-effort mkdir created it
  });

  it("a REAL fs failure (unwritable parent) surfaces a SANITIZED, path-free wire error; the host path stays audit-only", async () => {
    const parent = tmp("plexus-ro-parent-");
    const jail = join(parent, "sub", "jail"); // two levels under a read-only parent
    // Make the parent read+execute but NOT writable ⇒ mkdir(jail) fails, realpath ENOENTs.
    chmodSync(parent, 0o500);
    try {
      const launcher = new SandboxedClaudeLauncher({
        authorizedDir: jail,
        resolveBinary: async () => "/usr/local/bin/claude",
        rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      });
      const { deps, events } = bridgeDeps();
      const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), launcher);
      delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
      const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: { prompt: "x" } }, CTX);

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("transport_error");
      const msg = res.error?.message ?? "";
      // THE LEAK REGRESSION: the agent-facing message carries NO host path + NO fs status.
      expect(msg).toBe(
        "the coding workspace is not available — ask the owner to configure its authorized directory in Plexus",
      );
      expect(msg).not.toContain(jail);
      expect(msg).not.toContain(parent);
      expect(msg).not.toContain("ENOENT");
      expect(msg).not.toContain("EACCES");
      // No absolute host path anywhere in the wire message (no `/a/b`-shaped substring).
      expect(msg).not.toMatch(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/);
      // The REAL, path-bearing detail is kept in the OWNER's audit record only.
      const ev = events.find((e) => e.capabilityId === CLAUDECODE_RUN_ID)!;
      const detail = ev.detail as Record<string, unknown>;
      expect(String(detail.launchError)).toContain(jail);
    } finally {
      chmodSync(parent, 0o700); // restore so cleanup can remove it
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (5) REAL NATIVE SPAWN (gate ON) — the launcher spawns the resolved binary DIRECTLY,
//     with cwd = the authorized dir, NO sandbox-exec wrapper.
// ══════════════════════════════════════════════════════════════════════════════
//
// Plexus NO LONGER wraps the agent in its own seatbelt (that double-jailed the agent's
// OWN native sandbox). So the launch-path proof is now: with the gate ON, drive the REAL
// flow (defaultCapture → real spawn) against a FAKE `claude` shim that echoes its cwd +
// argv. The write-confinement itself is the AGENT's native sandbox (verified empirically,
// not by a Plexus wrapper), so the shim is NOT confined here — we assert the wiring: the
// native argv, cwd = the jail, launched:true. No real `claude`, no network, no LLM.
describe("REAL NATIVE SPAWN — the launcher runs the resolved binary directly (no wrapper)", () => {
  it("gate ON ⇒ spawns `<claude> -p … --bypass` DIRECTLY with cwd = the authorized dir", async () => {
    const root = tmp("plexus-native-");
    const jail = join(root, "jail");
    const binDir = join(root, "bin");
    mkdirSync(jail, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    // The fake `claude` shim echoes its cwd + argv so the test can prove the wiring.
    const shim = join(binDir, "claude");
    writeFileSync(
      shim,
      ["#!/bin/bash", `echo "CWD=$(pwd)"`, `echo "ARGV=$*"`, "exit 0"].join("\n") + "\n",
    );
    chmodSync(shim, 0o755);

    const launcher = new SandboxedClaudeLauncher({
      authorizedDir: jail,
      resolveBinary: async (n) => (n === "claude" ? shim : undefined),
      // REAL spawn — no wrapper. cwd is the authorized dir.
      rawCapture: defaultCapture,
    });

    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1"; // gate ON ⇒ real spawn
    const res = await launcher.run({ prompt: "do the work" });

    expect(res.launched).toBe(true);
    expect(res.sandboxed).toBe(true);
    expect(res.ok).toBe(true);
    // The shim ran with cwd = the authorized dir (realpath-compared for macOS /var symlink).
    expect(res.output).toContain(`CWD=${realpathSync(jail)}`);
    // …and received the native bypass argv verbatim (no sandbox-exec, no profile).
    expect(res.output).toContain("ARGV=-p do the work --dangerously-skip-permissions");
    // The spawned argv is the native command — the shim itself, then its args.
    expect(res.argv[0]).toBe(shim);
    expect(res.argv.some((a) => a.includes("sandbox-exec"))).toBe(false);
    expect(res.argv.some((a) => a.endsWith(".sb"))).toBe(false);
  });
});
