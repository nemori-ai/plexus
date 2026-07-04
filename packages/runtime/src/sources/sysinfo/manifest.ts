/**
 * sysinfo FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is the local Unix host; the SOURCE exposes a READ-ONLY system-resource +
 * syslog surface — the Linux child's half of the mesh flagship flow:
 *   - `sysinfo.processes.list` — top-N running processes (via `ps`, portable).
 *   - `sysinfo.resources.read` — cpu load + memory + per-filesystem disk (via `os` + `df`).
 *   - `sysinfo.log.read`       — the TAIL of a system/security/access log, PATH-JAILED to an
 *                                allowlisted log root (`PLEXUS_SYSINFO_LOG_DIR`, default
 *                                `/var/log`) + tail-bounded.
 * ALL THREE are `grants:["read"]` (auto-grant). There is NO write/exec path in this source.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link SysinfoSource} (lifecycle): `checkRequirements()` + `health()` probe the log root
 *    via the injected provider's `available()`. Availability is HEALTH-only — it never gates
 *    registration or hides entries. `scan()` always returns the full UNGATED entry set.
 *  - {@link SysinfoBridge} (per-session): in-process handlers drive the injected
 *    SysinfoProvider directly (`ps`/`df`/confined-fs), then normalize + audit.
 *
 * PORTABLE by construction (`ps`/`df`/`os` + pure-code path-jail), so it is registered in
 * `LINUX_PORTABLE_MODULE_IDS` (index.ts) and runs on the Linux child AND the dev Mac. The
 * provider is INJECTABLE: real by default, the FAKE (canned data) when `PLEXUS_FAKE_SYSINFO=1`
 * or via a constructor arg — so tests + the e2e probe never touch `/var/log` or spawn a process.
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
import { SysinfoBridge } from "./bridge.ts";
import { SYSINFO_SOURCE_ID, sysinfoEntries } from "./entries.ts";
import { selectSysinfoProvider, type SysinfoProvider } from "./provider.ts";

/**
 * Lifecycle-layer source for sysinfo. `checkRequirements()` + `health()` derive from the
 * injected provider's `available()` (the allowlisted log root exists + is a directory in
 * real; always-ok in fake). Availability is HEALTH-only — it never hides entries or blocks
 * registration (processes/resources still work even if the log root is missing).
 */
export class SysinfoSource extends BaseCapabilitySource {
  readonly id = SYSINFO_SOURCE_ID;
  readonly label = "System Info";
  // The capabilities are local in-process (ipc); the source-level transport advertises it.
  readonly transport = "ipc" as const;

  private readonly provider: SysinfoProvider;

  /** `_platform` kept for the SourceModule shape; the OS-read seam lives in the provider. */
  constructor(_platform: PlatformServices, provider?: SysinfoProvider) {
    super();
    // Real provider by default (log root from PLEXUS_SYSINFO_LOG_DIR); fake when
    // PLEXUS_FAKE_SYSINFO=1; or an explicit injected provider (tests).
    this.provider = selectSysinfoProvider(provider);
  }

  /**
   * Probe the allowlisted log root via the provider. `ok` reflects log-root reachability,
   * but this is NOT a registration gate — `scan()` always returns the full entry set; an
   * unavailable/unconfigured log root surfaces via `health()`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, ...(a.reason ? { resolved: a.reason } : {}) }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe via provider `available()`: log root reachable ⇒ ok; missing/unconfigured
   * ⇒ unavailable with a precise reason. Reported via HEALTH only — never blocks registration.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /** The full UNGATED entry set (processes + resources + log + the how-to skill). */
  async scan(): Promise<CapabilityEntry[]> {
    return sysinfoEntries();
  }
}

/**
 * The sysinfo SourceModule. Registered in `src/sources/index.ts` MODULES (and in
 * `LINUX_PORTABLE_MODULE_IDS`, since it is portable); discovery / availability / scan /
 * invoke routing flow automatically (no core branching). The log root defaults to `/var/log`;
 * override via `PLEXUS_SYSINFO_LOG_DIR`.
 */
export const sysinfoSourceModule: SourceModule = {
  id: SYSINFO_SOURCE_ID,
  label: "System Info",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    return new SysinfoSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge intercepts the sysinfo capability ids and drives the injected provider
    // (fake when PLEXUS_FAKE_SYSINFO=1, else real); the skill takes the base path.
    return new SysinfoBridge(deps, sessionId, sysinfoEntries());
  },
};
