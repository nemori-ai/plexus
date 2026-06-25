/**
 * Apple Reminders FIRST-PARTY SourceModule (read + write).
 *
 * The CONNECTOR is the macOS Reminders app. The SOURCE reaches it through the
 * injectable `RemindersProvider` seam (real osascript / fake in-memory). Two layers
 * per the frozen adapter contract (§6):
 *  - `AppleRemindersSource` (lifecycle): `checkRequirements()` + `health()` probe the
 *    provider's `available()` (the real impl trips macOS TCC); `scan()` returns the
 *    capability + skill entries. Registration is NOT hard-blocked on TCC — like the
 *    obsidian-fs health, an unavailable backend still registers and just reports
 *    `unavailable` with a precise, actionable reason.
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
import { AppleRemindersBridge } from "./bridge.ts";
import { APPLE_REMINDERS_SOURCE_ID, appleRemindersEntries } from "./entries.ts";
import { type RemindersProvider, selectRemindersProvider } from "./provider.ts";

/** Construction options. The provider is INJECTABLE so tests force the fake. */
export interface AppleRemindersSourceOptions {
  /** Inject a provider (tests/probe); when absent, `selectRemindersProvider()` chooses. */
  provider?: RemindersProvider;
}

/**
 * Lifecycle-layer source. `checkRequirements()` / `health()` reflect the provider's
 * `available()` (the real impl trips macOS TCC; the fake is always ok). `scan()`
 * surfaces the full entry set regardless of availability — registration is not
 * hard-blocked on TCC (the source registers + shows unavailable, like obsidian-fs).
 */
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

  /**
   * Availability probe via the provider's `available()`. The real osascript provider
   * trips macOS TCC here; a denial returns `ok:false` with the precise System-Settings
   * reason. The fake provider is always ok. Used to DERIVE health (and surfaced in
   * `resolved` when ok).
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const avail = await this.provider.available();
    if (avail.ok) {
      return { ok: true, resolved: "Reminders reachable" };
    }
    return {
      ok: false,
      reason:
        avail.reason ??
        "Reminders access not granted — approve Plexus in System Settings ▸ Privacy ▸ Reminders",
    };
  }

  /**
   * Per-source HEALTH (HEALTH protocol). Reflects `available()`: reachable ⇒ ok;
   * not ⇒ unavailable with the precise TCC reason. Does NOT block registration.
   */
  override async health(): Promise<SourceHealth> {
    const avail = await this.provider.available();
    return avail.ok
      ? { status: "ok" }
      : {
          status: "unavailable",
          detail:
            avail.reason ??
            "Reminders access not granted — approve Plexus in System Settings ▸ Privacy ▸ Reminders",
        };
  }

  /**
   * Enumerate the entries. ALWAYS returns the full set (reads, the write create, the
   * write complete, the how-to-use skill) — even when TCC is not yet granted — so the
   * capability is discoverable + grantable and its health carries the unavailable
   * reason (the obsidian-fs posture). Availability is reported via health, not by
   * hiding entries.
   */
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
