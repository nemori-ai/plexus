import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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

import { ccProjectSlug, ClaudeCodeLauncher } from "@plexus/runtime/sources/claudecode/launcher.ts";
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
    'echo "LEAK=$PLEXUS_JOIN_TOKEN$OWNER_EXPORTED_SECRET"',
    'echo "HAS_PATH=${PATH:+1}"',
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

function assertJailHeld(f: Fixture, res: ExecRunResult, cwd = f.root): Record<string, string> {
  expect({ launched: res.launched, ok: res.ok, reason: res.reason, canary: res.confinement.canary }).toMatchObject({
    launched: true,
    ok: true,
    reason: undefined,
  });
  expect(res.isolation).toMatchObject({ policy: "jail", mechanism: backend.mechanism, enforced: true });
  expect(res.confinement.canary?.ok).toBe(true);
  const o = flags(res.output);
  expect(o.IN_W).toBe("1");
  expect(o.IN_R).toBe("1");
  expect(o.SUB_W).toBe("1");
  expect(o.t_tmpdir_w).toBe("1");
  expect(o.CHILD_IN_W).toBe("1");
  expect(o.TMPDIR).toBe(join(f.root, ".tmp"));
  expect(o.LEAK).toBe("");
  expect(o.HAS_PATH).toBe("1");
  expect(o.CWD).toBe(cwd);
  expect(res.jail).toBe(cwd);
  expect(existsSync(join(f.root, "in.txt"))).toBe(true);
  expect(existsSync(join(f.root, ".tmp", "ok.txt"))).toBe(true);
  expect(existsSync(join(f.outside, "w.txt"))).toBe(false);
  expect(existsSync(join(f.outside, "w2.txt"))).toBe(false);
  expect(existsSync(join(f.outside, "child.txt"))).toBe(false);
  expect(existsSync(`/tmp/plexus-kernel-leak-${f.nonce}`)).toBe(false);
  expect(existsSync(join(SYSTMP, `plexus-kernel-leak-${f.nonce}`))).toBe(false);
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
  // Gateway-only secrets, set for the whole matrix: no run may see them (the LEAK probe).
  beforeAll(() => {
    process.env.PLEXUS_JOIN_TOKEN = "fake-join-token-canary";
    process.env.OWNER_EXPORTED_SECRET = "fake-owner-secret";
  });
  afterAll(() => {
    delete process.env.PLEXUS_JOIN_TOKEN;
    delete process.env.OWNER_EXPORTED_SECRET;
  });

  it("claude: inside ok; outside, symlink-out, /tmp, system TMPDIR and child writes/reads all held; state read-only except this run's transcript", async () => {
    const f = fixture();
    try {
      const projects = join(f.toolHome, "projects");
      const thisSlug = join(projects, ccProjectSlug(f.root));
      const otherSlug = join(projects, "-Users-owner-Codes-other");
      for (const d of [join(thisSlug, "memory"), join(otherSlug, "memory")]) mkdirSync(d, { recursive: true });
      writeFileSync(join(thisSlug, "memory", "MEMORY.md"), "# this\n");
      writeFileSync(join(otherSlug, "memory", "MEMORY.md"), "# other\n");
      writeFileSync(join(otherSlug, "11111111-1111-4111-8111-111111111111.jsonl"), '{"owner":"session"}\n');
      writeFileSync(join(f.toolHome, "settings.json"), '{"fake":true}\n');
      writeFileSync(join(f.home, ".claude.json"), '{"fake":true}\n');
      writeFileSync(join(f.toolHome, "credentials.json"), '{"token":"FAKE"}\n');
      const bin = fakeTool(f, "claude", [
        `sid=$(printf '%s\\n' "$@" | awk '/^--session-id$/{getline; print}')`,
        `t STATE_R cat "${f.toolHome}/settings.json"`,
        `t CRED_R cat "${f.toolHome}/credentials.json"`,
        `t SETTINGS_W w "${f.toolHome}/settings.json"`,
        `t HOOKS_W w "${f.toolHome}/hooks.json"`,
        `t PLUGINS_W sh -c "mkdir -p '${f.toolHome}/plugins' && printf x > '${f.toolHome}/plugins/evil'"`,
        `t CLAUDEJSON_W w "${f.home}/.claude.json"`,
        `t SESSION_W sh -c "printf '{\\"line\\":1}' > '${thisSlug}/'\\"$sid\\"'.jsonl'"`,
        `t SESSION_DIR_W sh -c "mkdir -p '${thisSlug}/'\\"$sid\\"'/subagents' && printf x > '${thisSlug}/'\\"$sid\\"'/subagents/a.jsonl'"`,
        `t THIS_MEMORY_W w "${thisSlug}/memory/MEMORY.md"`,
        `t THIS_MEMORY_NEW_W w "${thisSlug}/memory/notes.md"`,
        `t OTHER_MEMORY_W w "${otherSlug}/memory/MEMORY.md"`,
        `t OTHER_SLUG_SESSION_W w "${otherSlug}/11111111-1111-4111-8111-111111111111.jsonl"`,
        `t OTHER_SLUG_NEW_W w "${otherSlug}/22222222-2222-4222-8222-222222222222.jsonl"`,
        `t SAME_SLUG_OTHER_SESSION_W w "${thisSlug}/33333333-3333-4333-8333-333333333333.jsonl"`,
      ]);
      const res = await new ClaudeCodeLauncher(deps(f, bin)).run({ prompt: "probe", timeoutMs: 60_000 });
      const o = assertJailHeld(f, res);
      expect(res.sessionId).toBeTruthy();
      expect(o.ARGV).toContain(`--session-id ${res.sessionId}`);
      expect(o.ARGV).toContain('--settings {"sandbox":{"enabled":false}}');
      expect(o.STATE_R).toBe("1");
      expect(o.CRED_R).toBe("1");
      expect(o.SESSION_W).toBe("1");
      expect(o.SESSION_DIR_W).toBe("1");
      expect(readFileSync(join(thisSlug, `${res.sessionId}.jsonl`), "utf8")).toBe('{"line":1}');
      expect(existsSync(join(thisSlug, res.sessionId!, "subagents", "a.jsonl"))).toBe(true);
      expect(readFileSync(join(thisSlug, "memory", "MEMORY.md"), "utf8")).toBe("# this\n");
      expect(readFileSync(join(otherSlug, "memory", "MEMORY.md"), "utf8")).toBe("# other\n");
      expect(existsSync(join(thisSlug, "memory", "notes.md"))).toBe(false);
      expect(readFileSync(join(otherSlug, "11111111-1111-4111-8111-111111111111.jsonl"), "utf8")).toBe('{"owner":"session"}\n');
      expect(existsSync(join(otherSlug, "22222222-2222-4222-8222-222222222222.jsonl"))).toBe(false);
      expect(readFileSync(join(f.toolHome, "settings.json"), "utf8")).toBe('{"fake":true}\n');
      expect(readFileSync(join(f.home, ".claude.json"), "utf8")).toBe('{"fake":true}\n');
      expect(existsSync(join(f.toolHome, "hooks.json"))).toBe(false);
      expect(existsSync(join(f.toolHome, "plugins", "evil"))).toBe(false);
      if (platform === "darwin") {
        expect(o.SETTINGS_W).toBe("0");
        expect(o.HOOKS_W).toBe("0");
        expect(o.PLUGINS_W).toBe("0");
        expect(o.CLAUDEJSON_W).toBe("0");
        expect(o.THIS_MEMORY_W).toBe("0");
        expect(o.THIS_MEMORY_NEW_W).toBe("0");
        expect(o.OTHER_MEMORY_W).toBe("0");
        expect(o.OTHER_SLUG_SESSION_W).toBe("0");
        expect(o.OTHER_SLUG_NEW_W).toBe("0");
        // The seatbelt grants the transcript by literal path; bwrap can only bind the slug dir
        // (docs/design/linux-confinement.md), so this one is macOS-only.
        expect(o.SAME_SLUG_OTHER_SESSION_W).toBe("0");
        expect(existsSync(join(thisSlug, "33333333-3333-4333-8333-333333333333.jsonl"))).toBe(false);
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
      for (const db of ["memories_1.sqlite", "memories_1.sqlite-wal", "goals_1.sqlite", "state_5.sqlite"]) {
        writeFileSync(join(f.toolHome, db), "FAKE-DB\n");
      }
      for (const d of ["plugins", "skills", "rules", "prompts", "hooks", "sessions"]) mkdirSync(join(f.toolHome, d));
      const bin = fakeTool(f, "codex", [
        `t AUTH_R cat "${f.toolHome}/auth.json"`,
        `t STATE_W w "${f.toolHome}/history.jsonl"`,
        `t SESSIONS_W w "${f.toolHome}/sessions/s.jsonl"`,
        `t STATE_DB_W w "${f.toolHome}/state_5.sqlite"`,
        `t MEMORIES_R cat "${f.toolHome}/memories_1.sqlite"`,
        `t MEMORIES_W w "${f.toolHome}/memories_1.sqlite"`,
        `t MEMORIES_WAL_W w "${f.toolHome}/memories_1.sqlite-wal"`,
        `t MEMORIES_SHM_NEW_W w "${f.toolHome}/memories_1.sqlite-shm"`,
        `t MEMORIES_NEXT_NEW_W w "${f.toolHome}/memories_2.sqlite"`,
        `t GOALS_W w "${f.toolHome}/goals_1.sqlite"`,
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
      expect(o.STATE_DB_W).toBe("1");
      expect(o.MEMORIES_R).toBe("1");
      expect(readFileSync(join(f.toolHome, "memories_1.sqlite"), "utf8")).toBe("FAKE-DB\n");
      expect(readFileSync(join(f.toolHome, "memories_1.sqlite-wal"), "utf8")).toBe("FAKE-DB\n");
      expect(readFileSync(join(f.toolHome, "goals_1.sqlite"), "utf8")).toBe("FAKE-DB\n");
      if (platform === "darwin") {
        expect(o.MEMORIES_W).toBe("0");
        expect(o.MEMORIES_WAL_W).toBe("0");
        expect(o.GOALS_W).toBe("0");
        // The seatbelt denies the whole family by regex; bwrap can only bind the files that
        // exist, so a new -shm or a next-version store stays creatable on Linux (the gap).
        expect(o.MEMORIES_SHM_NEW_W).toBe("0");
        expect(o.MEMORIES_NEXT_NEW_W).toBe("0");
        expect(existsSync(join(f.toolHome, "memories_2.sqlite"))).toBe(false);
      }
      expect(readFileSync(join(f.toolHome, "config.toml"), "utf8")).toBe('model = "fake"\n');
      expect(readFileSync(join(f.toolHome, "hooks.json"), "utf8")).toBe("{}\n");
      // bwrap can only ro-bind an existing node, so on linux an absent protected file is
      // still creatable (docs/design/linux-confinement.md, "Known Linux gap").
      expect(existsSync(join(f.toolHome, "AGENTS.md"))).toBe(platform !== "darwin");
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
