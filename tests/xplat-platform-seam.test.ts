/**
 * xplat — cross-platform platform-seam (Linux + Windows impls of PlatformServices).
 *
 * The Linux/Windows code paths can never actually EXECUTE on this macOS dev box, so
 * the platform-specific LOGIC is factored into pure functions that take injected
 * env / shell-probe output / fs probes. These tests drive that pure logic with
 * fixtures and assert behavior deterministically — no real subprocess, no real disk,
 * no `process.platform` dependence. (Real on-OS validation of the live impls is
 * deferred — noted in linux.ts / win32.ts.)
 */

import { describe, it, expect } from "bun:test";
import { delimiter } from "node:path";

import {
  KNOWN_SERVICES,
  locateLocalServiceWith,
  resolveSecretFrom,
  secretsBaseDir,
  type SecretFs,
} from "@plexus/runtime/platform/shared.ts";
import {
  LINUX_PATH_PROBE_CMD,
  parseProbedPath,
  buildLinuxFallbackPath,
  buildEnrichedLinuxPath,
  resolveBinaryOnPath,
} from "@plexus/runtime/platform/linux-path.ts";
import {
  DEFAULT_PATHEXT,
  parsePathExt,
  buildWin32FallbackPath,
  buildEnrichedWin32Path,
  resolveBinaryWin32,
  quoteWinArg,
  buildWin32SpawnPlan,
} from "@plexus/runtime/platform/win32-path.ts";

// Helper: make a `DirExists`/`FileExists` from an allow-list of paths.
const existsFromSet = (set: Set<string>) => (p: string) => set.has(p);

// Windows PATH delimiter is `;` regardless of the host OS; the win32 logic pins the
// win32 path namespace, so tests must build Windows PATHs with `;` (not the host's
// `delimiter`, which is `:` on the macOS dev box).
const WIN = ";";

// ===========================================================================
// SHARED: secret-store resolution (injected fs) — OS-independent.
// ===========================================================================

describe("xplat shared: resolveSecretFrom (injected fs, no real disk)", () => {
  const mkFs = (files: Record<string, string>): SecretFs => ({
    exists: (p) => p in files,
    read: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p]!;
    },
  });

  it("reads a per-secret file and trims it", () => {
    const fs = mkFs({ "/base/obsidian-rest-api-key": "  token-abc\n" });
    expect(resolveSecretFrom("obsidian-rest-api-key", "/base", fs)).toBe("token-abc");
  });

  it("falls back to the consolidated secrets.json map", () => {
    const fs = mkFs({ "/base/secrets.json": JSON.stringify({ "k": "v-from-map" }) });
    expect(resolveSecretFrom("k", "/base", fs)).toBe("v-from-map");
  });

  it("returns undefined when neither file nor map has the secret", () => {
    const fs = mkFs({ "/base/secrets.json": JSON.stringify({ other: "x" }) });
    expect(resolveSecretFrom("missing", "/base", fs)).toBeUndefined();
  });

  it("returns undefined on malformed secrets.json instead of throwing", () => {
    const fs = mkFs({ "/base/secrets.json": "{ not json" });
    expect(resolveSecretFrom("k", "/base", fs)).toBeUndefined();
  });

  it("secretsBaseDir honors PLEXUS_HOME override", () => {
    expect(secretsBaseDir({ PLEXUS_HOME: "/custom/home" } as NodeJS.ProcessEnv)).toBe(
      "/custom/home/secrets",
    );
  });
});

// ===========================================================================
// SHARED: locateLocalService over an injected probe — OS-independent.
// ===========================================================================

describe("xplat shared: locateLocalServiceWith (injected probe)", () => {
  it("returns the first reachable known-service port with its secretRef", async () => {
    // obsidian profile = ports [27124, 27123]; make only 27123 reachable.
    const probe = async (_h: string, port: number) => port === 27123;
    const loc = await locateLocalServiceWith({ app: "obsidian" }, probe);
    expect(loc).toEqual({
      kind: "http",
      address: "https://127.0.0.1:27123",
      secretRef: "obsidian-rest-api-key",
    });
  });

  it("prefers the hint.defaultPort ahead of the profile ports", async () => {
    const probe = async () => true; // everything reachable → first candidate wins
    const loc = await locateLocalServiceWith({ app: "obsidian", defaultPort: 9999 }, probe);
    expect(loc?.address).toBe("https://127.0.0.1:9999");
  });

  it("returns undefined when nothing is reachable", async () => {
    const probe = async () => false;
    expect(await locateLocalServiceWith({ app: "obsidian" }, probe)).toBeUndefined();
  });

  it("KNOWN_SERVICES carries the obsidian profile (table is OS-neutral)", () => {
    expect(KNOWN_SERVICES.obsidian?.ports).toContain(27124);
  });
});

// ===========================================================================
// LINUX: PATH enrichment + binary resolution (injected shell-probe / env / fs).
// ===========================================================================

describe("xplat linux: parseProbedPath", () => {
  it("extracts PATH from the marker-wrapped login-shell stdout", () => {
    const out = `some banner\n___PATH_START___/usr/bin:/bin___PATH_END___\n`;
    expect(parseProbedPath(out)).toBe("/usr/bin:/bin");
  });
  it("returns undefined when the markers are absent or input empty", () => {
    expect(parseProbedPath("no markers here")).toBeUndefined();
    expect(parseProbedPath(undefined)).toBeUndefined();
  });
  it("probe command uses the documented marker framing", () => {
    expect(LINUX_PATH_PROBE_CMD).toContain("___PATH_START___");
    expect(LINUX_PATH_PROBE_CMD).toContain("$PATH");
  });
});

describe("xplat linux: buildLinuxFallbackPath (injected exists)", () => {
  it("keeps only existing canonical dirs, deduped, in order", () => {
    const present = new Set(["/usr/local/bin", "/usr/bin", "/home/u/.local/bin"]);
    const out = buildLinuxFallbackPath("/home/u", existsFromSet(present), {} as NodeJS.ProcessEnv);
    expect(out.split(delimiter)).toEqual(["/usr/local/bin", "/usr/bin", "/home/u/.local/bin"]);
  });
  it("honors NVM_DIR override for the node-versions dir", () => {
    const present = new Set(["/custom/nvm/versions/node"]);
    const out = buildLinuxFallbackPath(
      "/home/u",
      existsFromSet(present),
      { NVM_DIR: "/custom/nvm" } as NodeJS.ProcessEnv,
    );
    expect(out).toContain("/custom/nvm/versions/node");
  });
});

describe("xplat linux: buildEnrichedLinuxPath (injected probe/env/fs)", () => {
  it("uses the login-shell PATH and merges process PATH, deduped order-preserving", () => {
    const out = buildEnrichedLinuxPath({
      probe: () => `___PATH_START___/opt/bin:/usr/bin___PATH_END___`,
      home: "/home/u",
      exists: () => true,
      env: { PATH: "/usr/bin:/extra" } as NodeJS.ProcessEnv,
    });
    expect(out.split(delimiter)).toEqual(["/opt/bin", "/usr/bin", "/extra"]);
  });

  it("falls back to candidate dirs when the shell probe fails", () => {
    const present = new Set(["/usr/local/bin", "/usr/bin"]);
    const out = buildEnrichedLinuxPath({
      probe: () => undefined, // probe failed
      home: "/home/u",
      exists: existsFromSet(present),
      env: { PATH: "" } as NodeJS.ProcessEnv,
    });
    expect(out.split(delimiter)).toEqual(["/usr/local/bin", "/usr/bin"]);
  });
});

describe("xplat linux: resolveBinaryOnPath (which-equivalent, injected fs)", () => {
  const PATH = ["/usr/local/bin", "/usr/bin"].join(delimiter);

  it("finds a bare name in the first PATH dir that has it", () => {
    const present = new Set(["/usr/bin/git"]);
    expect(resolveBinaryOnPath("git", PATH, existsFromSet(present))).toBe("/usr/bin/git");
  });
  it("prefers the earlier PATH dir when both have the binary", () => {
    const present = new Set(["/usr/local/bin/git", "/usr/bin/git"]);
    expect(resolveBinaryOnPath("git", PATH, existsFromSet(present))).toBe("/usr/local/bin/git");
  });
  it("returns undefined when the binary is nowhere on PATH", () => {
    expect(resolveBinaryOnPath("nope", PATH, () => false)).toBeUndefined();
  });
  it("passes through an existing absolute path", () => {
    expect(resolveBinaryOnPath("/opt/tool", PATH, existsFromSet(new Set(["/opt/tool"])))).toBe(
      "/opt/tool",
    );
  });
  it("does not treat a relative slashed name as a PATH lookup", () => {
    expect(resolveBinaryOnPath("foo/bar", PATH, () => true)).toBeUndefined();
  });
});

// ===========================================================================
// WINDOWS: PATHEXT resolution + .cmd spawn arg-construction (injected env / fs).
// THE biggest Windows gotchas live here.
// ===========================================================================

describe("xplat win32: parsePathExt", () => {
  it("parses + normalizes (lowercase, dedup) PATHEXT from env", () => {
    const exts = parsePathExt({ PATHEXT: ".EXE;.CMD;.exe;.BAT" } as NodeJS.ProcessEnv);
    expect(exts).toEqual([".exe", ".cmd", ".bat"]);
  });
  it("uses a sane default when PATHEXT is unset", () => {
    const exts = parsePathExt({} as NodeJS.ProcessEnv);
    expect(exts).toContain(".exe");
    expect(exts).toContain(".cmd");
    expect(DEFAULT_PATHEXT).toContain(".CMD");
  });
});

describe("xplat win32: buildWin32FallbackPath / buildEnrichedWin32Path (injected fs/env)", () => {
  it("includes System32 + Git cmd when present, deduped case-insensitively", () => {
    const present = new Set([
      "C:\\Windows\\System32",
      "C:\\Program Files\\Git\\cmd",
    ]);
    const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" } as NodeJS.ProcessEnv;
    const out = buildWin32FallbackPath("C:\\Users\\u", existsFromSet(present), env);
    expect(out).toContain("C:\\Windows\\System32");
    expect(out).toContain("C:\\Program Files\\Git\\cmd");
  });

  it("merges process PATH first, then fallback dirs, deduping case-insensitively", () => {
    const present = new Set(["C:\\Windows\\System32"]);
    const env = {
      PATH: ["C:\\bin", "c:\\windows\\system32"].join(WIN),
      SystemRoot: "C:\\Windows",
    } as NodeJS.ProcessEnv;
    const out = buildEnrichedWin32Path({
      home: "C:\\Users\\u",
      exists: existsFromSet(present),
      env,
    });
    const parts = out.split(WIN);
    // The lowercased System32 from PATH wins; the fallback's cased copy is deduped out.
    expect(parts).toContain("C:\\bin");
    expect(parts.filter((p) => p.toLowerCase() === "c:\\windows\\system32").length).toBe(1);
  });
});

describe("xplat win32: resolveBinaryWin32 (where-equivalent, PATHEXT-aware)", () => {
  const PATH = ["C:\\bin", "C:\\tools"].join(WIN);
  const exts = [".exe", ".cmd", ".bat", ".ps1"];

  it("resolves a bare name to <name>.exe via PATHEXT", () => {
    const present = new Set(["C:\\bin\\git.exe"]);
    expect(resolveBinaryWin32("git", PATH, exts, existsFromSet(present))).toBe("C:\\bin\\git.exe");
  });

  it("falls through PATHEXT precedence: .exe missing -> finds .cmd", () => {
    const present = new Set(["C:\\tools\\bun.cmd"]);
    expect(resolveBinaryWin32("bun", PATH, exts, existsFromSet(present))).toBe("C:\\tools\\bun.cmd");
  });

  it("honors PATHEXT order: .exe wins over .cmd in the same dir", () => {
    const present = new Set(["C:\\bin\\tool.exe", "C:\\bin\\tool.cmd"]);
    expect(resolveBinaryWin32("tool", PATH, exts, existsFromSet(present))).toBe("C:\\bin\\tool.exe");
  });

  it("respects an explicit extension already on the name", () => {
    const present = new Set(["C:\\bin\\npm.cmd"]);
    expect(resolveBinaryWin32("npm.cmd", PATH, exts, existsFromSet(present))).toBe(
      "C:\\bin\\npm.cmd",
    );
  });

  it("passes through an absolute path, applying PATHEXT when extensionless", () => {
    const present = new Set(["C:\\opt\\app.exe"]);
    expect(resolveBinaryWin32("C:\\opt\\app", PATH, exts, existsFromSet(present))).toBe(
      "C:\\opt\\app.exe",
    );
  });

  it("returns undefined when nothing matches across dirs/extensions", () => {
    expect(resolveBinaryWin32("ghost", PATH, exts, () => false)).toBeUndefined();
  });
});

describe("xplat win32: quoteWinArg", () => {
  it("leaves simple args unquoted", () => {
    expect(quoteWinArg("plain")).toBe("plain");
  });
  it("quotes args with whitespace", () => {
    expect(quoteWinArg("a b")).toBe('"a b"');
  });
  it("quotes + escapes embedded double quotes", () => {
    expect(quoteWinArg('say "hi"')).toBe('"say ""hi"""');
  });
  it("quotes cmd metacharacters that would otherwise be interpreted", () => {
    expect(quoteWinArg("a&b")).toBe('"a&b"');
    expect(quoteWinArg("x|y")).toBe('"x|y"');
  });
  it("represents the empty arg as a quoted empty string", () => {
    expect(quoteWinArg("")).toBe('""');
  });
});

describe("xplat win32: buildWin32SpawnPlan (.cmd shim spawning — THE gotcha)", () => {
  it("spawns an .exe directly with verbatim args, no shell", () => {
    const plan = buildWin32SpawnPlan("C:\\bin\\git.exe", ["status"], { comSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(plan).toEqual({ command: "C:\\bin\\git.exe", args: ["status"], shell: false });
  });

  it("routes a .cmd through cmd.exe /d /s /c with quoted script + args", () => {
    const plan = buildWin32SpawnPlan(
      "C:\\tools\\bun.cmd",
      ["run", "my script"],
      { comSpec: "C:\\Windows\\System32\\cmd.exe" },
    );
    expect(plan.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\tools\\bun.cmd"', // script path quoted (has no spaces but contains :, still safe quoted)
      "run",
      '"my script"', // arg with whitespace gets quoted
    ]);
    expect(plan.shell).toBe(false);
  });

  it("routes a .bat the same way as .cmd", () => {
    const plan = buildWin32SpawnPlan("C:\\x\\foo.bat", [], { comSpec: "cmd.exe" });
    expect(plan.command).toBe("cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });

  it("routes a .ps1 through powershell -File", () => {
    const plan = buildWin32SpawnPlan("C:\\s\\run.ps1", ["-x"], {});
    expect(plan.command).toBe("powershell.exe");
    expect(plan.args).toContain("-File");
    expect(plan.args).toContain("C:\\s\\run.ps1");
    expect(plan.args).toContain("-x");
  });

  it("defaults comSpec to cmd.exe when not provided", () => {
    const plan = buildWin32SpawnPlan("C:\\x\\foo.cmd", [], {});
    expect(plan.command).toBe("cmd.exe");
  });
});
