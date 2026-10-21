/**
 * The seatbelt profiles and the launcher table describe the same jail. A profile that
 * names a `-D` param the launcher never passes makes `sandbox-exec` refuse every launch
 * (the canary would catch it, one launch too late); a launcher that passes a param the
 * profile never reads grants nothing. Both profiles are parsed here against a real
 * launch's argv, and Claude Code's write grants are pinned to this run's transcript.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DarwinSandboxBackend, LinuxSandboxBackend, type SandboxSpec } from "@plexus/runtime/platform/sandbox-backend.ts";
import { CC_PRIVATE_STATE, CC_SESSION_PARAMS, CLAUDE_TOOL, ccProjectSlug, ClaudeCodeLauncher } from "@plexus/runtime/sources/claudecode/launcher.ts";
import { CodexLauncher } from "@plexus/runtime/sources/codex/launcher.ts";
import type { CaptureSpawn } from "@plexus/runtime/sources/exec-capture.ts";
import type { PrivateStateEntry } from "@plexus/runtime/sources/exec-isolation.ts";
import type { ExecLauncher } from "@plexus/runtime/sources/exec-launcher.ts";

const PROFILES = {
  claudecode: new URL("../packages/runtime/src/sources/claudecode/sandbox/cc-confine.sb", import.meta.url),
  codex: new URL("../packages/runtime/src/sources/codex/sandbox/codex-confine.sb", import.meta.url),
};

const capture: CaptureSpawn = async (spec) =>
  spec.args.includes("/bin/sh") ? { stdout: "IN=1\nW=0\nR=0\n", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 0 };

function launcher(kind: keyof typeof PROFILES): ExecLauncher {
  const deps = {
    authorizedDir: realpathSync(mkdtempSync(join(tmpdir(), "plexus-drift-"))),
    resolveBinary: async (n: string) => (n === "node" ? undefined : `/opt/bin/${n}`),
    rawCapture: capture,
    sandbox: new DarwinSandboxBackend({ exists: () => true }),
    homedir: "/home/owner",
    toolHome: realpathSync(mkdtempSync(join(tmpdir(), "plexus-drift-home-"))),
    policy: () => "jail" as const,
    realLaunch: () => true,
  };
  return kind === "claudecode" ? new ClaudeCodeLauncher(deps) : new CodexLauncher(deps);
}

const paramsReferenced = (profile: string) => new Set([...profile.matchAll(/\(param "([A-Z_]+)"\)/g)].map((m) => m[1]!));
const paramsPassed = (argv: string[]) => new Set(argv.filter((a, i) => argv[i - 1] === "-D").map((a) => a.split("=", 1)[0]!));

describe("each seatbelt profile reads exactly the params a real launch passes", () => {
  for (const kind of ["claudecode", "codex"] as const) {
    it(kind, async () => {
      const res = await launcher(kind).run({ prompt: "x" });
      expect(res.launched).toBe(true);
      expect([...paramsReferenced(readFileSync(PROFILES[kind], "utf8"))].sort()).toEqual([...paramsPassed(res.argv)].sort());
    });
  }
});

/** The profile's top-level forms (comments stripped), by balanced parentheses. */
function topLevelForms(profile: string): string[] {
  const src = profile.replace(/;[^\n]*/g, "");
  const forms: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) forms.push(src.slice(start, i + 1));
    }
  }
  return forms;
}

describe("cc-confine.sb grants writes under the tool home only at this run's transcript", () => {
  const writeGrants = topLevelForms(readFileSync(PROFILES.claudecode, "utf8")).filter((f) => /^\(allow [^(]*file-write\*/.test(f));

  it("one write grant names the session file (literal) and the session dir (subpath); none names TOOL_HOME or projects/", () => {
    const session = writeGrants.find((g) => g.includes(CC_SESSION_PARAMS.file));
    expect(session).toContain(`(literal (param "${CC_SESSION_PARAMS.file}"))`);
    expect(session).toContain(`(subpath (param "${CC_SESSION_PARAMS.dir}"))`);
    for (const g of writeGrants) {
      expect(g).not.toContain("/projects");
      expect(g.includes("TOOL_HOME")).toBe(false);
    }
  });

  it("the other write grants are the Keychain and the jail, nothing under the home", () => {
    const rest = writeGrants.filter((g) => !g.includes(CC_SESSION_PARAMS.file));
    expect(rest.map((g) => /\(param "([A-Z_]+)"\)/.exec(g)?.[1])).toEqual(["HOMEDIR", "JAIL"]);
    expect(rest.find((g) => g.includes("HOMEDIR"))).toContain("/Library/Keychains");
  });
});

/** The `TOOL_HOME/<name>` entries of a deny form, in order, typed by their filter. */
function deniedEntries(form: string): PrivateStateEntry[] {
  return [...form.matchAll(/\((subpath|literal) \(string-append \(param "TOOL_HOME"\) "\/([^"]+)"\)\)/g)].map((m) => ({
    name: m[2]!,
    kind: m[1] === "subpath" ? "dir" : "file",
  }));
}

describe("the owner's private Claude Code state is hidden by the same list on both platforms", () => {
  const forms = topLevelForms(readFileSync(PROFILES.claudecode, "utf8"));
  const denyReads = forms.filter((f) => f.startsWith("(deny file-read*"));

  it("cc-confine.sb denies reads of exactly CC_PRIVATE_STATE, in its order, dirs by subpath and files by literal", () => {
    expect(denyReads).toHaveLength(1);
    expect(deniedEntries(denyReads[0]!)).toEqual([...CC_PRIVATE_STATE]);
  });

  it("the re-grant of this run's transcript follows the deny (a later rule wins), and nothing else re-opens the home", () => {
    const denyAt = forms.indexOf(denyReads[0]!);
    const regrant = forms.findIndex((f) => f.startsWith("(allow file-read* file-write*") && f.includes(CC_SESSION_PARAMS.file));
    expect(regrant).toBeGreaterThan(denyAt);
    expect(forms.slice(denyAt + 1).filter((f) => f.startsWith("(allow") && f.includes("TOOL_HOME"))).toEqual([]);
  });

  it("bwrap: an empty tmpfs over each existing private dir and /dev/null over each file, before this run's slug is bound rw", () => {
    const toolHome = realpathSync(mkdtempSync(join(tmpdir(), "plexus-drift-cc-")));
    const seeded = ["projects", "file-history", "shell-snapshots"];
    for (const d of seeded) mkdirSync(join(toolHome, d));
    writeFileSync(join(toolHome, "history.jsonl"), "");
    const root = "/jail";
    const mounts = CLAUDE_TOOL.toolState({ toolHome, homedir: "/home/owner", root, cwd: root, sessionId: "sid", mechanism: "bwrap" });
    const spec: SandboxSpec = {
      innerCommand: "/bin/claude",
      innerArgs: [],
      jail: root,
      cwd: root,
      homedir: "/home/owner",
      toolHome,
      tmpdir: `${root}/.tmp`,
      network: true,
      profilePath: "",
      params: [],
      toolState: mounts,
    };
    const { args } = new LinuxSandboxBackend({ bwrapPath: "/usr/bin/bwrap", probe: () => "/usr/bin/bwrap" }).wrap(spec);
    const at = (flag: string, path: string) => args.findIndex((a, i) => a === flag && args[i + 1] === path);
    const slug = join(toolHome, "projects", ccProjectSlug(root));
    const hidden = mounts.filter((m) => m.access === "hidden").map((m) => m.path);
    expect(hidden).toEqual([
      ...["projects", "history.jsonl", "file-history", "shell-snapshots"].map((e) => join(toolHome, e)),
      join(slug, "memory"),
    ]);
    const slugAt = at("--bind-try", slug);
    expect(slugAt).toBeGreaterThan(0);
    for (const d of seeded) {
      expect(at("--tmpfs", join(toolHome, d))).toBeGreaterThan(at("--ro-bind-try", toolHome));
      expect(at("--tmpfs", join(toolHome, d))).toBeLessThan(slugAt);
    }
    const devnull = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/dev/null" && args[i + 2] === join(toolHome, "history.jsonl"));
    expect(devnull).toBeGreaterThan(at("--ro-bind-try", toolHome));
    expect(devnull).toBeLessThan(slugAt);
    expect(at("--tmpfs", join(slug, "memory"))).toBeGreaterThan(slugAt);
    rmSync(toolHome, { recursive: true, force: true });
  });
});
