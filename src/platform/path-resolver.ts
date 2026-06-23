/**
 * PATH discovery and binary resolution for the platform seam.
 *
 * Ported from pneuma-skills `server/path-resolver.ts` (login-shell PATH capture +
 * fallback candidate dirs). Concretely implemented here because it is well-specified
 * by the grounding and the macOS platform impl needs it at scan time.
 *
 * macOS/Linux capture the real interactive shell PATH; Windows reads process PATH.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

const isWin = process.platform === "win32";

/**
 * Capture the user's full interactive shell PATH by spawning a login shell.
 * On Windows, process.env.PATH already contains the full user PATH.
 */
export function captureUserShellPath(): string {
  if (isWin) {
    return process.env.PATH ?? "";
  }

  try {
    const shell = process.env.SHELL ?? "/bin/bash";
    const captured = execSync(
      `${shell} -lic 'echo "___PATH_START___$PATH___PATH_END___"'`,
      {
        encoding: "utf-8",
        timeout: 10_000,
        env: { HOME: homedir(), USER: process.env.USER, SHELL: shell },
      },
    );
    const match = captured.match(/___PATH_START___(.+)___PATH_END___/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Shell sourcing failed — fall through to the fallback candidate dirs.
  }

  return buildFallbackPath();
}

/** Build a PATH by probing common binary installation directories. */
export function buildFallbackPath(): string {
  const home = homedir();

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";

    const candidates = [
      join(home, ".bun", "bin"),
      join(localAppData, "bun"),
      join(appData, "npm"),
      join(home, "scoop", "shims"),
      join(home, ".cargo", "bin"),
      join(home, ".deno", "bin"),
      join(home, "go", "bin"),
      join(pf, "Git", "cmd"),
      join(pf, "nodejs"),
      join(localAppData, "Programs", "Python"),
      join(localAppData, "fnm"),
      join(home, ".volta", "bin"),
    ];

    return [...new Set(candidates.filter((dir) => existsSync(dir)))].join(delimiter);
  }

  const candidates = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".pyenv", "bin"),
    join(home, ".pyenv", "shims"),
    join(home, "go", "bin"),
    "/usr/local/go/bin",
    join(home, ".deno", "bin"),
  ];

  const nvmDir = process.env.NVM_DIR ?? join(home, ".nvm");
  const nvmVersionsDir = join(nvmDir, "versions", "node");
  if (existsSync(nvmVersionsDir)) {
    try {
      for (const v of readdirSync(nvmVersionsDir)) {
        candidates.push(join(nvmVersionsDir, v, "bin"));
      }
    } catch {
      /* ignore */
    }
  }

  const fnmDir = join(home, "Library", "Application Support", "fnm", "node-versions");
  if (existsSync(fnmDir)) {
    try {
      for (const v of readdirSync(fnmDir)) {
        candidates.push(join(fnmDir, v, "installation", "bin"));
      }
    } catch {
      /* ignore */
    }
  }

  return [...new Set(candidates.filter((dir) => existsSync(dir)))].join(delimiter);
}

let _cachedPath: string | null = null;

/**
 * Enriched PATH that merges the user's shell PATH with the current process PATH,
 * deduplicated. Cached after the first call.
 */
export function getEnrichedPath(): string {
  if (_cachedPath) return _cachedPath;

  const currentPath = process.env.PATH ?? "";
  const userPath = captureUserShellPath();

  const allDirs = [...userPath.split(delimiter), ...currentPath.split(delimiter)];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of allDirs) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      deduped.push(dir);
    }
  }

  _cachedPath = deduped.join(delimiter);
  return _cachedPath;
}

/**
 * Resolve a binary name to an absolute path using the enriched PATH.
 * Returns undefined if the binary is not found anywhere.
 */
export function resolveBinary(name: string): string | undefined {
  // Absolute path passthrough.
  if (isWin ? /^[A-Za-z]:[\\/]/.test(name) : name.startsWith("/")) {
    return existsSync(name) ? name : undefined;
  }

  const enrichedPath = getEnrichedPath();
  const cmd = isWin ? "where" : "which";
  try {
    const resolved = execSync(
      `${cmd} ${name.replace(/[^a-zA-Z0-9._@/\\-]/g, "")}`,
      {
        encoding: "utf-8",
        timeout: 5_000,
        env: { ...process.env, PATH: enrichedPath },
      },
    ).trim();
    if (isWin) {
      const first = resolved.split("\n")[0]?.trim();
      return first || undefined;
    }
    return resolved || undefined;
  } catch {
    return undefined;
  }
}
