/**
 * The `SandboxBackend` seam — "run this exec command confined to these paths/limits".
 *
 * The exec sources (`codex`, `claudecode`) are the only capabilities whose security
 * boundary is a KERNEL SANDBOX, not pure path math. This module abstracts that boundary
 * so the launchers stop calling `sandbox-exec` directly, and ships two implementations:
 *
 *  - {@link DarwinSandboxBackend} — wraps the existing macOS `sandbox-exec` seatbelt
 *    profile. Behavior is UNCHANGED: `wrap()` reproduces the exact
 *    `sandbox-exec -f <profile> -D JAIL=.. -D HOMEDIR=.. -D <NAME>=.. <bin> <args>` argv
 *    the launchers built inline before this seam existed.
 *  - {@link LinuxSandboxBackend} — builds an EQUIVALENT `bwrap` (bubblewrap) jail: an
 *    empty mount namespace with an explicit bind allow-list (the dual of the seatbelt's
 *    deny-default + allow-subpaths), read-only OS dirs, a single read-write `--bind`
 *    jail, `--unshare-all`/`--share-net`, `--die-with-parent`, `--new-session`, and
 *    no-new-privs (implied by bwrap when no `--cap-add` is passed).
 *
 * See `docs/design/linux-confinement.md` for the full sandbox-exec→bwrap mapping and the
 * security argument that the bwrap jail is a real kernel boundary, not a stub.
 *
 * AVAILABILITY GATE: `isAvailableSync()` reports whether the confinement primitive is
 * present + usable on this host. On Linux, `bwrap` may be ABSENT — then the exec sources
 * stay gated OUT of the active registry (exactly like today; anti-"advertised but
 * unjailed"). The probe is SYNC (registry build is sync) and INJECTABLE (tests never
 * depend on a real `bwrap` binary).
 */

import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";

import type { PlatformServices } from "@plexus/protocol";

/** The kernel-confinement mechanism a backend uses (audit-honest). */
export type SandboxMechanism = "sandbox-exec" | "bwrap";

/** A read-only named mount: the seatbelt references these by `name`; bwrap binds the `path`. */
export interface NamedMount {
  /** The seatbelt `-D` param name (e.g. `CODEX_BIN_DIR`, `CLAUDE_BIN_DIR`, `PLUGIN_DIR`). */
  name: string;
  /** The host path made read-only inside the jail. */
  path: string;
}

/**
 * OS-neutral description of ONE confined exec run. Each backend consumes the parts it
 * needs: darwin uses `profilePath` + named `params`; linux uses the `path`s + the dir
 * lists. See the field-by-field table in `docs/design/linux-confinement.md`.
 */
export interface SandboxSpec {
  /** The real binary to run (absolute) + its args (e.g. `codex exec …`). */
  innerCommand: string;
  innerArgs: string[];
  /** The ONE authorized dir — the only broad READ-WRITE subtree; also the chdir target. */
  jail: string;
  /** The real `$HOME` (tool config/creds live under it). */
  homedir: string;
  /** `TMPDIR`, pinned INSIDE the jail (the "almost-faked-the-spike" bug — never a system temp). */
  tmpdir: string;
  /** Network policy. Both seatbelt profiles `allow network*`; linux re-shares net. */
  network: boolean;
  /** The seatbelt `.sb` profile (darwin only; linux ignores it). */
  profilePath: string;
  /** Ordered named READ-ONLY mounts (tool bin dir, plugin dir). */
  params: NamedMount[];
  /** Dirs the tool must WRITE (e.g. `~/.codex`, `~/.claude`) — rw bind on linux. */
  configDirs?: string[];
  /** Read-only OS dirs the tool needs to run (linux only; darwin's profile lists them). */
  roSystemDirs?: string[];
}

/** The seam: confine an exec command to a set of paths/limits, on any platform. */
export interface SandboxBackend {
  /** The kernel mechanism this backend uses (recorded in audit). */
  readonly mechanism: SandboxMechanism;
  /**
   * Is the confinement primitive present AND usable on this host? SYNC (registry build
   * is sync). On Linux, `false` when `bwrap` is absent/unusable ⇒ exec sources stay
   * gated OUT.
   */
  isAvailableSync(): boolean;
  /**
   * Build the FULL wrapped argv actually exec'd (`command` + `args`). PURE +
   * deterministic — the core the record-mode + argv-construction tests assert.
   */
  wrap(spec: SandboxSpec): { command: string; args: string[] };
}

// ════════════════════════════════════════════════════════════════════════════
// Darwin — macOS sandbox-exec (behavior UNCHANGED)
// ════════════════════════════════════════════════════════════════════════════

/** The fixed macOS sandbox wrapper binary. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec" as const;

/** Deps for the darwin backend (the sandbox-exec path is injectable for tests/health). */
export interface DarwinSandboxDeps {
  /** The `sandbox-exec` binary path (default `/usr/bin/sandbox-exec`). */
  sandboxExec?: string;
  /** Existence probe (injectable; default `node:fs.existsSync`). */
  exists?: (p: string) => boolean;
}

/**
 * The macOS backend. `wrap()` emits the EXACT argv the launchers built inline before the
 * seam: `sandbox-exec -f <profile> -D JAIL=.. -D HOMEDIR=.. -D <NAME>=.. <bin> <args>`
 * (JAIL + HOMEDIR first, then each named param in order). Byte-for-byte unchanged.
 */
export class DarwinSandboxBackend implements SandboxBackend {
  readonly mechanism = "sandbox-exec" as const;
  private readonly sandboxExec: string;
  private readonly exists: (p: string) => boolean;

  constructor(deps: DarwinSandboxDeps = {}) {
    this.sandboxExec = deps.sandboxExec ?? SANDBOX_EXEC;
    this.exists = deps.exists ?? existsSync;
  }

  /** Available iff the `sandbox-exec` binary exists (the same check the source health used). */
  isAvailableSync(): boolean {
    return this.exists(this.sandboxExec);
  }

  wrap(spec: SandboxSpec): { command: string; args: string[] } {
    const args = [
      "-f",
      spec.profilePath,
      "-D",
      `JAIL=${spec.jail}`,
      "-D",
      `HOMEDIR=${spec.homedir}`,
    ];
    for (const p of spec.params) {
      args.push("-D", `${p.name}=${p.path}`);
    }
    args.push(spec.innerCommand, ...spec.innerArgs);
    return { command: this.sandboxExec, args };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Linux — bwrap / bubblewrap
// ════════════════════════════════════════════════════════════════════════════

/** The Linux kernel-jail binary name. */
export const BWRAP_BINARY = "bwrap" as const;

/**
 * Canonical read-only OS dirs the tool needs to run — the bwrap dual of the seatbelt's
 * `(allow file-read* (subpath "/usr") (subpath "/System") …)`. `--ro-bind-try` skips any
 * that are absent on a given host, so listing a superset is safe.
 */
export const DEFAULT_RO_SYSTEM_DIRS: readonly string[] = [
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc",
  "/opt",
  "/usr/local",
];

/** Canonical dirs to search for `bwrap` when probing availability. */
const BWRAP_PROBE_DIRS: readonly string[] = ["/usr/bin", "/usr/local/bin", "/bin"];

/** Deps for the Linux backend (all probes injectable so tests never need a real bwrap). */
export interface LinuxSandboxDeps {
  /** Absolute path to `bwrap` when known (skips the PATH walk). */
  bwrapPath?: string;
  /** READ-ONLY OS dirs (default {@link DEFAULT_RO_SYSTEM_DIRS}). */
  roSystemDirs?: readonly string[];
  /**
   * The availability probe — resolve `bwrap` on PATH + confirm it can build a real jail.
   * Injectable so a test can force available/absent WITHOUT a real `bwrap`. Default: a sync
   * PATH walk (`X_OK`) + a bounded namespace-exercising run (bwrap builds a minimal
   * `--unshare-user --unshare-net` jail and runs `true`; only exit 0 ⇒ available).
   */
  probe?: () => string | undefined;
}

/** Is `<p>` present + executable (X_OK)? */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk PATH (+ canonical dirs) for an executable `bwrap`; undefined when not found. */
function resolveBwrapOnPath(): string | undefined {
  const fromEnv = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const seen = new Set<string>();
  for (const dir of [...fromEnv, ...BWRAP_PROBE_DIRS]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, BWRAP_BINARY);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The DEFAULT real probe: resolve `bwrap` (X_OK on PATH), then confirm it can ACTUALLY
 * BUILD A JAIL — not merely that the binary runs. We exercise real namespace creation by
 * having bwrap construct a minimal jail (`--unshare-user --unshare-net`) and run a trivial
 * command (`true`); only exit 0 counts as available.
 *
 * Why not `bwrap --version`: `--version` prints and exits WITHOUT touching `unshare(2)`,
 * so on a host where unprivileged user namespaces are disabled (Ubuntu 24.04's
 * `kernel.apparmor_restrict_unprivileged_userns=1`, Debian's `kernel.unprivileged_userns_clone=0`,
 * `user.max_user_namespaces=0`, hardened containers) a present-but-unusable non-setuid
 * bwrap would pass `--version` yet fail EVERY real jailed invocation ("No permissions to
 * create new namespace"). That is precisely the "advertised but unjailable" state the gate
 * must prevent — so the probe must itself attempt namespace creation and fail closed.
 *
 * Setuid nuance: a setuid-root bwrap can build the jail WITHOUT an unprivileged userns; in
 * that case `--unshare-user` is effectively a no-op but the test command still runs and
 * exits 0 — so the probe correctly reports available. We only ever conclude "available"
 * from a jail that actually ran a command to completion.
 *
 * Returns the resolved path on success, undefined otherwise. Never throws.
 */
function defaultBwrapProbe(): string | undefined {
  const resolved = resolveBwrapOnPath();
  if (!resolved) return undefined;
  try {
    // Build a minimal jail and run `true` — exercises unshare(2) for real. Any non-zero
    // exit (e.g. userns disabled ⇒ "No permissions to create new namespace") throws here.
    execFileSync(
      resolved,
      ["--ro-bind", "/", "/", "--unshare-user", "--unshare-net", "--die-with-parent", "true"],
      { timeout: 3000, stdio: "ignore" },
    );
    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * The Linux backend — builds a `bwrap` jail equivalent to the macOS seatbelt profile. An
 * empty mount namespace (`--unshare-all`) + an explicit bind allow-list: read-only OS
 * dirs + read-only tool bin/plugin dirs, ONE read-write `--bind` jail, rw config dirs,
 * `--share-net` (when allowed), `--die-with-parent`, `--new-session`, `TMPDIR` inside the
 * jail. No `--cap-add` ⇒ bwrap sets `PR_SET_NO_NEW_PRIVS`. See the design doc.
 */
export class LinuxSandboxBackend implements SandboxBackend {
  readonly mechanism = "bwrap" as const;
  private readonly bwrapPath: string;
  private readonly roSystemDirs: readonly string[];
  private readonly probe: () => string | undefined;

  constructor(deps: LinuxSandboxDeps = {}) {
    this.probe = deps.probe ?? defaultBwrapProbe;
    // A known path skips the PATH walk for `wrap()`; availability still re-probes.
    this.bwrapPath = deps.bwrapPath ?? resolveBwrapOnPath() ?? BWRAP_BINARY;
    this.roSystemDirs = deps.roSystemDirs ?? DEFAULT_RO_SYSTEM_DIRS;
  }

  /** Available iff `bwrap` resolves AND can build a real jail — the injected probe decides. */
  isAvailableSync(): boolean {
    return this.probe() !== undefined;
  }

  /**
   * Build the bwrap argv. PURE — does NOT spawn or probe. Mirrors the seatbelt profile:
   * deny-default (empty ns) + an allow-list of binds. The ONLY broad rw surface is the
   * single `--bind <jail>`.
   */
  wrap(spec: SandboxSpec): { command: string; args: string[] } {
    const args: string[] = [
      "--die-with-parent",
      "--unshare-all",
      ...(spec.network ? ["--share-net"] : []),
      "--new-session",
    ];

    // Read-only OS dirs (the bwrap dual of `(allow file-read* (subpath "/usr") …)`).
    const roSys = spec.roSystemDirs ?? this.roSystemDirs;
    for (const dir of roSys) {
      args.push("--ro-bind-try", dir, dir);
    }

    // A fresh /proc + a minimal /dev + a private empty /tmp (no host temp leaks in).
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

    // THE jail — the only broad read-write subtree (hard bind; the dir must exist).
    args.push("--bind", spec.jail, spec.jail);

    // Writable config/cred dirs (e.g. ~/.codex, ~/.claude) — rw, tolerant of absence.
    for (const dir of spec.configDirs ?? []) {
      args.push("--bind-try", dir, dir);
    }

    // Read-only named mounts (tool bin dir, plugin dir) — the `-D <NAME>=path` params.
    for (const p of spec.params) {
      if (p.path) args.push("--ro-bind-try", p.path, p.path);
    }

    args.push("--setenv", "TMPDIR", spec.tmpdir, "--chdir", spec.jail, "--");
    args.push(spec.innerCommand, ...spec.innerArgs);

    return { command: this.bwrapPath, args };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Platform selection
// ════════════════════════════════════════════════════════════════════════════

/**
 * Select the SandboxBackend for a platform. `linux` → bwrap; everything else (darwin and,
 * for back-compat, win32) → the macOS sandbox-exec backend. The exec sources only ever
 * run their launcher when ACTIVE — and on Linux they are active iff this backend is
 * available — so the selected backend is always the one that can actually jail them.
 */
export function selectSandboxBackend(
  platform: PlatformServices["platform"],
): SandboxBackend {
  if (platform === "linux") return new LinuxSandboxBackend();
  return new DarwinSandboxBackend();
}
