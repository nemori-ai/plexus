/**
 * Things 3 FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is Things 3 (a local macOS task app). The SOURCE exposes a different
 * surface class from the other first-party sources:
 *   - READ  via the AppleScript dictionary (osascript) — `things.todos.list`,
 *     `things.projects.list` (grants:["read"]).
 *   - WRITE via the Things URL-scheme (`things:///add?...`) — `things.todos.add`
 *     (grants:["write"]) — a well-blast-radius "append a to-do" mechanism.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link ThingsSource} (lifecycle): `checkRequirements()` + `health()` probe Things
 *    via the injected provider's `available()` (real ⇒ osascript version probe;
 *    fake ⇒ ok). Availability is reported via HEALTH — it does NOT gate registration
 *    or hide entries (a not-installed Things still registers; it just shows unavailable).
 *    `scan()` always returns the full UNGATED entry set.
 *  - {@link ThingsBridge} (per-session): in-process handlers drive the injected
 *    ThingsProvider directly (AppleScript read / URL-scheme write).
 *
 * Registered in `src/sources/index.ts` MODULES; first-party via the reserved source id.
 * The OS-access provider is INJECTABLE: real by default, the FAKE when
 * `PLEXUS_FAKE_APPLE=1` or via an explicit constructor arg — so tests + the e2e probe
 * never reach real Things.
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
import { ThingsBridge } from "./bridge.ts";
import { THINGS_SOURCE_ID, thingsEntries } from "./entries.ts";
import {
  RealThingsProvider,
  selectThingsProvider,
  type ThingsProvider,
} from "./provider.ts";

/**
 * Lifecycle-layer source for Things 3. `checkRequirements()` + `health()` derive from
 * the injected provider's `available()` (osascript version probe in real; always-ok in
 * fake). Availability is HEALTH-only — it never hides entries or blocks registration.
 */
export class ThingsSource extends BaseCapabilitySource {
  readonly id = THINGS_SOURCE_ID;
  readonly label = "Things 3";
  // The capabilities are local in-process (ipc); the source-level transport advertises it.
  readonly transport = "ipc" as const;

  private readonly provider: ThingsProvider;

  /** `_platform` kept for the SourceModule shape; the OS seam lives in the provider. */
  constructor(_platform: PlatformServices, provider?: ThingsProvider) {
    super();
    // Real osascript/URL-scheme provider by default; fake when PLEXUS_FAKE_APPLE=1; or
    // an explicit injected provider (tests). Thread the platform's resolveBinary into
    // the real provider so osascript/open resolve through the seam.
    this.provider =
      provider ??
      (selectThingsProvider() instanceof RealThingsProvider
        ? new RealThingsProvider({ resolveBinary: (name) => _platform.resolveBinary(name) })
        : selectThingsProvider());
  }

  /**
   * Probe Things via the provider. `ok` reflects availability, but this is NOT a
   * registration gate — `scan()` always returns the full entry set; an unavailable
   * Things surfaces via `health()`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, ...(a.reason ? { resolved: a.reason } : {}) }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe via provider `available()`: reachable ⇒ ok; not installed ⇒
   * unavailable with a precise reason ("Things 3 not found — install it / grant
   * automation access"). The fake provider is always ok. Reported via HEALTH only —
   * it never blocks registration.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /** The full UNGATED entry set (two reads + one write + the how-to skill). */
  async scan(): Promise<CapabilityEntry[]> {
    return thingsEntries();
  }
}

/**
 * The Things 3 SourceModule. Registered in `src/sources/index.ts` MODULES; discovery /
 * availability / scan / invoke routing flow automatically (no core branching).
 */
export const thingsSourceModule: SourceModule = {
  id: THINGS_SOURCE_ID,
  label: "Things 3",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    return new ThingsSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge intercepts the Things capability ids and drives the injected provider
    // directly (fake when PLEXUS_FAKE_APPLE=1, else real); the skill takes the base path.
    return new ThingsBridge(deps, sessionId, thingsEntries());
  },
};
