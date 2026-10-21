/**
 * Apple Calendar FIRST-PARTY SourceModule (READ-ONLY, v1).
 *
 * The CONNECTOR is the macOS Calendar app; the SOURCE exposes it as two READ-ONLY
 * capabilities + a usage skill. It mirrors the obsidian first-party pattern
 * (a `SourceModule` with `createSource`/`createBridge`, a lifecycle `CapabilitySource`
 * with `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `AppleCalendarSource` (lifecycle): installation checks are passive; an installed app
 *    reports unknown health while access is unchecked. No application is launched
 *    and no permission is requested. `scan()` always returns the capability entries.
 *  - `AppleCalendarBridge` (per-session): in-process read handlers that read through the
 *    injected `CalendarProvider`.
 *
 * The OS-access seam (`CalendarProvider`) is selected real-by-default, FAKE when
 * `PLEXUS_FAKE_APPLE=1` (tests + hermetic e2e), or injected directly for unit tests.
 *
 * Registered in `src/sources/index.ts` MODULES + reserved in `RESERVED_SOURCE_IDS`, so
 * provenance is "first-party" and a wire extension cannot impersonate it. READ-ONLY by
 * construction — both capabilities are `["read"]`, and the provider seam has no write path.
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
import { appleAvailabilityHealth } from "../apple-availability.ts";
import { AppleCalendarBridge } from "./bridge.ts";
import { APPLE_CALENDAR_SOURCE_ID, appleCalendarEntries } from "./entries.ts";
import type { CalendarProvider } from "./calendar-reader.ts";
import { resolveCalendarProvider } from "./provider-select.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface AppleCalendarSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: CalendarProvider;
}

/** Lifecycle source with passive requirements and health checks. */
export class AppleCalendarSource extends BaseCapabilitySource {
  readonly id = APPLE_CALENDAR_SOURCE_ID;
  readonly label = "Apple Calendar (read-only)";
  // The capabilities are served by in-process read handlers — an ipc (local) transport.
  readonly transport = "ipc" as const;

  private readonly provider: CalendarProvider;

  constructor(options: AppleCalendarSourceOptions = {}) {
    super();
    this.provider = options.provider ?? resolveCalendarProvider();
  }

  /** Check installation without launching the app or requesting permission. */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Calendar installed" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /** Do not claim healthy access until it has actually been checked. */
  override async health(): Promise<SourceHealth> {
    return appleAvailabilityHealth(await this.provider.available());
  }

  /** Static capability catalog; installation and permission never block discovery. */
  async scan(): Promise<CapabilityEntry[]> {
    return appleCalendarEntries();
  }
}

/**
 * The Apple Calendar (read-only) SourceModule. Registered in `src/sources/index.ts`
 * MODULES. The bridge serves the two read capabilities via in-process handlers (provider
 * selected real/fake by env); the how-to-use skill takes the standard base path.
 */
export const appleCalendarSourceModule: SourceModule = {
  id: APPLE_CALENDAR_SOURCE_ID,
  label: "Apple Calendar (read-only)",
  transport: "ipc",
  createSource(_deps: PlatformServices): CapabilitySource {
    return new AppleCalendarSource();
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new AppleCalendarBridge(deps, sessionId, appleCalendarEntries());
  },
};
