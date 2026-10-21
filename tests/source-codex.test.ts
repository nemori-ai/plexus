import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_PROTECTED_STATE,
  CODEX_TOOL,
  CodexLauncher,
  parseSessionId,
} from "@plexus/runtime/sources/codex/launcher.ts";
import { CodexBridge } from "@plexus/runtime/sources/codex/bridge.ts";
import { CodexSource } from "@plexus/runtime/sources/codex/manifest.ts";
import { codexEntries, CODEX_RUN_ID, HOW_TO_USE_ID } from "@plexus/runtime/sources/codex/entries.ts";
import type { CaptureResult, CaptureSpawn } from "@plexus/runtime/sources/exec-capture.ts";
import { DarwinSandboxBackend } from "@plexus/runtime/platform/sandbox-backend.ts";
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
  delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
  delete process.env.PLEXUS_CODEX_EXEC_POLICY;
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
const CODEX = "/opt/homebrew/bin/codex";
const CANARY_PASS: CaptureResult = { stdout: "IN=1\nW=0\nR=0\n", stderr: "", exitCode: 0 };
type Spawned = Parameters<CaptureSpawn>[0];
const isCanary = (s: Spawned) => s.args.includes("/bin/sh");

function fakeCapture(opts: { canary?: CaptureResult; tool?: CaptureResult | ((s: Spawned) => CaptureResult); log?: Spawned[] } = {}): CaptureSpawn {
  return async (spec) => {
    opts.log?.push(spec);
    if (isCanary(spec)) return opts.canary ?? CANARY_PASS;
    const t = opts.tool ?? { stdout: "", stderr: "", exitCode: 0 };
    return typeof t === "function" ? t(spec) : t;
  };
}

const JAIL_BACKEND = new DarwinSandboxBackend({ exists: () => true });

function launcherFor(
  jail: string,
  opts: { capture?: CaptureSpawn; policy?: "jail" | "host"; codex?: string | undefined; toolHome?: string } = {},
): CodexLauncher {
  return new CodexLauncher({
    authorizedDir: jail,
    resolveBinary: async (n) => (n === "codex" ? ("codex" in opts ? opts.codex : CODEX) : undefined),
    rawCapture: opts.capture ?? fakeCapture(),
    sandbox: JAIL_BACKEND,
    homedir: "/home/owner",
    toolHome: opts.toolHome ?? "/home/owner/.codex",
    ...(opts.policy ? { policy: () => opts.policy! } : {}),
  });
}

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
  it("codex.run is grants:['execute'] (⇒ PENDS for the owner) and states `isolation` in its output", () => {
    const byId = new Map(codexEntries().map((e) => [e.id, e]));
    const run = byId.get(CODEX_RUN_ID)!;
    expect(run.grants).toEqual(["execute"]);
    expect(run.kind).toBe("capability");
    expect(run.transport).toBe("ipc");
    expect(run.source).toBe("codex");
    expect(run.label).toBe("Run Codex");
    const input = run.io?.input;
    expect((input as { required?: string[] }).required).toEqual(["prompt"]);
    expect((input as { properties?: Record<string, unknown> }).properties).toHaveProperty("cwd");
    expect((run.extras as { firstParty?: boolean }).firstParty).toBe(true);
    const output = run.io?.output as { required?: string[]; properties?: Record<string, unknown> };
    expect(output.required).toEqual(["ok", "isolation"]);
    expect(output.properties).not.toHaveProperty("sandboxed");
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
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("launcher record-mode (gate OFF): assembles the jailed argv, NO spawn", () => {
  it("predicts `sandbox-exec -f codex-confine.sb -D … codex exec --sandbox danger-full-access …`", async () => {
    const jail = tmp("plexus-codex-jail-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log }) });
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
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
    expect(argv[2]!.endsWith("/codex/sandbox/codex-confine.sb")).toBe(true);
    expect(argv).toContain(`JAIL=${root}`);
    expect(argv).toContain("TOOL_HOME=/home/owner/.codex");
    expect(argv.slice(argv.indexOf(CODEX))).toEqual([
      CODEX,
      "exec",
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "build it",
    ]);
    expect(argv).not.toContain("workspace-write");
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(res.confinement.root).toBe(root);
  });

  it("HOST policy (owner-chosen): the unwrapped argv, reported as host / not enforced", async () => {
    const jail = tmp("plexus-codex-jail-");
    const res = await launcherFor(jail, { policy: "host" }).run({ prompt: "build it" });
    expect(res.argv).toEqual([CODEX, "exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "build it"]);
    expect(res.isolation).toMatchObject({ policy: "host", mechanism: "none", enforced: false });
    expect(res.isolation.scope).toEqual({ files: "host-user", temp: "host-user", network: "open", toolState: "host-user" });
  });

  it("CODEX_HOME names the tool home: the profile param and the state mounts follow it", async () => {
    const jail = tmp("plexus-codex-jail-");
    const home = "/home/owner/Library/Application Support/orca/codex-accounts/x/home";
    const res = await launcherFor(jail, { toolHome: home }).run({ prompt: "x" });
    expect(res.argv).toContain(`TOOL_HOME=${home}`);
    expect(res.confinement.toolHome).toBe(home);
    const mounts = CODEX_TOOL.toolState(home, "/home/owner");
    expect(mounts[0]).toEqual({ path: home, access: "rw" });
    for (const entry of CODEX_PROTECTED_STATE) expect(mounts).toContainEqual({ path: join(home, entry), access: "ro" });
  });

  it("CODEX_TOOL.toolHome resolves $CODEX_HOME, else ~/.codex", () => {
    const prior = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/x/codex-home";
      expect(CODEX_TOOL.toolHome()).toBe("/x/codex-home");
      delete process.env.CODEX_HOME;
      expect(CODEX_TOOL.toolHome().endsWith("/.codex")).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prior;
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (3) CWD-CONFINEMENT — out-of-dir / traversal rejected
// ══════════════════════════════════════════════════════════════════════════════
describe("launcher cwd-confinement: rejects escapes BEFORE any spawn", () => {
  it("a sub-path of the authorized dir is allowed (confines to it)", () => {
    const jail = tmp("plexus-codex-jail-");
    mkdirSync(join(jail, "sub"), { recursive: true });
    expect(launcherFor(jail).confineCwd("sub").endsWith("/sub")).toBe(true);
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
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log }) });
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    await expect(launcher.run({ prompt: "x", cwd: "../../etc" })).rejects.toBeInstanceOf(VaultConfinementError);
    expect(log).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (4) BRIDGE record-mode end-to-end + audit
// ══════════════════════════════════════════════════════════════════════════════
describe("codex bridge: the wire carries the isolation report, the audit carries the policy + diagnostics", () => {
  it("codex.run returns `isolation` and no host path; the invoke is audited with the policy", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail));

    expect(bridge.route(CODEX_RUN_ID)).toBe("handled");
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "scaffold the app" } }, CTX);

    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out.isolation).toMatchObject({ policy: "jail", mechanism: "sandbox-exec", enforced: false });
    expect(out.launched).toBe(false);
    expect(out.sandboxed).toBeUndefined();
    expect(out.jail).toBeUndefined();
    expect(out.argv).toBeUndefined();
    expect(out.confinement).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(realpathSync(jail));

    const ev = events.find((e) => e.capabilityId === CODEX_RUN_ID)!;
    expect(ev.verbs).toEqual(["execute"]);
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.policy).toBe("jail");
    expect(detail.mechanism).toBe("sandbox-exec");
    expect(detail.op).toBe("run");
    expect(typeof detail.jail).toBe("string");
    const argv = detail.argv as string[];
    expect(argv[0]).toBe("/usr/bin/sandbox-exec");
    expect(argv).toContain("danger-full-access");
    expect(argv).toContain("«prompt»");
    expect((detail.confinement as { mechanism: string }).mechanism).toBe("sandbox-exec");
    expect(JSON.stringify(ev.detail)).not.toContain("scaffold the app");
  });

  it("a HOST run is audited as host", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail, { policy: "host" }));
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x" } }, CTX);
    expect((res.output as { isolation: { policy: string } }).isolation.policy).toBe("host");
    const detail = events.find((e) => e.capabilityId === CODEX_RUN_ID)!.detail as Record<string, unknown>;
    expect(detail.policy).toBe("host");
    expect((detail.argv as string[])[0]).toBe(CODEX);
  });

  it("masks the prompt in the audit argv even when it has surrounding whitespace", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail));
    const SECRET = "exfiltrate the database";
    await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: `  ${SECRET}\n` } }, CTX);
    const ev = events.find((e) => e.capabilityId === CODEX_RUN_ID)!;
    expect((ev.detail as { argv: string[] }).argv).toContain("«prompt»");
    expect(JSON.stringify(ev.detail)).not.toContain(SECRET);
  });

  it("a missing prompt is rejected with schema_validation_failed (no spawn)", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail));
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: {} }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("schema_validation_failed");
  });

  it("an escaping cwd surfaces as a clean transport_error (no crash)", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail));
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x", cwd: "../../etc" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    expect(res.error?.message).toBe("the requested working directory is outside the authorized workspace");
    expect(res.error?.message).not.toContain("etc");
  });

  it("a MISSING configured authorized dir no longer ENOENTs — mkdir creates it before realpath", async () => {
    const parent = tmp("plexus-codex-parent-");
    const jail = join(parent, "not-created-yet");
    expect(existsSync(jail)).toBe(false);
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
    const res = await launcherFor(jail).run({ prompt: "x" });
    expect(res.isolation.policy).toBe("jail");
    expect(existsSync(jail)).toBe(true);
  });

  it("a REAL fs failure (unwritable parent) surfaces a SANITIZED, path-free wire error; the host path stays audit-only", async () => {
    const parent = tmp("plexus-codex-ro-parent-");
    const jail = join(parent, "sub", "jail");
    chmodSync(parent, 0o500);
    try {
      const { deps, events } = bridgeDeps();
      const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail));
      delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
      const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x" } }, CTX);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("transport_error");
      const msg = res.error?.message ?? "";
      expect(msg).toBe(
        "the coding workspace is not available — ask the owner to configure its authorized directory in Plexus",
      );
      expect(msg).not.toContain(jail);
      expect(msg).not.toContain("ENOENT");
      expect(msg).not.toMatch(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/);
      const detail = events.find((e) => e.capabilityId === CODEX_RUN_ID)!.detail as Record<string, unknown>;
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
  it("gate ON + codex absent ⇒ ok:false, source_unavailable, NO spawn, NO canary", async () => {
    const jail = tmp("plexus-codex-jail-");
    const log: Spawned[] = [];
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail, { capture: fakeCapture({ log }), codex: undefined }));
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "do work" } }, CTX);
    expect(log).toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("source_unavailable");
    expect(res.error?.message).toContain("codex");
    expect(events.find((e) => e.capabilityId === CODEX_RUN_ID)!.outcome).toBe("error");
  });

  it("launcher.run reports binaryMissing when codex is absent (gate ON)", async () => {
    const jail = tmp("plexus-codex-jail-");
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await launcherFor(jail, { codex: undefined }).run({ prompt: "x" });
    expect(res.ok).toBe(false);
    expect(res.launched).toBe(false);
    expect(res.binaryMissing).toBe(true);
  });

  it("a REAL launch materializes the root AGENTS.md behavior contract (owner's file wins)", async () => {
    const jail = tmp("plexus-codex-jail-");
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await launcherFor(jail, { capture: fakeCapture({ tool: { stdout: "done", stderr: "", exitCode: 0 } }) }).run({ prompt: "x" });
    expect(res.launched).toBe(true);
    const contract = readFileSync(join(jail, "AGENTS.md"), "utf8");
    expect(contract).toContain("RELATIVE path");
    expect(contract).toContain("Never volunteer");
    const jail2 = tmp("plexus-codex-jail-");
    writeFileSync(join(jail2, "AGENTS.md"), "# my house, my rules\n");
    await launcherFor(jail2).run({ prompt: "x" });
    expect(readFileSync(join(jail2, "AGENTS.md"), "utf8")).toBe("# my house, my rules\n");
  });
});

describe("REAL LAUNCH — canary first under the identical wrap, then codex; the resume handle is parsed", () => {
  const SID = "019f5bf6-2246-7500-887e-81fdae1ce643";
  const BANNER = `OpenAI Codex v0.163.0\n--------\nworkdir: /x\nsession id: ${SID}\n--------\n`;

  it("parseSessionId extracts the banner uuid from stdout OR stderr; absent ⇒ undefined", () => {
    expect(parseSessionId(BANNER, "")).toBe(SID);
    expect(parseSessionId("", BANNER)).toBe(SID);
    expect(parseSessionId("no banner here", "")).toBeUndefined();
  });

  it("gate ON ⇒ canary then codex, identical wrap, TMPDIR inside the root, enforced:true, sessionId parsed", async () => {
    const jail = tmp("plexus-codex-live-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log, tool: { stdout: BANNER + "done", stderr: "", exitCode: 0 } }) });
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(true);
    expect(res.isolation).toMatchObject({ policy: "jail", enforced: true });
    expect(res.sessionId).toBe(SID);
    expect(log.length).toBe(2);
    const [canary, tool] = log as [Spawned, Spawned];
    expect(isCanary(canary)).toBe(true);
    const paramsOf = (s: Spawned) => s.args.filter((a) => /^(JAIL|HOMEDIR|TOOL_HOME|TOOL_BIN_DIR|TOOL_PKG_DIR|TOOL_INTERP_DIR)=/.test(a));
    expect(paramsOf(canary)).toEqual(paramsOf(tool));
    const root = realpathSync(jail);
    for (const s of [canary, tool]) {
      expect(s.cwd).toBe(root);
      expect(s.env).toEqual({ TMPDIR: join(root, ".tmp") });
    }
    delete process.env.PLEXUS_CODEX_HEADLESS_LAUNCH;
    expect((await launcher.run({ prompt: "x" })).sessionId).toBeUndefined();
  });

  it("a failing canary blocks the launch", async () => {
    const jail = tmp("plexus-codex-live-");
    const log: Spawned[] = [];
    const launcher = launcherFor(jail, { capture: fakeCapture({ log, canary: { stdout: "IN=1\nW=0\nR=1\n", stderr: "", exitCode: 0 } }) });
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await launcher.run({ prompt: "x" });
    expect(res.launched).toBe(false);
    expect(res.isolation.enforced).toBe(false);
    expect(res.reason).toContain("OUTSIDE");
    expect(log.length).toBe(1);
  });

  it("the bridge lands sessionId in the AUDIT detail — never on the wire result", async () => {
    const jail = tmp("plexus-codex-jail-");
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail, { capture: fakeCapture({ tool: { stdout: BANNER + "done", stderr: "", exitCode: 0 } }) }));
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "do work" } }, CTX);
    expect(res.ok).toBe(true);
    const ev = events.find((e) => e.capabilityId === CODEX_RUN_ID)!;
    expect((ev.detail as { sessionId?: string }).sessionId).toBe(SID);
    expect((ev.detail as { isolation: { enforced: boolean } }).isolation.enforced).toBe(true);
    expect((res.output as { sessionId?: string } | undefined)?.sessionId).toBeUndefined();
    expect((res.output as { isolation: { enforced: boolean } }).isolation.enforced).toBe(true);
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

  it("health is 'unavailable' when codex is absent", async () => {
    const src = new CodexSource(fakePlatform(undefined));
    const health = await src.health();
    if (health.status === "ok") throw new Error("expected unavailable health with codex absent");
    expect(health.status).toBe("unavailable");
    expect(health.detail ?? "").toMatch(/codex/);
  });
});

describe("CODEX_PROTECTED_STATE matches the profile's deny block (one list, two encodings)", () => {
  it("every protected entry is denied for writing in codex-confine.sb, and nothing else is", () => {
    const profile = readFileSync(new URL("../packages/runtime/src/sources/codex/sandbox/codex-confine.sb", import.meta.url), "utf8");
    const deny = profile.slice(profile.lastIndexOf("(deny file-write*"));
    const denied = [...deny.matchAll(/\(param "TOOL_HOME"\) "\/([^"]+)"/g)].map((m) => m[1]);
    expect(denied.sort()).toEqual([...CODEX_PROTECTED_STATE].sort());
  });
});

// ── A FAILED run: what the CALLER gets vs what the OWNER's audit keeps ────────────────
describe("codex bridge: a failed run splits the wire from the audit", () => {
  const BANNER_MODEL = "gpt-5.6-sol";
  const REAL_CAUSE = "ERROR_AT_THE_VERY_END: quota exhausted";

  function failingLauncher(jail: string, stderr: string): CodexLauncher {
    return launcherFor(jail, { capture: fakeCapture({ tool: { stdout: "", stderr, exitCode: 3 } }) });
  }

  function transcriptFor(jail: string): string {
    const banner =
      `Reading additional input from stdin...\nOpenAI Codex v0.147.0\n--------\n` +
      `workdir: ${jail}\nmodel: ${BANNER_MODEL}\nsandbox: danger-full-access\n--------\n`;
    return `${banner}${"filler line\n".repeat(3000)}${REAL_CAUSE}`;
  }

  it("the CALLER gets a path-free summary with the exit code — no transcript, on either channel", async () => {
    const jail = tmp("plexus-codex-fail-");
    const { deps } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), failingLauncher(jail, transcriptFor(jail)));
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    const res = await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("transport_error");
    const msg = res.error?.message ?? "";
    expect(msg).toContain("exit 3");
    expect(msg).not.toContain(jail);
    expect(msg).not.toContain(BANNER_MODEL);
    expect(msg).not.toContain(REAL_CAUSE);
    expect(msg.length).toBeLessThan(400);
    expect(res.output).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain(jail);
    expect(JSON.stringify(res)).not.toContain(REAL_CAUSE);
  });

  it("the OWNER's audit keeps the failing run's real output, tail-first and bounded", async () => {
    const jail = tmp("plexus-codex-fail-audit-");
    const stderr = transcriptFor(jail);
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), failingLauncher(jail, stderr));
    process.env.PLEXUS_CODEX_HEADLESS_LAUNCH = "1";
    await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x" } }, CTX);
    const detail = events.find((e) => e.capabilityId === CODEX_RUN_ID)!.detail as Record<string, unknown>;
    const kept = String(detail.failureOutput);
    expect(kept).toContain(REAL_CAUSE);
    expect(kept.length).toBeLessThan(stderr.length);
    expect(kept.length).toBeLessThanOrEqual(8100);
    expect(kept).toContain("chars before]");
    expect(kept).not.toContain("Reading additional input from stdin");
  });
});

// ── ADR-029: the audit records WHICH transport shape a call used ─────────────────────
describe("codex bridge: the invoke audit marks an async dispatch", () => {
  it("stamps the run id when the context carries one, and omits it otherwise", async () => {
    const jail = tmp("plexus-codex-runid-");
    const { deps, events } = bridgeDeps();
    const bridge = new CodexBridge(deps, "s1", codexEntries(), launcherFor(jail));
    await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x" } }, { ...CTX, runId: "run_abc" });
    expect(events.find((e) => e.capabilityId === CODEX_RUN_ID)!.runId).toBe("run_abc");
    events.length = 0;
    await bridge.invoke({ id: CODEX_RUN_ID, input: { prompt: "x" } }, CTX);
    expect(events.find((e) => e.capabilityId === CODEX_RUN_ID)!.runId).toBeUndefined();
  });
});
