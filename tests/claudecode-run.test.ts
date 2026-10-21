/**
 * claudecode.run — the kernel-jailed Claude Code capability (GOAL §4 / AC5 / AC6).
 *
 * Proves the launch contract hermetically (no real `claude`, no real kernel; the
 * real-kernel proof is `tests/exec-jail-kernel.test.ts`):
 *  (1) ENTRIES: `claudecode.run` is `grants:["execute"]` (⇒ PENDS for the owner) + a
 *      how-to skill; the output schema states `isolation`.
 *  (2) RECORD-MODE (gate OFF, default): no spawn; the launcher reports the FULL wrapped
 *      argv it would run (sandbox-exec + profile + params, then claude with its own
 *      sandbox turned off) and an isolation report that says jail / not enforced.
 *  (2b) HOST policy: the owner's choice yields the unwrapped native argv and a host report.
 *  (3) CWD-CONFINEMENT: a cwd that escapes the authorized dir is REJECTED before any spawn.
 *  (4) BRIDGE: the wire carries `isolation` and no host path; the audit carries the policy,
 *      the report and the owner-only diagnostics with the prompt masked.
 *  (5) REAL LAUNCH wiring (gate ON, fake spawn): the canary runs first under the identical
 *      wrap, a failing canary blocks the launch, an unavailable backend blocks the launch,
 *      a passing canary launches with cwd/env inside the root and `enforced: true`.
 */

import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeLauncher, CC_INNER_SANDBOX_OFF } from "@plexus/runtime/sources/claudecode/launcher.ts";
import type { CaptureResult, CaptureSpawn } from "@plexus/runtime/sources/exec-capture.ts";
import { DarwinSandboxBackend } from "@plexus/runtime/platform/sandbox-backend.ts";
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
// and falls to the env flag. Kept out of `dirs` so afterEach never deletes it.
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
  delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
  delete process.env.PLEXUS_CC_EXEC_POLICY;
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
const CLAUDE = "/usr/local/bin/claude";
const CANARY_PASS: CaptureResult = { stdout: "IN=1\nW=0\nR=0\n", stderr: "", exitCode: 0 };

type Spawned = Parameters<CaptureSpawn>[0];
const isCanary = (s: Spawned) => s.args.includes("/bin/sh");

/** A fake spawn: answers the canary as instructed, the tool with `tool`, and logs both. */
function fakeCapture(opts: { canary?: CaptureResult; tool?: CaptureResult; log?: Spawned[] } = {}): CaptureSpawn {
  return async (spec) => {
    opts.log?.push(spec);
    if (isCanary(spec)) return opts.canary ?? CANARY_PASS;
    return opts.tool ?? { stdout: "", stderr: "", exitCode: 0 };
  };
}

/** The real darwin wrap shape, with sandbox-exec's presence pinned (hermetic on any runner). */
const JAIL_BACKEND = new DarwinSandboxBackend({ exists: () => true });

function launcherFor(
  jail: string,
  opts: { capture?: CaptureSpawn; policy?: "jail" | "host"; sandbox?: DarwinSandboxBackend; claude?: string | undefined } = {},
): ClaudeCodeLauncher {
  return new ClaudeCodeLauncher({
    authorizedDir: jail,
    resolveBinary: async (n) => (n === "claude" ? ("claude" in opts ? opts.claude : CLAUDE) : undefined),
    rawCapture: opts.capture ?? fakeCapture(),
    sandbox: opts.sandbox ?? JAIL_BACKEND,
    homedir: "/home/owner",
    toolHome: "/home/owner/.claude",
    ...(opts.policy ? { policy: () => opts.policy! } : {}),
  });
}

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
  it("claudecode.run is grants:['execute'] (⇒ PENDS for the owner) and states `isolation` in its output", () => {
    const byId = new Map(claudecodeEntries().map((e) => [e.id, e]));
    const run = byId.get(CLAUDECODE_RUN_ID)!;
    expect(run.grants).toEqual(["execute"]);
    expect(run.kind).toBe("capability");
    expect(run.transport).toBe("ipc");
    expect(run.source).toBe("claudecode");
    const input = run.io?.input;
    expect(typeof input).toBe("object");
    expect((input as { required?: string[] }).required).toEqual(["prompt"]);
    const output = run.io?.output as { required?: string[]; properties?: Record<string, unknown> };
    expect(output.required).toEqual(["ok", "isolation"]);
    expect(output.properties).toHaveProperty("isolation");
    expect(output.properties).not.toHaveProperty("sandboxed");
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
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (2) RECORD-MODE — the WRAPPED argv is assembled, nothing runs
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher record-mode (gate OFF): assembles the jailed argv, NO spawn, NO canary", () => {
  it("predicts `sandbox-exec -f cc-confine.sb -D JAIL=<root> … claude -p … --settings {sandbox off}`", async () => {
    const jail = tmp("plexus-jail-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log }) });
    delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
    const res = await launcher.run({ prompt: "build it" });

    expect(log).toEqual([]);
    expect(res.launched).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.isolation).toEqual({
      policy: "jail",
      mechanism: "sandbox-exec",
      scope: { files: "authorized-dir", temp: "authorized-dir", network: "open", toolState: "own-config-read-only" },
      enforced: false,
    });

    const root = realpathSync(jail);
    const argv = res.argv;
    expect(argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(argv[1]).toBe("-f");
    expect(argv[2]!.endsWith("/claudecode/sandbox/cc-confine.sb")).toBe(true);
    expect(argv).toContain(`JAIL=${root}`);
    expect(argv).toContain("HOMEDIR=/home/owner");
    expect(argv).toContain("TOOL_HOME=/home/owner/.claude");
    // The tool's bin dir is a read-only grant; nothing else under /usr/local is named.
    expect(argv).toContain("TOOL_BIN_DIR=/usr/local/bin");
    // The inner command follows the wrapper: claude, prompt, bypass flags, its own sandbox OFF.
    const inner = argv.slice(argv.indexOf(CLAUDE));
    expect(inner).toEqual([
      CLAUDE,
      "-p",
      "build it",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      ...CC_INNER_SANDBOX_OFF,
    ]);
    expect(CC_INNER_SANDBOX_OFF[1]).toBe('{"sandbox":{"enabled":false}}');
    // Owner-only diagnostics name the root AND the per-call cwd.
    expect(res.confinement.policy).toBe("jail");
    expect(res.confinement.root).toBe(root);
    expect(res.confinement.jail).toBe(root);
    expect(res.confinement.profile).toBe(argv[2]);
    expect(res.confinement.canary).toBeUndefined();
    expect(res.sessionId).toBeUndefined();
    expect(res.argv).not.toContain("--session-id");
  });

  it("the kernel JAIL param is the authorized ROOT even when the call's cwd is a sub-dir", async () => {
    const jail = tmp("plexus-jail-");
    mkdirSync(join(jail, "sub"));
    const res = await launcherFor(jail).run({ prompt: "x", cwd: "sub" });
    const root = realpathSync(jail);
    expect(res.argv).toContain(`JAIL=${root}`);
    expect(res.jail).toBe(join(root, "sub"));
    expect(res.confinement.jail).toBe(join(root, "sub"));
  });

  it("HOST policy (owner-chosen): the native argv with no wrap and no sandbox override, reported as host", async () => {
    const jail = tmp("plexus-jail-");
    const res = await launcherFor(jail, { policy: "host" }).run({ prompt: "build it" });
    expect(res.argv).toEqual([
      CLAUDE,
      "-p",
      "build it",
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(res.isolation).toEqual({
      policy: "host",
      mechanism: "none",
      scope: { files: "host-user", temp: "host-user", network: "open", toolState: "host-user" },
      enforced: false,
    });
    expect(res.confinement.policy).toBe("host");
    expect(res.confinement.profile).toBeUndefined();
  });

  it("the policy comes from the owner's setting (env fallback), read per call", async () => {
    const jail = tmp("plexus-jail-");
    const launcher = new ClaudeCodeLauncher({
      authorizedDir: jail,
      resolveBinary: async () => CLAUDE,
      rawCapture: fakeCapture(),
      sandbox: JAIL_BACKEND,
    });
    delete process.env.PLEXUS_CC_EXEC_POLICY;
    expect((await launcher.run({ prompt: "x" })).isolation.policy).toBe("jail");
    process.env.PLEXUS_CC_EXEC_POLICY = "host";
    expect((await launcher.run({ prompt: "x" })).isolation.policy).toBe("host");
    delete process.env.PLEXUS_CC_EXEC_POLICY;
    expect((await launcher.run({ prompt: "x" })).isolation.policy).toBe("jail");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (3) CWD-CONFINEMENT — out-of-dir / traversal rejected
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher cwd-confinement: rejects escapes BEFORE any spawn", () => {
  it("a sub-path of the authorized dir is allowed (confines to it)", () => {
    const jail = tmp("plexus-jail-");
    mkdirSync(join(jail, "sub"), { recursive: true });
    expect(launcherFor(jail).confineCwd("sub").endsWith("/sub")).toBe(true);
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
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log }) });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    await expect(launcher.run({ prompt: "x", cwd: "../../etc" })).rejects.toBeInstanceOf(VaultConfinementError);
    expect(log).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (4) BRIDGE record-mode end-to-end + audit (AC8)
// ══════════════════════════════════════════════════════════════════════════════
describe("claudecode bridge: the wire carries the isolation report, the audit carries the policy + diagnostics", () => {
  it("claudecode.run returns `isolation` and no host path; the invoke is audited with the policy", async () => {
    const jail = tmp("plexus-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), launcherFor(jail));

    expect(bridge.route(CLAUDECODE_RUN_ID)).toBe("handled");
    delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
    const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: { prompt: "scaffold the app" } }, CTX);

    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out.isolation).toMatchObject({ policy: "jail", mechanism: "sandbox-exec", enforced: false });
    expect(out.launched).toBe(false);
    expect(out.sandboxed).toBeUndefined();
    // WIRE/AUDIT SPLIT: nothing that names the host rides to the agent.
    expect(out.jail).toBeUndefined();
    expect(out.argv).toBeUndefined();
    expect(out.confinement).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(realpathSync(jail));

    const ev = events.find((e) => e.capabilityId === CLAUDECODE_RUN_ID)!;
    expect(ev.verbs).toEqual(["execute"]);
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.policy).toBe("jail");
    expect(detail.isolation).toMatchObject({ policy: "jail", enforced: false });
    expect(detail.mechanism).toBe("sandbox-exec");
    expect(detail.op).toBe("run");
    expect(typeof detail.jail).toBe("string");
    expect((detail.confinement as { profile?: string }).profile).toMatch(/cc-confine\.sb$/);
    const argv = detail.argv as string[];
    expect(argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).toContain("«prompt»");
    expect(JSON.stringify(ev.detail)).not.toContain("scaffold the app");
    expect((ev.input as { prompt?: string }).prompt).toBe("scaffold the app");
    expect(ev.output).toBeDefined();
  });

  it("a HOST run is audited as host, so the owner can see which runs went unconfined", async () => {
    const jail = tmp("plexus-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), launcherFor(jail, { policy: "host" }));
    const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: { prompt: "x" } }, CTX);
    expect((res.output as { isolation: { policy: string } }).isolation.policy).toBe("host");
    const detail = events.find((e) => e.capabilityId === CLAUDECODE_RUN_ID)!.detail as Record<string, unknown>;
    expect(detail.policy).toBe("host");
    expect((detail.argv as string[])[0]).toBe(CLAUDE);
  });

  it("a missing prompt is rejected with schema_validation_failed (no spawn)", async () => {
    const jail = tmp("plexus-jail-");
    const { deps } = bridgeDeps();
    const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), launcherFor(jail));
    const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });

  it("an escaping cwd surfaces as a clean transport_error (no crash)", async () => {
    const jail = tmp("plexus-jail-");
    const { deps } = bridgeDeps();
    const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), launcherFor(jail));
    const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: { prompt: "x", cwd: "../../etc" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    expect(res.error?.message).toBe("the requested working directory is outside the authorized workspace");
    expect(res.error?.message).not.toContain("etc");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (4b) SELF-HEAL a missing jail + NEVER leak the host path on failure
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher self-heals a missing jail; the bridge never leaks the host path", () => {
  it("a MISSING configured authorized dir no longer ENOENTs — mkdir creates it before realpath", async () => {
    const parent = tmp("plexus-parent-");
    const jail = join(parent, "not-created-yet");
    expect(existsSync(jail)).toBe(false);
    delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
    const res = await launcherFor(jail).run({ prompt: "x" });
    expect(res.isolation.policy).toBe("jail");
    expect(existsSync(jail)).toBe(true);
  });

  it("a REAL fs failure (unwritable parent) surfaces a SANITIZED, path-free wire error; the host path stays audit-only", async () => {
    const parent = tmp("plexus-ro-parent-");
    const jail = join(parent, "sub", "jail");
    chmodSync(parent, 0o500);
    try {
      const { deps, events } = bridgeDeps();
      const bridge = new ClaudecodeBridge(deps, "s1", claudecodeEntries(), launcherFor(jail));
      delete process.env.PLEXUS_CC_HEADLESS_LAUNCH;
      const res = await bridge.invoke({ id: CLAUDECODE_RUN_ID, input: { prompt: "x" } }, CTX);

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("transport_error");
      const msg = res.error?.message ?? "";
      expect(msg).toBe(
        "the coding workspace is not available — ask the owner to configure its authorized directory in Plexus",
      );
      expect(msg).not.toContain(jail);
      expect(msg).not.toContain("ENOENT");
      expect(msg).not.toMatch(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/);
      const ev = events.find((e) => e.capabilityId === CLAUDECODE_RUN_ID)!;
      const detail = ev.detail as Record<string, unknown>;
      expect(String(detail.launchError)).toContain(jail);
      // The audit still says which policy would have applied.
      expect(detail.policy).toBe("jail");
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (5) REAL LAUNCH wiring (gate ON, fake spawn): canary first, then the tool, or nothing
// ══════════════════════════════════════════════════════════════════════════════
describe("REAL LAUNCH — the canary runs under the identical wrap before the tool, and fails closed", () => {
  it("gate ON ⇒ canary (sh) then claude, both wrapped identically, cwd + temp inside the root, enforced:true", async () => {
    const jail = tmp("plexus-live-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log, tool: { stdout: "done", stderr: "", exitCode: 0 } }) });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "do the work" });

    expect(res.launched).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("done");
    expect(res.isolation).toMatchObject({ policy: "jail", mechanism: "sandbox-exec", enforced: true });
    expect(res.confinement.canary).toMatchObject({ ok: true, insideWrite: true, outsideWriteLanded: false, outsideReadSucceeded: false });

    expect(log.length).toBe(2);
    const [canary, tool] = log as [Spawned, Spawned];
    expect(isCanary(canary)).toBe(true);
    expect(isCanary(tool)).toBe(false);
    const root = realpathSync(jail);
    // Identical wrap: same wrapper, profile and -D params up to the inner command.
    const wrapOf = (s: Spawned) => [s.command, ...s.args.slice(0, s.args.indexOf("-D") + 1)];
    expect(wrapOf(canary)).toEqual(wrapOf(tool));
    const paramsOf = (s: Spawned) => s.args.filter((a) => /^(JAIL|HOMEDIR|TOOL_HOME|TOOL_BIN_DIR|TOOL_PKG_DIR|TOOL_INTERP_DIR)=/.test(a));
    expect(paramsOf(canary)).toEqual(paramsOf(tool));
    expect(paramsOf(tool)).toContain(`JAIL=${root}`);
    // cwd and BOTH temp knobs inside the root, for the canary and the tool alike.
    for (const s of [canary, tool]) {
      expect(s.cwd).toBe(root);
      expect(s.env?.TMPDIR).toBe(join(root, ".tmp"));
      expect(s.env?.CLAUDE_CODE_TMPDIR).toBe(join(root, ".tmp"));
    }
    expect(existsSync(join(root, ".tmp"))).toBe(true);
    // The real launch pins the session id for the owner's `claude --resume`.
    expect(res.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(tool.args[tool.args.indexOf("--session-id") + 1]).toBe(res.sessionId!);
    expect(res.argv).toEqual([tool.command, ...tool.args]);
    // The behaviour contract landed at the root.
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
  });

  it("a canary whose outside write LANDED on the host blocks the launch: nothing else spawned", async () => {
    const jail = tmp("plexus-live-");
    const outside = tmp("plexus-outside-");
    const log: Spawned[] = [];
    const launcher = new ClaudeCodeLauncher({
      authorizedDir: jail,
      resolveBinary: async () => CLAUDE,
      sandbox: JAIL_BACKEND,
      homedir: "/home/owner",
      toolHome: "/home/owner/.claude",
      canaryOutsideDir: () => outside,
      // The fake jail leaks: the "outside" write really lands where the canary pointed it.
      rawCapture: async (spec) => {
        log.push(spec);
        if (!isCanary(spec)) return { stdout: "", stderr: "", exitCode: 0 };
        writeFileSync(spec.args[spec.args.indexOf("plexus-canary") + 2]!, "x");
        return { stdout: "IN=1\nW=1\nR=0\n", stderr: "", exitCode: 0 };
      },
    });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.isolation).toMatchObject({ policy: "jail", enforced: false });
    expect(res.reason).toContain("wrote OUTSIDE");
    expect(res.confinement.canary).toMatchObject({ ok: false, outsideWriteLanded: true });
    expect(log.length).toBe(1);
    // The canary cleaned its outside dir up after itself.
    expect(existsSync(outside)).toBe(false);
  });

  it("a canary that could READ outside blocks the launch; the reason says so", async () => {
    const jail = tmp("plexus-live-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, {
      capture: fakeCapture({ log, canary: { stdout: "IN=1\nW=0\nR=1\n", stderr: "", exitCode: 0 } }),
    });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.isolation).toMatchObject({ policy: "jail", enforced: false });
    expect(res.reason).toContain("read a file OUTSIDE");
    expect(res.confinement.canary?.ok).toBe(false);
    expect(log.length).toBe(1);
    expect(isCanary(log[0]!)).toBe(true);
  });

  it("a canary that cannot write INSIDE blocks the launch (the jail would break the tool)", async () => {
    const jail = tmp("plexus-live-");
    const launcher = launcherFor(jail, { capture: fakeCapture({ canary: { stdout: "IN=0\nW=0\nR=0\n", stderr: "", exitCode: 0 } }) });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(false);
    expect(res.reason).toContain("could not write inside");
  });

  it("a canary that cannot even run (wrapper exits non-zero) blocks the launch with its stderr", async () => {
    const jail = tmp("plexus-live-");
    const launcher = launcherFor(jail, {
      capture: fakeCapture({ canary: { stdout: "", stderr: "sandbox-exec: profile parse error", exitCode: 64 } }),
    });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(false);
    expect(res.reason).toContain("exit 64");
    expect(res.reason).toContain("profile parse error");
  });

  it("an UNAVAILABLE backend blocks the launch before any canary", async () => {
    const jail = tmp("plexus-live-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, {
      capture: fakeCapture({ log }),
      sandbox: new DarwinSandboxBackend({ exists: () => false }),
    });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(false);
    expect(res.reason).toContain("sandbox-exec");
    expect(res.reason).toContain("not available");
    expect(log).toEqual([]);
  });

  it("claude absent (gate ON) ⇒ not launched, binaryMissing, no canary", async () => {
    const jail = tmp("plexus-live-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log }), claude: undefined });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(false);
    expect(res.binaryMissing).toBe(true);
    expect(log).toEqual([]);
  });

  it("HOST policy real launch: no canary, the native argv, cwd = the authorized dir, reported host / not enforced", async () => {
    const jail = tmp("plexus-live-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log, tool: { stdout: "ran", stderr: "", exitCode: 0 } }), policy: "host" });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(true);
    expect(res.isolation).toMatchObject({ policy: "host", mechanism: "none", enforced: false });
    expect(log.length).toBe(1);
    const [tool] = log as [Spawned];
    expect(tool.command).toBe(CLAUDE);
    expect(tool.args.some((a) => a.includes("sandbox"))).toBe(false);
    expect(tool.cwd).toBe(realpathSync(jail));
    expect(tool.env).toEqual({});
  });

  it("a launched run that exits non-zero is still `enforced` (it ran inside the jail) with the stderr as reason", async () => {
    const jail = tmp("plexus-live-");
    const launcher = launcherFor(jail, { capture: fakeCapture({ tool: { stdout: "", stderr: "boom", exitCode: 3 } }) });
    process.env.PLEXUS_CC_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.isolation.enforced).toBe(true);
    expect(res.reason).toBe("boom");
  });
});
