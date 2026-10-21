/**
 * The seatbelt profiles and the launcher table describe the same jail. A profile that
 * names a `-D` param the launcher never passes makes `sandbox-exec` refuse every launch
 * (the canary would catch it, one launch too late); a launcher that passes a param the
 * profile never reads grants nothing. Both profiles are parsed here against a real
 * launch's argv, and Claude Code's write grants are pinned to this run's transcript.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DarwinSandboxBackend } from "@plexus/runtime/platform/sandbox-backend.ts";
import { CC_SESSION_PARAMS, ClaudeCodeLauncher } from "@plexus/runtime/sources/claudecode/launcher.ts";
import { CodexLauncher } from "@plexus/runtime/sources/codex/launcher.ts";
import type { CaptureSpawn } from "@plexus/runtime/sources/exec-capture.ts";
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
