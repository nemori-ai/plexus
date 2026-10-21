/**
 * Claude Code FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is Claude Code, exposed as ONE sensitive capability — `claudecode.run`
 * — that launches headless CC in the authorized directory under the owner's execution
 * policy: Plexus's kernel jail by default, the owner's own permissions when they choose
 * host access (see `sources/exec-isolation.ts`). `grants:["execute"]` ⇒ the gateway
 * PENDS it for the owner. The calling agent never sees a shell or the launch command.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link ClaudecodeSource} (lifecycle): `checkRequirements()` + `health()` report
 *    whether `claude` resolves. Availability is HEALTH-only — it never gates registration
 *    or hides the entry (the registry gates the whole source on hosts that cannot jail).
 *  - {@link ClaudecodeBridge} (per-session): an in-process handler drives the injected
 *    {@link ClaudeCodeLauncher}; the REAL spawn is gated behind the owner's Real-launch setting.
 *
 * The authorized dir is CONFIGURABLE (constructor/config), default
 * `~/.plexus/workspace/claudecode`. The orchestrator registers this module in
 * `src/sources/index.ts` MODULES; the reserved source id ⇒ first-party provenance.
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
import { ClaudecodeBridge } from "./bridge.ts";
import { CLAUDECODE_SOURCE_ID, claudecodeEntries } from "./entries.ts";
import {
  ClaudeCodeLauncher,
  defaultAuthorizedDir,
} from "./launcher.ts";

/** The env override that (below the persisted console setting) selects the jail dir. */
const AUTHORIZED_DIR_ENV = "PLEXUS_CC_AUTHORIZED_DIR" as const;

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

/**
 * The EFFECTIVE authorized dir: persisted console setting > env override > default
 * (`~/.plexus/workspace/claudecode`). Read live so a console change takes effect
 * without a restart (matches how `realLaunch` is consulted).
 */
function effectiveAuthorizedDir(): string {
  return authorizedDirFor(
    CLAUDECODE_SOURCE_ID,
    process.env[AUTHORIZED_DIR_ENV],
    defaultAuthorizedDir(),
  );
}

/** Config for the Claude Code source (authorized dir is configurable). */
export interface ClaudecodeSourceConfig {
  /** The ONE authorized dir CC runs in. Default `~/.plexus/workspace/claudecode`. */
  authorizedDir?: string;
}

/**
 * Lifecycle-layer source for Claude Code. `checkRequirements()` + `health()` derive from
 * whether `claude` resolves through the platform seam. Availability is HEALTH-only — it
 * never hides the entry or blocks registration.
 */
export class ClaudecodeSource extends BaseCapabilitySource {
  readonly id = CLAUDECODE_SOURCE_ID;
  readonly label = "Claude Code";
  readonly transport = "ipc" as const;

  private readonly platform: PlatformServices;
  private readonly authorizedDir: string;

  constructor(platform: PlatformServices, config: ClaudecodeSourceConfig = {}) {
    super();
    this.platform = platform;
    this.authorizedDir = config.authorizedDir ?? defaultAuthorizedDir();
  }

  get jail(): string {
    return this.authorizedDir;
  }

  /**
   * Probe the launch precondition: `claude` must resolve (the thing we launch). NOT a
   * registration gate — `scan()` always returns the entry; an
   * unavailable precondition surfaces via `health()`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const claude = await this.platform.resolveBinary("claude");
    if (!claude) {
      return { ok: false, reason: "Claude Code (`claude`) not found on PATH" };
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
    return { ok: true, resolved: claude };
  }

  /** HEALTH probe: ok iff `claude` is present + the authorized dir is usable. */
  override async health(): Promise<SourceHealth> {
    const req = await this.checkRequirements();
    return req.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(req.reason ? { detail: req.reason } : {}) };
  }

  /** The full UNGATED entry set (the run capability + the how-to skill). */
  async scan(): Promise<CapabilityEntry[]> {
    return claudecodeEntries();
  }
}

/**
 * The Claude Code SourceModule. Registered in `src/sources/index.ts` MODULES;
 * discovery / availability / scan / invoke routing flow automatically. The authorized
 * dir defaults to `~/.plexus/workspace/claudecode`; override via `PLEXUS_CC_AUTHORIZED_DIR`.
 */
export const claudecodeSourceModule: SourceModule = {
  id: CLAUDECODE_SOURCE_ID,
  label: "Claude Code",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    // Precedence: persisted console setting > PLEXUS_CC_AUTHORIZED_DIR > default.
    return new ClaudecodeSource(deps, { authorizedDir: effectiveAuthorizedDir() });
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    const platform = getPlatformServices();
    const launcher = new ClaudeCodeLauncher({
      resolveBinary: (name) => platform.resolveBinary(name),
      authorizedDir: effectiveAuthorizedDir(),
    });
    return new ClaudecodeBridge(deps, sessionId, claudecodeEntries(), launcher);
  },
};
