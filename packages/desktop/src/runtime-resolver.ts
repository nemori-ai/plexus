/**
 * ============================================================================
 * Runtime sidecar resolver (REDESIGN-ARCHITECTURE §3.1, §5.1)
 * ============================================================================
 *
 * The supervisor spawns the Plexus runtime as a child process. WHERE that binary
 * lives — and HOW it is invoked — differs between dev and a packaged app, but the
 * supervisor code that spawns/supervises/restarts must stay identical:
 *
 *   DEV (not packaged): there is no compiled binary; run the TypeScript source
 *     through Bun:                  `bun run <repoRoot>/packages/runtime/bin/plexus`
 *   PROD (packaged):     electron-builder ships the compiled single-file Bun exe
 *     as an extraResource under `process.resourcesPath`; spawn it directly:
 *                                   `<resourcesPath>/runtime/plexus-runtime-darwin-<arch>`
 *
 * This module is the pure decision — no Electron, no fs, no spawn — so it is
 * trivially unit-testable. The supervisor calls it with `{ packaged, repoRoot,
 * resourcesPath, platform, arch }` and spawns the returned `{ command, args }`.
 */

/** The name electron-builder ships the runtime exe under (the extraResource subdir). */
export const RUNTIME_RESOURCE_DIR = "runtime" as const;

/** Inputs the resolver needs (all injected so it stays Electron-free + testable). */
export interface RuntimeResolveInput {
  /** `app.isPackaged` — true in a built `.app`, false under `electron .` / dev. */
  readonly packaged: boolean;
  /** Monorepo root (dev only; used to locate `packages/runtime/bin/plexus`). */
  readonly repoRoot: string;
  /** `process.resourcesPath` — the bundle's Resources dir (packaged only). */
  readonly resourcesPath?: string;
  /** `process.platform` (default "darwin"). */
  readonly platform?: NodeJS.Platform;
  /** `process.arch` ("arm64" | "x64" | …; default "arm64"). */
  readonly arch?: string;
  /** Override the dev launcher binary (default "bun"). Tests/CI may pass a stub. */
  readonly devLauncher?: string;
}

/** The resolved spawn command. The supervisor passes these straight to `spawn`. */
export interface ResolvedRuntimeCommand {
  /** The executable to spawn (`bun` in dev, the compiled exe path in prod). */
  readonly command: string;
  /** Args (the `bin/plexus` path in dev; none for the self-contained exe). */
  readonly args: string[];
  /** True iff `command` is the compiled self-contained sidecar exe. */
  readonly compiled: boolean;
}

/** POSIX join (no `node:path` import so this stays dependency-free + testable). */
function join(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

/** The per-arch compiled exe filename (matches runtime/scripts/build-compile.ts). */
export function runtimeExeName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "darwin" ? "darwin" : platform; // win32/linux are future
  return `plexus-runtime-${os}-${arch}`;
}

/**
 * Decide how to launch the runtime sidecar.
 *
 * DEV  → `bun run <repoRoot>/packages/runtime/bin/plexus`
 * PROD → `<resourcesPath>/runtime/plexus-runtime-<os>-<arch>` (no args; self-contained)
 *
 * Throws in packaged mode if `resourcesPath` is missing (a packaging bug we want
 * loud, not a silent fallback to a `bun` that won't exist on the user's machine).
 */
export function resolveRuntimeCommand(input: RuntimeResolveInput): ResolvedRuntimeCommand {
  const platform = input.platform ?? "darwin";
  const arch = input.arch ?? "arm64";

  if (input.packaged) {
    if (!input.resourcesPath) {
      throw new Error(
        "resolveRuntimeCommand: packaged app has no resourcesPath — cannot locate the bundled runtime sidecar",
      );
    }
    const exe = join(input.resourcesPath, RUNTIME_RESOURCE_DIR, runtimeExeName(platform, arch));
    return { command: exe, args: [], compiled: true };
  }

  // Dev: run the TypeScript entrypoint through Bun (no compiled binary exists).
  const launcher = input.devLauncher ?? "bun";
  const binPlexus = join(input.repoRoot, "packages", "runtime", "bin", "plexus");
  return { command: launcher, args: ["run", binPlexus], compiled: false };
}
