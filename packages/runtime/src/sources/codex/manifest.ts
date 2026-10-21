/**
 * Codex FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is the local Codex CLI, exposed as ONE sensitive capability —
 * `codex.run` — that launches headless `codex exec` in the authorized directory under
 * the owner's execution policy: Plexus's kernel jail by default, the owner's own
 * permissions when they choose host access (see `sources/exec-isolation.ts`).
 * `grants:["execute"]` ⇒ the gateway PENDS it for the owner. The calling agent never sees
 * a shell or the launch command. The Codex analog of the claudecode SourceModule.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link CodexSource} (lifecycle): `checkRequirements()` + `health()` report whether
 *    `codex` resolves. Availability is HEALTH-only — it never gates registration or hides
 *    the entry (the registry gates the whole source on hosts that cannot jail).
 *  - {@link CodexBridge} (per-session): an in-process handler drives the injected
 *    {@link CodexLauncher}; the REAL spawn is gated behind the owner's Real-launch setting.
 *
 * The authorized dir is CONFIGURABLE (constructor/config), default
 * `~/.plexus/workspace/codex`; override via `PLEXUS_CODEX_AUTHORIZED_DIR`.
 */

import { mkdirSync, statSync } from "node:fs";

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilitySource,
  PlatformServices,
  SourceHealth,
  SourceModule,
  SourceRequirementResult,
} from "@plexus/protocol";
import { BaseCapabilitySource } from "../base.ts";
import { getPlatformServices } from "../../platform/index.ts";
import { authorizedDirFor } from "../config/settings.ts";
import { CodexBridge } from "./bridge.ts";
import { CODEX_SOURCE_ID, codexEntries } from "./entries.ts";
import {
  CodexLauncher,
  defaultAuthorizedDir,
} from "./launcher.ts";

/** The env override that (below the persisted console setting) selects the jail dir. */
const AUTHORIZED_DIR_ENV = "PLEXUS_CODEX_AUTHORIZED_DIR" as const;

/**
 * The EFFECTIVE authorized dir: persisted console setting > env override > default
 * (`~/.plexus/workspace/codex`). Read live so a console change takes effect without a
 * restart (matches how `realLaunch` is consulted).
 */
function effectiveAuthorizedDir(): string {
  return authorizedDirFor(
    CODEX_SOURCE_ID,
    process.env[AUTHORIZED_DIR_ENV],
    defaultAuthorizedDir(),
  );
}

/**
 * Best-effort ensure the jail root exists + is a directory. Returns true iff, after a
 * recursive mkdir, the path is a real directory. Never throws + never surfaces the path.
 */
function ensureAuthorizedDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* fall through — statSync is the source of truth */
  }
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Config for the Codex source (authorized dir is configurable). */
export interface CodexSourceConfig {
  /** The ONE authorized dir Codex runs in. Default `~/.plexus/workspace/codex`. */
  authorizedDir?: string;
}

/**
 * Lifecycle-layer source for Codex. `checkRequirements()` + `health()` derive from whether
 * `codex` resolves through the platform seam. Availability is HEALTH-only — it never hides
 * the entry or blocks registration; a missing `codex` CLI degrades health to "unavailable".
 */
export class CodexSource extends BaseCapabilitySource {
  readonly id = CODEX_SOURCE_ID;
  readonly label = "Codex";
  readonly transport = "ipc" as const;

  private readonly platform: PlatformServices;
  private readonly authorizedDir: string;

  constructor(platform: PlatformServices, config: CodexSourceConfig = {}) {
    super();
    this.platform = platform;
    this.authorizedDir = config.authorizedDir ?? defaultAuthorizedDir();
  }

  /** The authorized dir this source runs Codex in. */
  get jail(): string {
    return this.authorizedDir;
  }

  /**
   * Probe the launch precondition: `codex` must resolve (the thing we launch). NOT a
   * registration gate — `scan()` always returns the entry; an
   * unavailable precondition surfaces via `health()`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const codex = await this.platform.resolveBinary("codex");
    if (!codex) {
      return { ok: false, reason: "Codex CLI (`codex`) not found on PATH" };
    }
    // The jail root must be a real, usable directory. Best-effort create it (the launcher
    // self-heals the same way at run time), then confirm it is a directory. A GENERIC,
    // PATH-FREE reason reaches the wire — the absolute host path never does.
    if (!ensureAuthorizedDir(this.authorizedDir)) {
      return {
        ok: false,
        reason: "authorized workspace directory is not available — configure it in Plexus",
      };
    }
    return { ok: true, resolved: codex };
  }

  /** HEALTH probe: ok iff `codex` is present + the authorized dir is usable, else unavailable. */
  override async health(): Promise<SourceHealth> {
    const req = await this.checkRequirements();
    return req.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(req.reason ? { detail: req.reason } : {}) };
  }

  /** The full UNGATED entry set (the run capability + the how-to skill). */
  async scan(): Promise<CapabilityEntry[]> {
    return codexEntries();
  }
}

/**
 * The Codex SourceModule. Registered in `src/sources/index.ts` MODULES; discovery /
 * availability / scan / invoke routing flow automatically. The authorized dir defaults
 * to `~/.plexus/workspace/codex`; override via `PLEXUS_CODEX_AUTHORIZED_DIR`.
 */
export const codexSourceModule: SourceModule = {
  id: CODEX_SOURCE_ID,
  label: "Codex",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    // Precedence: persisted console setting > PLEXUS_CODEX_AUTHORIZED_DIR > default.
    return new CodexSource(deps, { authorizedDir: effectiveAuthorizedDir() });
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge intercepts `codex.run` and drives a CodexLauncher in the authorized dir.
    // The launcher's real spawn is gated behind the owner's Real-launch setting (default
    // OFF). We build the launcher here so the EFFECTIVE dir (persisted setting > env >
    // default) flows in; it resolves `codex` through the live platform seam.
    const platform = getPlatformServices();
    const launcher = new CodexLauncher({
      resolveBinary: (name) => platform.resolveBinary(name),
      authorizedDir: effectiveAuthorizedDir(),
    });
    return new CodexBridge(deps, sessionId, codexEntries(), launcher);
  },
};
