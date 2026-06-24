/**
 * Windows implementation of the PlatformServices seam (§4.2).
 *
 * Concretely implemented now (post-v1 stub filled). Mirrors the macOS impl's shape
 * with Windows-specific nuance encapsulated here:
 *  - getEnrichedPath  — `process.env.PATH` + common install dirs (no login shell).
 *  - resolveBinary    — `where`-equivalent: honors PATHEXT (`.exe/.cmd/.bat/.ps1`),
 *    appending each extension across each PATH dir.
 *  - spawnProcess     — handles `.cmd`/`.bat` shim spawning (must go through
 *    `cmd.exe /d /s /c` with per-arg quoting — a bare `spawn` of a `.cmd` throws),
 *    `.ps1` via powershell, `.exe` directly. Reuses the OS-neutral NDJSON framer.
 *  - locateLocalService — inherits the OS-neutral TCP-probe impl.
 *  - resolveSecret    — inherits the `~/.plexus/secrets/` file store. `chmod 0600`
 *    is a no-op on Windows, so it is GATED OUT here (callers must not chmod on
 *    win32). // TODO: Windows ACL hardening (restrict secret-file ACLs to the user).
 *
 * The platform-specific PATH/PATHEXT/spawn LOGIC lives in `./win32-path.ts` as pure
 * functions with injected env/fs, so it is deterministically unit-tested on macOS.
 * NOTE: real on-Windows end-to-end validation (actual `cmd.exe` invocation, real
 * CreateProcess search) is DEFERRED — cannot run a Windows process from this box.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter } from "node:path";

import type {
  PlatformServices,
  LocalServiceHint,
  LocalServiceLocation,
  SpawnSpec,
  SpawnedProcess,
} from "@plexus/protocol";

import {
  locateLocalServiceWith,
  resolveSecretFrom,
  secretsBaseDir,
  spawnWithLineFraming,
} from "./shared.ts";
import {
  buildEnrichedWin32Path,
  buildWin32SpawnPlan,
  parsePathExt,
  resolveBinaryWin32,
} from "./win32-path.ts";

export class Win32PlatformServices implements PlatformServices {
  readonly platform = "win32" as const;

  private _cachedPath: string | null = null;

  private enrichedPathSync(): string {
    if (this._cachedPath) return this._cachedPath;
    this._cachedPath = buildEnrichedWin32Path({
      home: homedir(),
      exists: (p) => existsSync(p),
      env: process.env,
    });
    return this._cachedPath;
  }

  async getEnrichedPath(): Promise<string> {
    return this.enrichedPathSync();
  }

  async resolveBinary(name: string): Promise<string | undefined> {
    return resolveBinaryWin32(
      name,
      this.enrichedPathSync(),
      parsePathExt(process.env),
      (p) => existsSync(p),
    );
  }

  async locateLocalService(hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
    return locateLocalServiceWith(hint);
  }

  spawnProcess(spec: SpawnSpec): SpawnedProcess {
    const enriched = this.enrichedPathSync();
    const mergedPath = [spec.env?.PATH, enriched, process.env.PATH]
      .filter(Boolean)
      .join(delimiter);

    // Resolve the command so we know whether it's a `.cmd`/`.bat` shim that must be
    // launched through cmd.exe rather than spawned directly. If it can't be resolved
    // (e.g. it's an absolute path or already extension-bearing), fall back to the
    // raw command and let the plan builder key off its extension.
    const resolved =
      resolveBinaryWin32(spec.command, enriched, parsePathExt(process.env), (p) =>
        existsSync(p),
      ) ?? spec.command;

    const plan = buildWin32SpawnPlan(resolved, spec.args, {
      comSpec: process.env.ComSpec,
    });

    return spawnWithLineFraming(plan.command, plan.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, PATH: mergedPath },
      stdio: ["pipe", "pipe", "inherit"],
      shell: plan.shell,
      // `windowsVerbatimArguments` keeps our explicit cmd.exe quoting intact (Node
      // would otherwise re-quote args for the `.cmd` case and double-escape).
      windowsVerbatimArguments: !plan.shell,
    });
  }

  async resolveSecret(name: string): Promise<string | undefined> {
    // The `~/.plexus/secrets/` file store is cross-platform; inherit it.
    // chmod 0600 hardening is a POSIX no-op on Windows and is intentionally NOT
    // applied here. // TODO: Windows ACL hardening (restrict ACLs to the user SID).
    return resolveSecretFrom(name, secretsBaseDir());
  }
}
