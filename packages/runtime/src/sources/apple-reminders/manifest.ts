/**
 * Apple Reminders FIRST-PARTY SourceModule (read + write).
 *
 * The CONNECTOR is the macOS Reminders app. The SOURCE reaches it through the
 * injectable `RemindersProvider` seam (real osascript / fake in-memory). Two layers
 * per the frozen adapter contract (§6):
 *  - `AppleRemindersSource` (lifecycle): installation checks are passive; an installed app
 *    reports unknown health while access is unchecked. No application is launched
 *    and no permission is requested. `scan()` always returns the capability entries.
 *  - `AppleRemindersBridge` (per-session): REAL in-process handlers calling the
 *    provider (see bridge.ts).
 *
 * Registered in `src/sources/index.ts` MODULES; it is first-party via the reserved
 * source id (RESERVED_SOURCE_IDS). The fake provider (`PLEXUS_FAKE_APPLE=1`) needs NO
 * macOS permission, so tests + the hermetic probe run green without real TCC.
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
import { AppleRemindersBridge } from "./bridge.ts";
import { APPLE_REMINDERS_SOURCE_ID, appleRemindersEntries } from "./entries.ts";
import { type RemindersProvider, selectRemindersProvider } from "./provider.ts";

/** Construction options. The provider is INJECTABLE so tests force the fake. */
export interface AppleRemindersSourceOptions {
  /** Inject a provider (tests/probe); when absent, `selectRemindersProvider()` chooses. */
  provider?: RemindersProvider;
}

/** Lifecycle source with passive requirements and health checks. */
export class AppleRemindersSource extends BaseCapabilitySource {
  readonly id = APPLE_REMINDERS_SOURCE_ID;
  readonly label = "Apple Reminders";
  readonly transport = "ipc" as const;

  private readonly provider: RemindersProvider;

  constructor(
    _platform: PlatformServices,
    options: AppleRemindersSourceOptions = {},
  ) {
    super();
    this.provider = selectRemindersProvider(options.provider);
  }

  /** Check installation without launching the app or requesting permission. */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const avail = await this.provider.available();
    if (avail.ok) {
      return { ok: true, resolved: "Reminders installed" };
    }
    return {
      ok: false,
      reason:
        avail.reason ??
        "Reminders access not granted — approve Plexus in System Settings ▸ Privacy ▸ Reminders",
    };
  }

  /** Do not claim healthy access until it has actually been checked. */
  override async health(): Promise<SourceHealth> {
    return appleAvailabilityHealth(await this.provider.available());
  }

  /** Static capability catalog; installation and permission never block discovery. */
  async scan(): Promise<CapabilityEntry[]> {
    return appleRemindersEntries();
  }
}

/**
 * The Apple Reminders SourceModule. Registered in `src/sources/index.ts` MODULES;
 * discovery / availability / scan / invoke routing flow automatically. First-party via
 * the reserved source id.
 */
export const appleRemindersSourceModule: SourceModule = {
  id: APPLE_REMINDERS_SOURCE_ID,
  label: "Apple Reminders",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    return new AppleRemindersSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new AppleRemindersBridge(deps, sessionId, appleRemindersEntries());
  },
};
