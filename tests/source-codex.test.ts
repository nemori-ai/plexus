/**
 * codex.run — the SANDBOXED Codex CLI capability (the Codex analog of claudecode.run).
 *
 * Proves the confinement-capability slice for the first-party `codex` source:
 *  (1) ENTRIES: `codex.run` is `grants:["execute"]` (⇒ PENDS for the owner) + a how-to
 *      skill; every entry well-formed against the frozen CapabilityEntry shape.
 *  (2) RECORD-MODE (gate OFF, default): no spawn happens; the launcher reports the EXACT
 *      native `<codex> exec --sandbox workspace-write --skip-git-repo-check <prompt>` argv
 *      it WOULD run (NO sandbox-exec wrapper — Codex sandboxes itself).
 *  (3) CWD-CONFINEMENT: a cwd that escapes the authorized dir is REJECTED with
 *      VaultConfinementError; the bridge surfaces it as a clean transport_error.
 *  (4) BRIDGE record-mode end-to-end: `codex.run` returns sandboxed metadata + the
 *      invoke is audited with `sandboxed:true` + the jail + mechanism.
 *  (5) MISSING BINARY: with the gate ON and `codex` absent, the launcher reports
 *      `binaryMissing` and the bridge degrades to the `source_unavailable` ErrorCode —
 *      advisory, NOT a crash, and NO spawn happens.
 *  (6) SOURCE health: a missing `codex` degrades health to "unavailable" (never hides
 *      the entry — scan() always returns the full set).
 */

import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildNativeArgv,
  CODEX_EXEC_SUBCOMMAND,
  CODEX_SANDBOX_FLAGS,
  CODEX_WORKSPACE_WRITE_MECHANISM,
  SandboxedCodexLauncher,
} from "@plexus/runtime/sources/codex/launcher.ts";
import { CodexBridge } from "@plexus/runtime/sources/codex/bridge.ts";
import { CodexSource } from "@plexus/runtime/sources/codex/manifest.ts";
import {
  codexEntries,
  CODEX_RUN_ID,
  HOW_TO_USE_ID,
} from "@plexus/runtime/sources/codex/entries.ts";
import type { CaptureResult } from "@plexus/runtime/sources/claudecode/launch.ts";
import { VaultConfinementError } from "@plexus/runtime/sources/obsidian/vault-reader.ts";
import type {
  AuditEvent,
  AuditEventInput,
  BridgeDeps,
  CapabilityEntry,
  EntryKind,
  GrantVerb,
  InvokeContext,
  PlatformServices,
} from "@plexus/protocol";

// ── temp-dir bookkeeping ──────────────────────────────────────────────────────
const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
// Sandbox PLEXUS_HOME (for the WHOLE file) so the launch gate (headlessLaunchEnabled →
// realLaunchEnabled) reads an EMPTY source-settings.json and falls to the env flag — the
// invariant these tests assert. Without this it would read the DEVELOPER's real ~/.plexus
// console toggle and the gate tests would depend on out-of-repo machine state. Kept out of
// the per-test `dirs` list so afterEach never deletes it mid-suite.
const PRIOR_PLEXUS_HOME = process.env.PLEXUS_HOME;
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), "plexus-codex-home-"));
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
  delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
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
function bridgeDeps(entries = codexEntries()): { deps: BridgeDeps; events: AuditEventInput[] } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const events: AuditEventInput[] = [];
  const audit = async (e: AuditEventInput): Promise<AuditEvent> => {
    events.push(e);
    return { ...e, id: `a-${events.length}`, at: new Date().toISOString() } as unknown as AuditEvent;
  };
  const deps: BridgeDeps = {
    audit,
    getTransport: () => {
      throw new Error("codex.run is served by an in-process handler; no transport needed");
    },
    getEntry: (id) => byId.get(id),
    invokeById: async () => {
      throw new Error("codex.run does not re-enter the pipeline");
    },
  };
  return { deps, events };
}

// ══════════════════════════════════════════════════════════════════════════════
// (1) ENTRIES
// ══════════════════════════════════════════════════════════════════════════════
describe("codex entries: execute capability + how-to skill", () => {
  it("codex.run is grants:['execute'] (⇒ PENDS for the owner)", () => {
    const byId = new Map(codexEntries().map((e) => [e.id, e]));
    const run = byId.get(CODEX_RUN_ID)!;
    expect(run.grants).toEqual(["execute"]);
    expect(run.kind).toBe("capability");
    expect(run.transport).toBe("ipc");
    expect(run.source).toBe("codex");
    expect(run.label).toBe("Run Codex");
    // The input schema is `{ prompt: string, cwd?: string }` (prompt required).
    const input = run.io?.input;
    expect(typeof input).toBe("object");
    expect((input as { required?: string[] }).required).toEqual(["prompt"]);
    expect((input as { properties?: Record<string, unknown> }).properties).toHaveProperty("cwd");
    // First-party provenance marker.
    expect((run.extras as { firstParty?: boolean }).firstParty).toBe(true);
  });

  it("ships a how-to-use SKILL (read-as-context, no grants, has a body)", () => {
    const skill = codexEntries().find((e) => e.id === HOW_TO_USE_ID)!;
    expect(skill.kind).toBe("skill");
    expect(skill.transport).toBe("skill");
    expect(skill.grants).toEqual([]);
    expect(skill.body?.format).toBe("markdown");
    expect((skill.body?.markdown ?? "").length).toBeGreaterThan(50);
  });

  it("every entry is well-formed against the frozen CapabilityEntry contract", () => {
    const validKinds: EntryKind[] = ["capability", "skill", "workflow"];
    const validVerbs: GrantVerb[] = ["read", "write", "execute"];
    const entries = codexEntries();
    for (const e of entries) {
      expect(e.id.startsWith("codex.")).toBe(true);
      expect(e.source).toBe("codex");
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
describe("launcher record-mode (gate OFF): builds the NATIVE codex argv, NO spawn", () => {
  it("predicts the FULL native `<codex> exec --sandbox workspace-write --skip-git-repo-check <prompt>` argv", async () => {
    const jail = tmp("plexus-codex-jail-");
    let spawned = false;
    const launcher = new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async (n) => (n === "codex" ? "/opt/homebrew/bin/codex" : undefined),
      rawCapture: async (): Promise<CaptureResult> => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH; // record-mode
    const res = await launcher.run({ prompt: "build it" });

    expect(spawned).toBe(false);
    expect(res.launched).toBe(false);
    expect(res.sandboxed).toBe(true);
    expect(res.ok).toBe(true); // record-mode is a clean no-op success

    // NO wrapper: the codex binary is spawned DIRECTLY. `--sandbox workspace-write`
    // keeps Codex's OWN write-confinement to the cwd.
    const argv = res.argv;
    expect(argv).toEqual([
      "/opt/homebrew/bin/codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "build it",
    ]);
    // No sandbox-exec / seatbelt anywhere; the old bypass-the-sandbox flag is gone.
    expect(argv.some((a) => a.includes("sandbox-exec"))).toBe(false);
    expect(argv.some((a) => a.endsWith(".sb"))).toBe(false);
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    // confinement metadata for audit — honestly the tool's OWN native sandbox.
    expect(res.confinement.mechanism).toBe(CODEX_WORKSPACE_WRITE_MECHANISM);
    expect(res.confinement.mechanism).toBe("codex-workspace-write");
    expect(res.confinement.jail).toBe(res.jail);
  });

  it("buildNativeArgv is pure + deterministic (the native command shape)", () => {
    const { command, args } = buildNativeArgv({ codexBin: "/abs/codex", prompt: "x" });
    expect(command).toBe("/abs/codex");
    expect(args).toEqual([CODEX_EXEC_SUBCOMMAND, ...CODEX_SANDBOX_FLAGS, "x"]);
    expect(args).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "x",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (3) CWD-CONFINEMENT — out-of-dir / traversal rejected
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher cwd-confinement: rejects escapes BEFORE any spawn", () => {
  function launcherFor(jail: string): SandboxedCodexLauncher {
    return new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/opt/homebrew/bin/codex",
      rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
  }

  it("a sub-path of the authorized dir is allowed (confines to it)", () => {
    const jail = tmp("plexus-codex-jail-");
    mkdirSync(join(jail, "sub"), { recursive: true });
    const confined = launcherFor(jail).confineCwd("sub");
    expect(confined.endsWith("/sub")).toBe(true);
  });

  it("a `..` traversal cwd is REJECTED with VaultConfinementError", () => {
    const jail = tmp("plexus-codex-jail-");
    expect(() => launcherFor(jail).confineCwd("../escape")).toThrow(VaultConfinementError);
  });

  it("an absolute cwd OUTSIDE the authorized dir is REJECTED", () => {
    const jail = tmp("plexus-codex-jail-");
    expect(() => launcherFor(jail).confineCwd("/etc")).toThrow(VaultConfinementError);
  });

  it("run() with an escaping cwd throws before spawning", async () => {
    const jail = tmp("plexus-codex-jail-");
    let spawned = false;
    const launcher = new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/opt/homebrew/bin/codex",
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
// (4) BRIDGE record-mode end-to-end + audit
// ══════════════════════════════════════════════════════════════════════════════
describe("codex bridge: record-mode run + sandboxed audit", () => {
  function fakeLauncher(jail: string): SandboxedCodexLauncher {
    return new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/opt/homebrew/bin/codex",
      rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
  }

  it("codex.run returns sandboxed metadata + jail; the invoke is audited as sandboxed", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), fakeLauncher(jail));

    expect(bridge.route(CODEX_RUN_ID)).toBe("handled");
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH; // record-mode
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "scaffold the app" } }, CTX);

    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out.sandboxed).toBe(true);
    expect(out.launched).toBe(false);
    // WIRE/AUDIT SPLIT: the agent-facing result carries NO machine fingerprint — the
    // jail path, sandbox argv, and confinement diagnostics are the OWNER's information.
    expect(out.jail).toBeUndefined();
    expect(out.argv).toBeUndefined();
    expect(out.confinement).toBeUndefined();

    // Audit carries the EXECUTE verb + the sandbox posture + the FULL diagnostics
    // (owner-facing), with the prompt masked out of the argv copy (redaction-safe).
    const ev = events.find((e) => e.capabilityId === CODEX_RUN_ID)!;
    expect(ev.verbs).toEqual(["execute"]);
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.sandboxed).toBe(true);
    expect(detail.mechanism).toBe("codex-workspace-write");
    expect(detail.op).toBe("run");
    expect(typeof detail.jail).toBe("string");
    // The audited argv is the NATIVE codex command (no sandbox-exec wrapper).
    expect(detail.argv as string[]).toContain("--sandbox");
    expect((detail.argv as string[]).some((a) => a.includes("sandbox-exec"))).toBe(false);
    expect((detail.confinement as { mechanism: string }).mechanism).toBe("codex-workspace-write");
    // never leaks the prompt text.
    expect(JSON.stringify(ev.detail)).not.toContain("scaffold the app");
  });

  it("masks the prompt in the audit argv even when it has surrounding whitespace", async () => {
    // The launcher trims the prompt before building argv; the mask must account for both
    // forms so a raw prompt with a trailing newline (ubiquitous from pipes) never leaks.
    const jail = tmp("plexus-codex-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), fakeLauncher(jail));
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH; // record-mode still builds argv
    const SECRET = "exfiltrate the database";
    await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: `  ${SECRET}\n` } }, CTX);
    const ev = events.find((e) => e.capabilityId === CODEX_RUN_ID)!;
    const detail = ev.detail as { argv: string[] };
    expect(detail.argv).toContain("«prompt»");
    expect(JSON.stringify(ev.detail)).not.toContain(SECRET);
  });

  it("a missing prompt is rejected with schema_validation_failed (no spawn)", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), fakeLauncher(jail));
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });

  it("an escaping cwd surfaces as a clean transport_error (no crash)", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), fakeLauncher(jail));
    const res = await bridge.invoke(
      { id: CODEX_RUN_ID, input: { prompt: "x", cwd: "../../etc" } },
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

  it("a MISSING configured authorized dir no longer ENOENTs — mkdir creates it before realpath", async () => {
    const parent = tmp("plexus-codex-parent-");
    const jail = join(parent, "not-created-yet");
    expect(existsSync(jail)).toBe(false);
    const launcher = new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/usr/local/bin/codex",
      rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH; // record-mode
    const res = await launcher.run({ prompt: "x" }); // must NOT throw ENOENT
    expect(res.sandboxed).toBe(true);
    expect(existsSync(jail)).toBe(true); // the best-effort mkdir created it
  });

  it("a REAL fs failure (unwritable parent) surfaces a SANITIZED, path-free wire error; the host path stays audit-only", async () => {
    const parent = tmp("plexus-codex-ro-parent-");
    const jail = join(parent, "sub", "jail");
    chmodSync(parent, 0o500); // read+exec, NOT writable ⇒ mkdir fails, realpath ENOENTs
    try {
      const launcher = new SandboxedCodexLauncher({
        authorizedDir: jail,
        resolveBinary: async () => "/usr/local/bin/codex",
        rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      });
      const { deps, events } = bridgeDeps();
      const bridge = new CodexBridge(deps, "s1", codexEntries(), launcher);
      delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
      const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x" } }, CTX);

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("transport_error");
      const msg = res.error?.message ?? "";
      // THE LEAK REGRESSION: no host path, no fs status on the wire.
      expect(msg).toBe(
        "the coding workspace is not available — ask the owner to configure its authorized directory in Plexus",
      );
      expect(msg).not.toContain(jail);
      expect(msg).not.toContain(parent);
      expect(msg).not.toContain("ENOENT");
      expect(msg).not.toContain("EACCES");
      expect(msg).not.toMatch(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/);
      // The REAL, path-bearing detail lives in the OWNER's audit record only.
      const ev = events.find((e) => e.capabilityId === CODEX_RUN_ID)!;
      const detail = ev.detail as Record<string, unknown>;
      expect(String(detail.launchError)).toContain(jail);
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (5) MISSING BINARY — degrade to source_unavailable (advisory, no crash)
// ══════════════════════════════════════════════════════════════════════════════
describe("codex bridge: a missing `codex` binary degrades to source_unavailable", () => {
  it("gate ON + codex absent ⇒ ok:false, source_unavailable, NO spawn", async () => {
    const jail = tmp("plexus-codex-jail-");
    let spawned = false;
    const launcher = new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async () => undefined, // codex NOT on PATH
      rawCapture: async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcher);

    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1"; // gate ON ⇒ would spawn if codex existed
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "do work" } }, CTX);

    expect(spawned).toBe(false); // never spawned — no binary to spawn
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("source_unavailable");
    expect(res.error?.message).toContain("codex");
    // The invoke was still audited (error outcome).
    const ev = events.find((e) => e.capabilityId === CODEX_RUN_ID)!;
    expect(ev.outcome).toBe("error");
  });

  it("launcher.run reports binaryMissing when codex is absent (gate ON)", async () => {
    const jail = tmp("plexus-codex-jail-");
    const launcher = new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async () => undefined,
      rawCapture: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.ok).toBe(false);
    expect(res.launched).toBe(false);
    expect(res.binaryMissing).toBe(true);
  });

  it("a REAL launch materializes the jail-root AGENTS.md behavior contract (owner's file wins)", async () => {
    const jail = tmp("plexus-codex-jail-");
    const launcher = new SandboxedCodexLauncher({
      authorizedDir: jail,
      resolveBinary: async () => "/usr/local/bin/codex",
      rawCapture: async () => ({ stdout: "done", stderr: "", exitCode: 0 }),
    });
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(true);
    // The behavior contract landed at the jail root (codex reads AGENTS.md from cwd):
    // relative paths only, no machine fingerprint in output.
    const contract = readFileSync(join(jail, "AGENTS.md"), "utf8");
    expect(contract).toContain("RELATIVE path");
    expect(contract).toContain("Never volunteer");
    // Owner-authored file WINS: a pre-existing AGENTS.md is never clobbered.
    const jail2 = tmp("plexus-codex-jail-");
    writeFileSync(join(jail2, "AGENTS.md"), "# my house, my rules\n");
    const launcher2 = new SandboxedCodexLauncher({
      authorizedDir: jail2,
      resolveBinary: async () => "/usr/local/bin/codex",
      rawCapture: async () => ({ stdout: "done", stderr: "", exitCode: 0 }),
    });
    await launcher2.run({ prompt: "x" });
    expect(readFileSync(join(jail2, "AGENTS.md"), "utf8")).toBe("# my house, my rules\n");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (6) SOURCE health — missing codex degrades to "unavailable" (entry NEVER hidden)
// ══════════════════════════════════════════════════════════════════════════════
describe("codex source: health derives from the codex binary presence", () => {
  function fakePlatform(codex: string | undefined): PlatformServices {
    return {
      platform: "darwin",
      resolveBinary: async (n: string) => (n === "codex" ? codex : undefined),
    } as unknown as PlatformServices;
  }

  it("scan() ALWAYS returns the full ungated entry set (codex present or not)", async () => {
    const src = new CodexSource(fakePlatform(undefined));
    const entries = await src.scan();
    expect(entries.map((e) => e.id)).toContain(CODEX_RUN_ID);
    expect(entries.map((e) => e.id)).toContain(HOW_TO_USE_ID);
  });

  it("health is 'unavailable' when codex is absent (it sandboxes itself — no seatbelt to probe)", async () => {
    const src = new CodexSource(fakePlatform(undefined));
    const health = await src.health();
    if (health.status === "ok") {
      // Only possible if a real `codex` slipped through the fake — guard against that.
      throw new Error("expected unavailable health with codex absent");
    }
    expect(health.status).toBe("unavailable");
    expect(health.detail ?? "").toMatch(/codex/);
  });
});
