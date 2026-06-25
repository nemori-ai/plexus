/**
 * Linux implementation of the PlatformServices seam (§4.2).
 *
 * Concretely implemented now (post-v1 stub filled). Mirrors the macOS impl's shape:
 *  - getEnrichedPath  — login-shell PATH probe (`$SHELL -lic 'echo $PATH'`) merged
 *    with the process PATH, falling back to canonical Linux bin dirs.
 *  - resolveBinary    — `which`-equivalent walk over the enriched PATH (X_OK check).
 *  - spawnProcess     — inherits the OS-neutral NDJSON line-framer over
 *    `node:child_process.spawn`, spawned with the enriched PATH.
 *  - locateLocalService / resolveSecret — inherit the OS-neutral shared impls.
 *
 * The platform-specific PATH/binary LOGIC lives in `./linux-path.ts` as pure
 * functions with injected env/shell/fs, so it is deterministically unit-tested on
 * macOS. NOTE: real on-Linux end-to-end validation (actual login-shell sourcing,
 * real X_OK semantics) is DEFERRED — cannot run a Linux process from this dev box.
 */

import { execSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
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
  LINUX_PATH_PROBE_CMD,
  buildEnrichedLinuxPath,
  resolveBinaryOnPath,
} from "./linux-path.ts";

/** Is `<path>` present and executable (X_OK)? OS-real probe for resolveBinary. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run the real login-shell PATH probe; returns raw stdout, or undefined on error. */
function runShellPathProbe(): string | undefined {
  try {
    const shell = process.env.SHELL ?? "/bin/bash";
    return execSync(`${shell} -lic '${LINUX_PATH_PROBE_CMD}'`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: { HOME: homedir(), USER: process.env.USER, SHELL: shell },
    });
  } catch {
    return undefined;
  }
}

export class LinuxPlatformServices implements PlatformServices {
  readonly platform = "linux" as const;

  private _cachedPath: string | null = null;

  private enrichedPathSync(): string {
    if (this._cachedPath) return this._cachedPath;
    this._cachedPath = buildEnrichedLinuxPath({
      probe: runShellPathProbe,
      home: homedir(),
      exists: isExecutable,
      env: process.env,
    });
    return this._cachedPath;
  }

  async getEnrichedPath(): Promise<string> {
    return this.enrichedPathSync();
  }

  async resolveBinary(name: string): Promise<string | undefined> {
    return resolveBinaryOnPath(name, this.enrichedPathSync(), isExecutable);
  }

  async locateLocalService(hint: LocalServiceHint): Promise<LocalServiceLocation | undefined> {
    return locateLocalServiceWith(hint);
  }

  spawnProcess(spec: SpawnSpec): SpawnedProcess {
    const enriched = this.enrichedPathSync();
    const mergedPath = [spec.env?.PATH, enriched, process.env.PATH]
      .filter(Boolean)
      .join(delimiter);

    return spawnWithLineFraming(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, PATH: mergedPath },
      stdio: ["pipe", "pipe", "inherit"],
    });
  }

  async resolveSecret(name: string): Promise<string | undefined> {
    // The `~/.plexus/secrets/` file store is cross-platform; inherit it.
    return resolveSecretFrom(name, secretsBaseDir());
  }
}
