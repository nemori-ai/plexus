/**
 * Claude Code sandboxed-run FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is Claude Code, exposed as ONE sensitive capability — `claudecode.run`
 * — that launches headless CC CONFINED by macOS `sandbox-exec` to the authorized
 * directory (the same dir the workspace source uses). `grants:["execute"]` ⇒ the
 * gateway PENDS it for the owner. The calling agent never sees a shell or the launch
 * command; CC's read/write outside the jail fails at the kernel (GOAL §4 / AC5 / AC6).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link ClaudecodeSource} (lifecycle): `checkRequirements()` + `health()` report
 *    whether `claude` resolves AND `sandbox-exec` exists (the confinement primitive).
 *    Availability is HEALTH-only — it never gates registration or hides the entry.
 *    `scan()` always returns the full UNGATED entry set.
 *  - {@link ClaudecodeBridge} (per-session): an in-process handler drives the injected
 *    {@link SandboxedClaudeLauncher} (which wraps the real `claude` spawn in
 *    sandbox-exec); the REAL spawn is gated behind `PLEXUS_CC_HEADLESS_LAUNCH=1`.
 *
 * The authorized dir is CONFIGURABLE (constructor/config), default
 * `~/PlexusDemo/pomodoro`. The orchestrator registers this module in
 * `src/sources/index.ts` MODULES; the reserved source id ⇒ first-party provenance.
 */

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
import {
  DarwinSandboxBackend,
  selectSandboxBackend,
  type SandboxBackend,
} from "../../platform/sandbox-backend.ts";
import { ClaudecodeBridge } from "./bridge.ts";
import { CLAUDECODE_SOURCE_ID, claudecodeEntries } from "./entries.ts";
import {
  SandboxedClaudeLauncher,
  defaultAuthorizedDir,
} from "./launcher.ts";

/** Config for the Claude Code source (authorized dir is configurable). */
export interface ClaudecodeSourceConfig {
  /** The ONE authorized dir CC is confined to. Default `~/PlexusDemo/pomodoro`. */
  authorizedDir?: string;
  /** LEGACY: the `sandbox-exec` binary path — pins a darwin backend for health. */
  sandboxExec?: string;
  /**
   * The kernel-confinement backend whose availability `health()` probes (P3-5). Default:
   * platform-selected (`bwrap` on linux, `sandbox-exec` elsewhere). Tests inject it.
   */
  sandbox?: SandboxBackend;
}

/**
 * Lifecycle-layer source for Claude Code (sandboxed run). `checkRequirements()` +
 * `health()` derive from whether `claude` resolves through the platform seam AND the
 * `sandbox-exec` confinement primitive exists. Availability is HEALTH-only — it never
 * hides the entry or blocks registration.
 */
export class ClaudecodeSource extends BaseCapabilitySource {
  readonly id = CLAUDECODE_SOURCE_ID;
  readonly label = "Claude Code (sandboxed)";
  readonly transport = "ipc" as const;

  private readonly platform: PlatformServices;
  private readonly authorizedDir: string;
  private readonly sandbox: SandboxBackend;

  constructor(platform: PlatformServices, config: ClaudecodeSourceConfig = {}) {
    super();
    this.platform = platform;
    this.authorizedDir = config.authorizedDir ?? defaultAuthorizedDir();
    // Precedence: explicit backend > legacy sandboxExec (→ darwin) > platform-selected.
    this.sandbox =
      config.sandbox ??
      (config.sandboxExec !== undefined
        ? new DarwinSandboxBackend({ sandboxExec: config.sandboxExec })
        : selectSandboxBackend(platform.platform));
  }

  /** The authorized (jail) dir this source confines CC to. */
  get jail(): string {
    return this.authorizedDir;
  }

  /**
   * Probe the confinement preconditions: `sandbox-exec` must exist (the kernel jail)
   * and `claude` must resolve (the thing we launch). NOT a registration gate — `scan()`
   * always returns the entry; an unavailable precondition surfaces via `health()`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    if (!this.sandbox.isAvailableSync()) {
      return {
        ok: false,
        reason: `${this.sandbox.mechanism} confinement unavailable — cannot jail Claude Code`,
      };
    }
    const claude = await this.platform.resolveBinary("claude");
    if (!claude) {
      return { ok: false, reason: "Claude Code (`claude`) not found on PATH" };
    }
    return { ok: true, resolved: claude };
  }

  /** HEALTH probe: ok iff sandbox-exec + claude are both present. */
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
 * dir defaults to `~/PlexusDemo/pomodoro`; override via `PLEXUS_CC_AUTHORIZED_DIR`.
 */
export const claudecodeSourceModule: SourceModule = {
  id: CLAUDECODE_SOURCE_ID,
  label: "Claude Code (sandboxed)",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    const env = process.env.PLEXUS_CC_AUTHORIZED_DIR;
    return new ClaudecodeSource(deps, env ? { authorizedDir: env } : {});
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge intercepts `claudecode.run` and drives a SandboxedClaudeLauncher
    // confined to the authorized dir; the skill takes the base path. The launcher's
    // real spawn is gated behind PLEXUS_CC_HEADLESS_LAUNCH=1 (default OFF). We build
    // the launcher here so the PLEXUS_CC_AUTHORIZED_DIR override flows in; it resolves
    // `claude` through the live platform seam.
    const env = process.env.PLEXUS_CC_AUTHORIZED_DIR;
    const platform = getPlatformServices();
    const launcher = new SandboxedClaudeLauncher({
      resolveBinary: (name) => platform.resolveBinary(name),
      // Confine via the platform-selected backend (bwrap on linux, sandbox-exec on darwin).
      sandbox: selectSandboxBackend(platform.platform),
      ...(env ? { authorizedDir: env } : {}),
    });
    return new ClaudecodeBridge(deps, sessionId, claudecodeEntries(), launcher);
  },
};
