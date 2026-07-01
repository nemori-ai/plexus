/**
 * Codex sandboxed-run FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is the local Codex CLI, exposed as ONE sensitive capability —
 * `codex.run` — that launches headless `codex exec` CONFINED by macOS `sandbox-exec`
 * to the authorized directory (the same dir the workspace / claudecode sources use).
 * `grants:["execute"]` ⇒ the gateway PENDS it for the owner. The calling agent never
 * sees a shell or the launch command; Codex's read/write outside the jail fails at the
 * kernel. The Codex analog of the claudecode SourceModule.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link CodexSource} (lifecycle): `checkRequirements()` + `health()` report whether
 *    `codex` resolves AND `sandbox-exec` exists (the confinement primitive). Availability
 *    is HEALTH-only — it never gates registration or hides the entry. `scan()` always
 *    returns the full UNGATED entry set.
 *  - {@link CodexBridge} (per-session): an in-process handler drives the injected
 *    {@link SandboxedCodexLauncher} (which wraps the real `codex exec` spawn in
 *    sandbox-exec); the REAL spawn is gated behind `PLEXUS_CODEX_HEADLESS_LAUNCH=1`.
 *
 * The authorized dir is CONFIGURABLE (constructor/config), default
 * `~/PlexusDemo/pomodoro`; override via `PLEXUS_CODEX_AUTHORIZED_DIR`.
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
import { CodexBridge } from "./bridge.ts";
import { CODEX_SOURCE_ID, codexEntries } from "./entries.ts";
import {
  CODEX_BINARY,
  SandboxedCodexLauncher,
  defaultAuthorizedDir,
} from "./launcher.ts";

/** Config for the Codex source (authorized dir is configurable). */
export interface CodexSourceConfig {
  /** The ONE authorized dir Codex is confined to. Default `~/PlexusDemo/pomodoro`. */
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
 * Lifecycle-layer source for Codex (sandboxed run). `checkRequirements()` + `health()`
 * derive from whether `codex` resolves through the platform seam AND the `sandbox-exec`
 * confinement primitive exists. Availability is HEALTH-only — it never hides the entry
 * or blocks registration; a missing `codex` CLI degrades health to "unavailable".
 */
export class CodexSource extends BaseCapabilitySource {
  readonly id = CODEX_SOURCE_ID;
  readonly label = "Codex";
  readonly transport = "ipc" as const;

  private readonly platform: PlatformServices;
  private readonly authorizedDir: string;
  private readonly sandbox: SandboxBackend;

  constructor(platform: PlatformServices, config: CodexSourceConfig = {}) {
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

  /** The authorized (jail) dir this source confines Codex to. */
  get jail(): string {
    return this.authorizedDir;
  }

  /**
   * Probe the confinement preconditions: `sandbox-exec` must exist (the kernel jail)
   * and `codex` must resolve (the thing we launch). NOT a registration gate — `scan()`
   * always returns the entry; an unavailable precondition surfaces via `health()`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    if (!this.sandbox.isAvailableSync()) {
      return {
        ok: false,
        reason: `${this.sandbox.mechanism} confinement unavailable — cannot jail Codex`,
      };
    }
    const codex = await this.platform.resolveBinary(CODEX_BINARY);
    if (!codex) {
      return { ok: false, reason: "Codex CLI (`codex`) not found on PATH" };
    }
    return { ok: true, resolved: codex };
  }

  /** HEALTH probe: ok iff sandbox-exec + codex are both present, else unavailable. */
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
 * to `~/PlexusDemo/pomodoro`; override via `PLEXUS_CODEX_AUTHORIZED_DIR`.
 */
export const codexSourceModule: SourceModule = {
  id: CODEX_SOURCE_ID,
  label: "Codex",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    const env = process.env.PLEXUS_CODEX_AUTHORIZED_DIR;
    return new CodexSource(deps, env ? { authorizedDir: env } : {});
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge intercepts `codex.run` and drives a SandboxedCodexLauncher confined to
    // the authorized dir. The launcher's real spawn is gated behind
    // PLEXUS_CODEX_HEADLESS_LAUNCH=1 (default OFF). We build the launcher here so the
    // PLEXUS_CODEX_AUTHORIZED_DIR override flows in; it resolves `codex` through the
    // live platform seam.
    const env = process.env.PLEXUS_CODEX_AUTHORIZED_DIR;
    const platform = getPlatformServices();
    const launcher = new SandboxedCodexLauncher({
      resolveBinary: (name) => platform.resolveBinary(name),
      // Confine via the platform-selected backend (bwrap on linux, sandbox-exec on darwin).
      sandbox: selectSandboxBackend(platform.platform),
      ...(env ? { authorizedDir: env } : {}),
    });
    return new CodexBridge(deps, sessionId, codexEntries(), launcher);
  },
};
