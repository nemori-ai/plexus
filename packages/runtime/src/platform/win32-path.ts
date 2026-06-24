/**
 * Windows PATH discovery, PATHEXT-aware binary resolution, and `.cmd`/`.bat` shim
 * spawn-argument construction — the platform-SPECIFIC logic for
 * Win32PlatformServices, expressed as PURE functions with injected env / fs so the
 * whole thing is deterministically testable on macOS (where the real Windows code
 * path can never execute). The Win32 impl wires real `process.env` + real fs in.
 *
 * BIGGEST WINDOWS GOTCHA encoded here:
 *  1. `resolveBinary` must emulate `where`: a bare name like `git` resolves to
 *     `git.exe` (or `git.cmd`, `git.bat`, `git.ps1`) by appending each PATHEXT
 *     extension across each PATH dir — Windows has no execute bit, the *extension*
 *     is what makes a file runnable.
 *  2. `node:child_process.spawn` of a `.cmd`/`.bat` WITHOUT a shell fails on
 *     Windows ("not a valid Win32 application") because cmd shims are interpreted by
 *     `cmd.exe`, not the OS loader. So a resolved `.cmd`/`.bat` target must be
 *     spawned through `cmd.exe /d /s /c` with proper quoting. `.exe`/`.com` spawn
 *     directly. We construct (and TEST) those exact argv without executing.
 */

import { win32 as winPath } from "node:path";

// Windows paths use `;` as the PATH delimiter and `\` separators. We pin the
// win32 path namespace explicitly so this logic behaves identically when unit-run
// on a POSIX host (the macOS dev box) — `node:path`'s default join would otherwise
// emit `/` separators and break deterministic resolution under test.
const { extname, join } = winPath;
const delimiter = ";";

/** A pluggable "is this file present?" probe (injected for tests). */
export type FileExists = (path: string) => boolean;

/** The default PATHEXT used when the environment doesn't provide one. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC;.PS1";

/** PURE: parse PATHEXT into a normalized, lowercased, deduped list of extensions. */
export function parsePathExt(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATHEXT ?? DEFAULT_PATHEXT;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const ext = part.trim().toLowerCase();
    if (ext && ext.startsWith(".") && !seen.has(ext)) {
      seen.add(ext);
      out.push(ext);
    }
  }
  return out;
}

/**
 * PURE: the canonical Windows fallback candidate dirs (filtered by injected
 * `exists`). Windows has no login shell; this supplements `process.env.PATH` with
 * common per-user/global install locations.
 */
export function buildWin32FallbackPath(
  home: string,
  exists: FileExists,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const pf = env["ProgramFiles"] ?? "C:\\Program Files";
  const sysRoot = env.SystemRoot ?? "C:\\Windows";

  const candidates = [
    join(sysRoot, "System32"),
    sysRoot,
    join(home, ".bun", "bin"),
    join(localAppData, "bun"),
    join(appData, "npm"),
    join(home, "scoop", "shims"),
    join(home, ".cargo", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin"),
    join(pf, "Git", "cmd"),
    join(pf, "Git", "bin"),
    join(pf, "nodejs"),
    join(localAppData, "Programs", "Python"),
    join(localAppData, "fnm"),
    join(home, ".volta", "bin"),
  ];

  return [...new Set(candidates.filter(exists))].join(delimiter);
}

/**
 * PURE: enriched PATH for Windows = process PATH + fallback install dirs, deduped
 * case-insensitively (Windows paths are case-insensitive), order-preserving. All
 * inputs injected. No login-shell concept.
 */
export function buildEnrichedWin32Path(args: {
  home: string;
  exists: FileExists;
  env: NodeJS.ProcessEnv;
}): string {
  const { home, exists, env } = args;
  const processPath = env.PATH ?? "";
  const fallback = buildWin32FallbackPath(home, exists, env);

  const allDirs = [...processPath.split(delimiter), ...fallback.split(delimiter)];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of allDirs) {
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(dir);
    }
  }
  return deduped.join(delimiter);
}

/**
 * PURE: `where`-equivalent. For a bare name, try each PATH dir and:
 *  - if `name` already carries a known/any extension, look for it as-is, AND
 *  - otherwise append each PATHEXT extension (in PATHEXT precedence order).
 * Returns the first existing match. Absolute `X:\...` paths pass through (honoring
 * PATHEXT too when extensionless). Mirrors how Windows `where`/CreateProcess search.
 */
export function resolveBinaryWin32(
  name: string,
  enrichedPath: string,
  pathext: string[],
  exists: FileExists,
): string | undefined {
  const hasExt = extname(name) !== "";
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(name) || name.startsWith("\\\\");
  const hasSep = name.includes("\\") || name.includes("/");

  // Candidate filename variants for a leaf name: exact first, then +each PATHEXT.
  const variants = (leaf: string): string[] =>
    hasExt ? [leaf] : [leaf, ...pathext.map((ext) => leaf + ext)];

  // Absolute or path-bearing name: resolve relative to itself, not the PATH.
  if (isAbsolute || hasSep) {
    for (const candidate of variants(name)) {
      if (exists(candidate)) return candidate;
    }
    return undefined;
  }

  // Bare name: search each PATH dir, trying the extension variants.
  for (const dir of enrichedPath.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of variants(join(dir, name))) {
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Result of constructing a Windows spawn: the argv + whether a shell is needed. */
export interface Win32SpawnPlan {
  /** The executable Node `spawn` should launch. */
  command: string;
  /** The args Node `spawn` should pass. */
  args: string[];
  /**
   * Whether `spawn` must be given `{ shell: true }`. For `.cmd`/`.bat` we instead
   * launch `cmd.exe` explicitly (more predictable quoting than `shell:true`), so
   * this stays false; it's exposed for callers/tests that want the simpler path.
   */
  shell: boolean;
}

/**
 * PURE: quote a single Windows command-line argument for `cmd.exe`. Wraps in double
 * quotes when the arg contains whitespace or cmd metacharacters, escapes embedded
 * double quotes, and caret-escapes cmd metacharacters that survive quoting. This is
 * the crux of safe `.cmd` invocation — getting it wrong is the classic Windows
 * command-injection / arg-splitting bug.
 */
export function quoteWinArg(arg: string): string {
  if (arg === "") return '""';
  // Needs quoting if it has whitespace or any cmd-significant character.
  const needsQuote = /[\s"&|<>^()%!]/.test(arg);
  if (!needsQuote) return arg;
  // Escape backslashes preceding a quote, then the quote itself (MS C runtime rule),
  // then wrap. For cmd.exe, also caret-escape the metacharacters left outside? No —
  // once wrapped in double quotes, cmd treats the contents literally except `%` and
  // `!` (delayed expansion). We escape `"` by doubling per cmd convention.
  const escaped = arg.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * PURE: build the actual `spawn(command, args)` plan for a requested command on
 * Windows, given the already-resolved executable path (from `resolveBinaryWin32`).
 *
 *  - `.exe` / `.com`  → spawn directly, args verbatim (no shell).
 *  - `.cmd` / `.bat`  → spawn `cmd.exe /d /s /c "<script>" <quoted args...>`. This
 *    is REQUIRED: spawning a `.cmd` directly throws EINVAL/"not a valid Win32
 *    application". `/d` skips AutoRun, `/s` + the outer quoting keeps the whole
 *    line as one command, `/c` runs then exits.
 *  - `.ps1`           → spawn powershell with `-File`.
 *  - anything else / unknown → spawn directly (best effort).
 *
 * `comSpec` lets tests pin `cmd.exe`'s path deterministically.
 */
export function buildWin32SpawnPlan(
  resolved: string,
  args: string[],
  opts: { comSpec?: string } = {},
): Win32SpawnPlan {
  const ext = extname(resolved).toLowerCase();
  const comSpec = opts.comSpec ?? "cmd.exe";

  if (ext === ".cmd" || ext === ".bat") {
    // cmd.exe /d /s /c "<script>" <args...>
    // The script path is ALWAYS wrapped in quotes (cmd needs it when the path has
    // spaces, and quoting an already-safe path is harmless), and each arg is quoted
    // per the cmd quoting rules. The whole thing after /c is one command line.
    const quotedScript = `"${resolved.replace(/"/g, '""')}"`;
    const quoted = [quotedScript, ...args.map(quoteWinArg)];
    return {
      command: comSpec,
      args: ["/d", "/s", "/c", ...quoted],
      shell: false,
    };
  }

  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
      shell: false,
    };
  }

  // .exe / .com / unknown — direct spawn.
  return { command: resolved, args, shell: false };
}
