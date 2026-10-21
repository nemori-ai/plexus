/**
 * The kernel jail, for real: a FAKE tool (a /bin/sh script) launched through the REAL
 * launcher, the REAL profile and the REAL wrap (sandbox-exec on macOS, bwrap on Linux).
 * Skipped where no kernel jail backend is usable.
 *
 * The defect each assertion pins is a jail that leaks: a write or read outside the
 * authorized root, through an absolute path, a symlink planted inside the jail, the
 * system temp, a child process, or the tool's own behaviour-changing state. The matrix
 * is judged from the HOST side wherever the kernel could fake an in-jail success (Linux
 * shadows /tmp with a private tmpfs, so "the write worked" means nothing until the host
 * confirms no file landed). Fake homes and fake credentials only; the owner's real
 * ~/.claude and $CODEX_HOME are never touched.
 */

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeCodeLauncher } from "@plexus/runtime/sources/claudecode/launcher.ts";
import { CodexLauncher, CODEX_PROTECTED_STATE } from "@plexus/runtime/sources/codex/launcher.ts";
import { defaultCapture } from "@plexus/runtime/sources/exec-capture.ts";
import type { ExecLauncherDeps, ExecRunResult } from "@plexus/runtime/sources/exec-launcher.ts";
import { selectSandboxBackend } from "@plexus/runtime/platform/sandbox-backend.ts";

const platform = process.platform === "linux" ? "linux" : "darwin";
const backend = selectSandboxBackend(platform);
const available = (process.platform === "darwin" || process.platform === "linux") && backend.isAvailableSync();
const SYSTMP = realpathSync(tmpdir());

interface Fixture {
  base: string;
  root: string;
  outside: string;
  home: string;
  toolHome: string;
  binDir: string;
  nonce: string;
}

function fixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "plexus-kernel-")));
  const root = join(base, "jail");
  const outside = join(base, "outside");
  const home = join(base, "home");
  const toolHome = join(home, "tool-home");
  const binDir = join(base, "bin");
  for (const d of [root, join(root, "sub"), outside, home, toolHome, binDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, "seed.txt"), "seed\n");
  writeFileSync(join(outside, "secret.txt"), "FAKE-SECRET-DO-NOT-READ\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "link-to-secret"));
  symlinkSync(outside, join(root, "link-to-outside-dir"));
  return { base, root, outside, home, toolHome, binDir, nonce: base.split("-").pop()! };
}

/** The fake tool: every probe prints `NAME=1|0`; paths are baked in per fixture. */
function fakeTool(f: Fixture, name: string, extra: string[]): string {
  const script = [
    "#!/bin/sh",
    't() { n=$1; shift; if "$@" >/dev/null 2>&1; then echo "$n=1"; else echo "$n=0"; fi; }',
    'w() { printf x > "$1"; }',
    `t IN_W w "${f.root}/in.txt"`,
    `t IN_R cat "${f.root}/seed.txt"`,
    `t SUB_W w "${f.root}/sub/in2.txt"`,
    `t OUT_W w "${f.outside}/w.txt"`,
    `t OUT_R cat "${f.outside}/secret.txt"`,
    `t LINK_R cat "${f.root}/link-to-secret"`,
    `t LINK_W w "${f.root}/link-to-outside-dir/w2.txt"`,
    `t TMP_W w "/tmp/plexus-kernel-leak-${f.nonce}"`,
    `t SYSTMP_W w "${SYSTMP}/plexus-kernel-leak-${f.nonce}"`,
    't t_tmpdir_w w "$TMPDIR/ok.txt"',
    `t CHILD_OUT_W sh -c "printf x > '${f.outside}/child.txt'"`,
    `t CHILD_IN_W sh -c "printf x > '${f.root}/child-in.txt'"`,
    ...extra,
    'echo "CWD=$(pwd)"',
    'echo "TMPDIR=$TMPDIR"',
    'echo "ARGV=$*"',
    "exit 0",
  ].join("\n");
  const path = join(f.binDir, name);
  writeFileSync(path, script + "\n");
  chmodSync(path, 0o755);
  return path;
}

function flags(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(line);
    if (m) r[m[1]!] = m[2]!;
  }
  return r;
}

function deps(f: Fixture, bin: string, extra: Partial<ExecLauncherDeps> = {}): ExecLauncherDeps {
  return {
    authorizedDir: f.root,
    resolveBinary: async (n) => (n === "node" ? undefined : bin),
    rawCapture: defaultCapture,
    sandbox: backend,
    homedir: f.home,
    toolHome: f.toolHome,
    policy: () => "jail",
    realLaunch: () => true,
    ...extra,
  };
}

/** The assertions every jailed run must satisfy, judged from the host where it matters. */
function assertJailHeld(f: Fixture, res: ExecRunResult, cwd = f.root): Record<string, string> {
  expect(res.launched).toBe(true);
  expect(res.ok).toBe(true);
  expect(res.isolation).toMatchObject({ policy: "jail", mechanism: backend.mechanism, enforced: true });
  expect(res.confinement.canary?.ok).toBe(true);
  const o = flags(res.output);
  // Inside: reads and writes work, in the root, a sub-dir, $TMPDIR and from a child.
  expect(o.IN_W).toBe("1");
  expect(o.IN_R).toBe("1");
  expect(o.SUB_W).toBe("1");
  expect(o.t_tmpdir_w).toBe("1");
  expect(o.CHILD_IN_W).toBe("1");
  expect(o.TMPDIR).toBe(join(f.root, ".tmp"));
  expect(o.CWD).toBe(cwd);
  expect(res.jail).toBe(cwd);
  expect(existsSync(join(f.root, "in.txt"))).toBe(true);
  expect(existsSync(join(f.root, ".tmp", "ok.txt"))).toBe(true);
  // Outside: nothing landed on the host, by any route.
  expect(existsSync(join(f.outside, "w.txt"))).toBe(false);
  expect(existsSync(join(f.outside, "w2.txt"))).toBe(false);
  expect(existsSync(join(f.outside, "child.txt"))).toBe(false);
  expect(existsSync(`/tmp/plexus-kernel-leak-${f.nonce}`)).toBe(false);
  expect(existsSync(join(SYSTMP, `plexus-kernel-leak-${f.nonce}`))).toBe(false);
  // Outside reads failed, direct and through the planted symlink.
  expect(o.OUT_R).toBe("0");
  expect(o.LINK_R).toBe("0");
  expect(res.output).not.toContain("FAKE-SECRET");
  if (platform === "darwin") {
    // The seatbelt denies at the syscall; Linux's private tmpfs can absorb a write instead.
    expect(o.OUT_W).toBe("0");
    expect(o.LINK_W).toBe("0");
    expect(o.TMP_W).toBe("0");
    expect(o.SYSTMP_W).toBe("0");
    expect(o.CHILD_OUT_W).toBe("0");
  }
  return o;
}

describe.skipIf(!available)(`the real kernel jail (${backend.mechanism})`, () => {
  it("claude: inside ok; outside, symlink-out, /tmp, system TMPDIR and child writes/reads all held; state read-only except projects/", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.toolHome, "projects"));
      writeFileSync(join(f.toolHome, "settings.json"), '{"fake":true}\n');
      writeFileSync(join(f.home, ".claude.json"), '{"fake":true}\n');
      writeFileSync(join(f.toolHome, "credentials.json"), '{"token":"FAKE"}\n');
      const bin = fakeTool(f, "claude", [
        `t STATE_R cat "${f.toolHome}/settings.json"`,
        `t CRED_R cat "${f.toolHome}/credentials.json"`,
        `t SETTINGS_W w "${f.toolHome}/settings.json"`,
        `t HOOKS_W w "${f.toolHome}/hooks.json"`,
        `t PLUGINS_W sh -c "mkdir -p '${f.toolHome}/plugins' && printf x > '${f.toolHome}/plugins/evil'"`,
        `t CLAUDEJSON_W w "${f.home}/.claude.json"`,
        `t PROJECTS_W sh -c "mkdir -p '${f.toolHome}/projects/slug' && printf x > '${f.toolHome}/projects/slug/session.jsonl'"`,
      ]);
      const res = await new ClaudeCodeLauncher(deps(f, bin)).run({ prompt: "probe", timeoutMs: 60_000 });
      const o = assertJailHeld(f, res);
      expect(res.sessionId).toBeTruthy();
      expect(o.ARGV).toContain(`--session-id ${res.sessionId}`);
      expect(o.ARGV).toContain('--settings {"sandbox":{"enabled":false}}');
      // The tool's own state: readable (login works), writable only under projects/.
      expect(o.STATE_R).toBe("1");
      expect(o.CRED_R).toBe("1");
      expect(o.PROJECTS_W).toBe("1");
      expect(existsSync(join(f.toolHome, "projects", "slug", "session.jsonl"))).toBe(true);
      expect(readFileSync(join(f.toolHome, "settings.json"), "utf8")).toBe('{"fake":true}\n');
      expect(readFileSync(join(f.home, ".claude.json"), "utf8")).toBe('{"fake":true}\n');
      expect(existsSync(join(f.toolHome, "hooks.json"))).toBe(false);
      expect(existsSync(join(f.toolHome, "plugins", "evil"))).toBe(false);
      if (platform === "darwin") {
        expect(o.SETTINGS_W).toBe("0");
        expect(o.HOOKS_W).toBe("0");
        expect(o.PLUGINS_W).toBe("0");
        expect(o.CLAUDEJSON_W).toBe("0");
      }
      expect(existsSync(join(f.root, "CLAUDE.md"))).toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  it("codex: the same matrix; state writable except the protected entries", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.toolHome, "config.toml"), 'model = "fake"\n');
      writeFileSync(join(f.toolHome, "hooks.json"), "{}\n");
      writeFileSync(join(f.toolHome, "auth.json"), '{"token":"FAKE"}\n');
      for (const d of ["plugins", "skills", "rules", "prompts", "hooks", "sessions"]) mkdirSync(join(f.toolHome, d));
      const bin = fakeTool(f, "codex", [
        `t AUTH_R cat "${f.toolHome}/auth.json"`,
        `t STATE_W w "${f.toolHome}/history.jsonl"`,
        `t SESSIONS_W w "${f.toolHome}/sessions/s.jsonl"`,
        ...CODEX_PROTECTED_STATE.map((e) =>
          e.includes(".") || e === "AGENTS.md"
            ? `t P_${e.replace(/\W/g, "_")} w "${f.toolHome}/${e}"`
            : `t P_${e} w "${f.toolHome}/${e}/evil"`,
        ),
      ]);
      const res = await new CodexLauncher(deps(f, bin)).run({ prompt: "probe", timeoutMs: 60_000 });
      const o = assertJailHeld(f, res);
      expect(o.ARGV).toBe("exec --sandbox danger-full-access --skip-git-repo-check probe");
      expect(o.AUTH_R).toBe("1");
      expect(o.STATE_W).toBe("1");
      expect(o.SESSIONS_W).toBe("1");
      expect(existsSync(join(f.toolHome, "history.jsonl"))).toBe(true);
      expect(readFileSync(join(f.toolHome, "config.toml"), "utf8")).toBe('model = "fake"\n');
      expect(readFileSync(join(f.toolHome, "hooks.json"), "utf8")).toBe("{}\n");
      expect(existsSync(join(f.toolHome, "AGENTS.md"))).toBe(false);
      for (const d of ["plugins", "skills", "rules", "prompts", "hooks"]) {
        expect(existsSync(join(f.toolHome, d, "evil"))).toBe(false);
        if (platform === "darwin") expect(o[`P_${d}`]).toBe("0");
      }
      if (platform === "darwin") {
        expect(o.P_config_toml).toBe("0");
        expect(o.P_hooks_json).toBe("0");
        expect(o.P_AGENTS_md).toBe("0");
      }
      expect(existsSync(join(f.root, "AGENTS.md"))).toBe(true);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  it("a cwd sub-dir keeps the ROOT as the jail: the tool runs in the sub-dir and can still reach the root", async () => {
    const f = fixture();
    try {
      const bin = fakeTool(f, "claude", [`t ROOT_R cat "${f.root}/seed.txt"`]);
      const res = await new ClaudeCodeLauncher(deps(f, bin)).run({ prompt: "p", cwd: "sub", timeoutMs: 60_000 });
      const o = assertJailHeld(f, res, join(f.root, "sub"));
      expect(o.ROOT_R).toBe("1");
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  it.skipIf(platform !== "darwin")("a PERMISSIVE profile fails the canary: the tool never runs (fail closed)", async () => {
    const f = fixture();
    try {
      const permissive = join(f.base, "permissive.sb");
      writeFileSync(permissive, "(version 1)\n(allow default)\n");
      const bin = fakeTool(f, "claude", []);
      const res = await new ClaudeCodeLauncher(deps(f, bin, { profilePath: permissive })).run({ prompt: "p", timeoutMs: 60_000 });
      expect(res.launched).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.isolation.enforced).toBe(false);
      expect(res.reason).toContain("OUTSIDE");
      expect(res.confinement.canary?.ok).toBe(false);
      expect(existsSync(join(f.root, "in.txt"))).toBe(false);
      // The canary cleaned up what it planted outside.
      expect(existsSync(join(f.base, "outside", "w"))).toBe(false);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

  it.skipIf(platform !== "darwin")("a BROKEN profile fails the canary with the wrapper's error: the tool never runs", async () => {
    const f = fixture();
    try {
      const broken = join(f.base, "broken.sb");
      writeFileSync(broken, "(version 1)\n(this is not a rule\n");
      const bin = fakeTool(f, "claude", []);
      const res = await new ClaudeCodeLauncher(deps(f, bin, { profilePath: broken })).run({ prompt: "p", timeoutMs: 60_000 });
      expect(res.launched).toBe(false);
      expect(res.reason).toContain("did not run");
      expect(existsSync(join(f.root, "in.txt"))).toBe(false);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(available)("no kernel jail backend on this host", () => {
  it("skips the real-kernel matrix (nothing to prove here)", () => {
    expect(available).toBe(false);
  });
});
