/**
 * exec-isolation — the shared contract behind claudecode.run / codex.run.
 *
 *  (a) the report builders: jail enforced/not, host never enforced; a junk policy reads as jail.
 *  (b) the read-only grants the jail needs to exec the tool: a native binary, a symlinked
 *      binary, an npm wrapper script (`#!/usr/bin/env node` ⇒ node's dir + the enclosing
 *      node_modules), an absolute-shebang script; unresolvable ⇒ the jail (a no-op grant).
 *  (c) the canary judges from the host side: the "outside" write must not land, the read
 *      must fail, the inside write must succeed; it cleans up; the wrap it uses is the one
 *      it was handed, with `/bin/sh -c <script>` inside.
 *  (d) `launchArgv`: the unwrapped argv needs the literal `"host"`.
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANARY_SCRIPT,
  HOST_ISOLATION,
  isExecPolicy,
  jailIsolation,
  resolveToolBinaryDirs,
  runJailCanary,
  shebangInterpreter,
  TOOL_DIR_PARAMS,
} from "@plexus/runtime/sources/exec-isolation.ts";
import { launchArgv } from "@plexus/runtime/sources/exec-launcher.ts";
import type { CaptureSpawn } from "@plexus/runtime/sources/exec-capture.ts";
import type { SandboxBackend } from "@plexus/runtime/platform/sandbox-backend.ts";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("(a) the isolation report", () => {
  it("jail: mechanism + fixed scope; enforced is whatever the launch outcome says", () => {
    expect(jailIsolation("sandbox-exec", true)).toEqual({
      policy: "jail",
      mechanism: "sandbox-exec",
      scope: { files: "authorized-dir", temp: "authorized-dir", network: "open", toolState: "own-config-read-only" },
      enforced: true,
    });
    expect(jailIsolation("bwrap", false).enforced).toBe(false);
  });

  it("host: mechanism none, host-user scope, never enforced", () => {
    expect(HOST_ISOLATION).toEqual({
      policy: "host",
      mechanism: "none",
      scope: { files: "host-user", temp: "host-user", network: "open", toolState: "host-user" },
      enforced: false,
    });
  });

  it("only the two policy words parse", () => {
    expect(isExecPolicy("jail")).toBe(true);
    expect(isExecPolicy("host")).toBe(true);
    expect(isExecPolicy("HOST")).toBe(false);
    expect(isExecPolicy("")).toBe(false);
    expect(isExecPolicy(undefined)).toBe(false);
  });
});

describe("(b) the read-only grants for the tool binary", () => {
  const noPath = async () => undefined;

  it("a native binary: its dir only (never a parent: `~/bin/x` must not grant `~`), no interpreter (⇒ the jail)", async () => {
    const root = tmp("plexus-bin-");
    mkdirSync(join(root, "claude", "versions"), { recursive: true });
    const bin = join(root, "claude", "versions", "2.1.306");
    writeFileSync(bin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    chmodSync(bin, 0o755);
    const dirs = await resolveToolBinaryDirs(bin, { resolveOnPath: noPath, fallback: "/jail" });
    expect(dirs).toEqual({ bin: join(root, "claude", "versions"), pkg: join(root, "claude", "versions"), interp: "/jail" });
    rmSync(root, { recursive: true, force: true });
  });

  it("a symlinked binary resolves through the link (the grant must cover the real file, not the link's dir)", async () => {
    const root = tmp("plexus-bin-");
    mkdirSync(join(root, "share", "claude", "versions"), { recursive: true });
    mkdirSync(join(root, "bin"));
    const real = join(root, "share", "claude", "versions", "2.1.306");
    writeFileSync(real, "binary");
    symlinkSync(real, join(root, "bin", "claude"));
    const dirs = await resolveToolBinaryDirs(join(root, "bin", "claude"), { resolveOnPath: noPath, fallback: "/jail" });
    expect(dirs.bin).toBe(join(root, "share", "claude", "versions"));
    expect(dirs.pkg).toBe(dirs.bin);
    rmSync(root, { recursive: true, force: true });
  });

  it("an npm wrapper (`#!/usr/bin/env node`): node's REAL dir + the ENCLOSING node_modules", async () => {
    const root = tmp("plexus-bin-");
    const pkgBin = join(root, "lib", "node_modules", "@openai", "codex", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const script = join(pkgBin, "codex.js");
    writeFileSync(script, "#!/usr/bin/env node\nconsole.log('hi')\n");
    mkdirSync(join(root, "bin"));
    symlinkSync(script, join(root, "bin", "codex"));
    // node lives under nvm (a symlink farm): the grant must be the realpath dir.
    mkdirSync(join(root, "nvm", "v22", "bin"), { recursive: true });
    writeFileSync(join(root, "nvm", "v22", "bin", "node"), "node");
    const dirs = await resolveToolBinaryDirs(join(root, "bin", "codex"), {
      resolveOnPath: async (n) => (n === "node" ? join(root, "nvm", "v22", "bin", "node") : undefined),
      fallback: "/jail",
    });
    expect(dirs).toEqual({
      bin: pkgBin,
      pkg: join(root, "lib", "node_modules"),
      interp: join(root, "nvm", "v22", "bin"),
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("an absolute-shebang script names its interpreter directly; an unresolvable one yields the jail", async () => {
    const root = tmp("plexus-bin-");
    const tool = join(root, "tool");
    writeFileSync(tool, "#!/bin/bash\necho hi\n");
    expect((await resolveToolBinaryDirs(tool, { resolveOnPath: noPath, fallback: "/jail" })).interp).toBe("/bin");
    const envTool = join(root, "tool2");
    writeFileSync(envTool, "#!/usr/bin/env ruby\nputs 1\n");
    expect((await resolveToolBinaryDirs(envTool, { resolveOnPath: noPath, fallback: "/jail" })).interp).toBe("/jail");
    rmSync(root, { recursive: true, force: true });
  });

  it("shebang parsing: env form, direct form, env with a flag, no shebang", () => {
    expect(shebangInterpreter("#!/usr/bin/env node\n")).toEqual({ name: "node" });
    expect(shebangInterpreter("#!/usr/bin/env -S node --x\n")).toEqual({ path: "/usr/bin/env" });
    expect(shebangInterpreter("#!/bin/sh\n")).toEqual({ path: "/bin/sh" });
    expect(shebangInterpreter("console.log(1)")).toBeUndefined();
  });

  it("the three param names the profiles reference are exactly the three dirs", () => {
    expect(TOOL_DIR_PARAMS.map((p) => p.name)).toEqual(["TOOL_BIN_DIR", "TOOL_PKG_DIR", "TOOL_INTERP_DIR"]);
  });
});

describe("(c) the canary", () => {
  const passThroughWrap = (inner: { command: string; args: string[] }) => ({ command: "/wrap", args: ["--", inner.command, ...inner.args] });

  function captureThat(behave: (paths: { inside: string; outsideWrite: string; outsideRead: string }) => { stdout: string; exitCode?: number; writeOutside?: boolean }): CaptureSpawn {
    return async (spec) => {
      const i = spec.args.indexOf("plexus-canary");
      const paths = { inside: spec.args[i + 1]!, outsideWrite: spec.args[i + 2]!, outsideRead: spec.args[i + 3]! };
      const b = behave(paths);
      if (b.writeOutside) writeFileSync(paths.outsideWrite, "x");
      return { stdout: b.stdout, stderr: "", exitCode: b.exitCode ?? 0 };
    };
  }

  it("passes only when the inside write worked, nothing landed outside, and the outside read failed; cleans up", async () => {
    const root = tmp("plexus-canary-root-");
    const outside = tmp("plexus-canary-out-");
    mkdirSync(join(root, ".tmp"));
    let seen: { command: string; args: string[] } | undefined;
    const res = await runJailCanary({
      wrap: (inner) => {
        seen = inner;
        return passThroughWrap(inner);
      },
      root,
      tmpdir: join(root, ".tmp"),
      cwd: root,
      env: { TMPDIR: join(root, ".tmp") },
      outsideDir: outside,
      capture: captureThat(() => ({ stdout: "IN=1\nW=0\nR=0\n" })),
    });
    expect(res).toMatchObject({ ok: true, exitCode: 0, insideWrite: true, outsideWriteLanded: false, outsideReadSucceeded: false });
    expect(seen?.command).toBe("/bin/sh");
    expect(seen?.args.slice(0, 2)).toEqual(["-c", CANARY_SCRIPT]);
    expect(seen?.args[3]!.startsWith(join(root, ".tmp"))).toBe(true);
    expect(seen?.args[4]!.startsWith(outside)).toBe(true);
    // The outside dir (with the planted secret) is gone after the canary.
    expect(existsSync(outside)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("the host-side check catches a write that landed outside even when the script said W=0", async () => {
    const root = tmp("plexus-canary-root-");
    const outside = tmp("plexus-canary-out-");
    const res = await runJailCanary({
      wrap: passThroughWrap,
      root,
      tmpdir: root,
      cwd: root,
      env: {},
      outsideDir: outside,
      capture: captureThat(() => ({ stdout: "IN=1\nW=0\nR=0\n", writeOutside: true })),
    });
    expect(res.ok).toBe(false);
    expect(res.outsideWriteLanded).toBe(true);
    expect(res.reason).toContain("wrote OUTSIDE");
    rmSync(root, { recursive: true, force: true });
  });

  it("an outside read that succeeded fails it; a non-zero exit fails it with the stderr tail", async () => {
    const root = tmp("plexus-canary-root-");
    const read = await runJailCanary({
      wrap: passThroughWrap, root, tmpdir: root, cwd: root, env: {}, outsideDir: tmp("plexus-canary-out-"),
      capture: captureThat(() => ({ stdout: "IN=1\nW=0\nR=1\n" })),
    });
    expect(read.ok).toBe(false);
    expect(read.reason).toContain("read a file OUTSIDE");
    const crashed = await runJailCanary({
      wrap: passThroughWrap, root, tmpdir: root, cwd: root, env: {}, outsideDir: tmp("plexus-canary-out-"),
      capture: async () => ({ stdout: "", stderr: "bwrap: No permissions to create new namespace", exitCode: 1 }),
    });
    expect(crashed.ok).toBe(false);
    expect(crashed.exitCode).toBe(1);
    expect(crashed.reason).toContain("No permissions to create new namespace");
    const threw = await runJailCanary({
      wrap: passThroughWrap, root, tmpdir: root, cwd: root, env: {}, outsideDir: tmp("plexus-canary-out-"),
      capture: async () => { throw new Error("ENOENT: no such wrapper"); },
    });
    expect(threw.ok).toBe(false);
    expect(threw.reason).toContain("could not start");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("(d) launchArgv", () => {
  const backend: SandboxBackend = {
    mechanism: "sandbox-exec",
    isAvailableSync: () => true,
    wrap: (s) => ({ command: "/usr/bin/sandbox-exec", args: ["-f", s.profilePath, s.innerCommand, ...s.innerArgs] }),
  };
  it("jail wraps; the unwrapped argv is only reachable with policy: \"host\"", () => {
    const jailed = launchArgv({
      policy: "jail",
      backend,
      spec: { innerCommand: "/t", innerArgs: ["a"], jail: "/j", homedir: "/h", toolHome: "/h/.t", tmpdir: "/j/.tmp", network: true, profilePath: "/p.sb", params: [] },
    });
    expect(jailed).toEqual({ command: "/usr/bin/sandbox-exec", args: ["-f", "/p.sb", "/t", "a"] });
    expect(launchArgv({ policy: "host", command: "/t", args: ["a"] })).toEqual({ command: "/t", args: ["a"] });
  });
});
