/**
 * Linux PATH discovery + binary resolution — the platform-SPECIFIC logic for
 * LinuxPlatformServices, expressed as PURE functions with injected env / shell
 * runner / fs so the whole thing is deterministically testable on macOS (where the
 * real Linux code path can never execute). The Linux impl wires the real
 * `$SHELL -lic 'echo $PATH'` probe + real fs into these.
 *
 * Mirrors the macOS path-resolver shape (login-shell capture + fallback dirs) but
 * keeps darwin.ts / path-resolver.ts untouched.
 */

import { delimiter, join } from "node:path";

/** A pluggable "is this dir present?" probe (injected for tests). */
export type DirExists = (path: string) => boolean;

/** Runs the login-shell PATH probe; returns its raw stdout, or undefined on failure. */
export type ShellPathProbe = () => string | undefined;

/**
 * The marker-wrapped capture command we hand to the login shell, identical in shape
 * to the macOS path-resolver. Exposed so the impl and the tests agree on framing.
 */
export const LINUX_PATH_PROBE_CMD = `echo "___PATH_START___$PATH___PATH_END___"`;

/** PURE: extract the PATH out of the marker-wrapped login-shell stdout. */
export function parseProbedPath(stdout: string | undefined): string | undefined {
  if (!stdout) return undefined;
  const match = stdout.match(/___PATH_START___(.+)___PATH_END___/);
  return match?.[1] ? match[1] : undefined;
}

/**
 * PURE: the canonical Linux fallback candidate dirs (filtered by the injected
 * `exists`). Used when the login-shell probe fails or yields nothing.
 */
export function buildLinuxFallbackPath(
  home: string,
  exists: DirExists,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".pyenv", "bin"),
    join(home, ".pyenv", "shims"),
    join(home, "go", "bin"),
    "/usr/local/go/bin",
    join(home, ".deno", "bin"),
    "/snap/bin",
    "/usr/games",
  ];

  const nvmDir = env.NVM_DIR ?? join(home, ".nvm");
  candidates.push(join(nvmDir, "versions", "node"));

  return [...new Set(candidates.filter(exists))].join(delimiter);
}

/**
 * PURE: enriched PATH = (login-shell PATH, else fallback dirs) merged with the
 * process PATH, de-duplicated, order-preserving. All inputs injected.
 */
export function buildEnrichedLinuxPath(args: {
  probe: ShellPathProbe;
  home: string;
  exists: DirExists;
  env: NodeJS.ProcessEnv;
}): string {
  const { probe, home, exists, env } = args;

  const userPath =
    parseProbedPath(probe()) ?? buildLinuxFallbackPath(home, exists, env);
  const currentPath = env.PATH ?? "";

  const allDirs = [...userPath.split(delimiter), ...currentPath.split(delimiter)];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of allDirs) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      deduped.push(dir);
    }
  }
  return deduped.join(delimiter);
}

/**
 * PURE: `which`-equivalent. Walk the enriched PATH dirs and return the first dir
 * where `<dir>/<name>` exists (executable check is the injected `exists`, which the
 * impl backs with an X_OK access test). Absolute paths pass through. Returns
 * undefined if not found anywhere. No subprocess — fully deterministic.
 */
export function resolveBinaryOnPath(
  name: string,
  enrichedPath: string,
  exists: DirExists,
): string | undefined {
  // Absolute path passthrough.
  if (name.startsWith("/")) {
    return exists(name) ? name : undefined;
  }
  // A name containing a slash is a relative path — not a PATH lookup.
  if (name.includes("/")) {
    return undefined;
  }

  for (const dir of enrichedPath.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
