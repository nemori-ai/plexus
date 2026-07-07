/**
 * Apple Calendar FIRST-PARTY SourceModule (READ-ONLY, v1).
 *
 * The CONNECTOR is the macOS Calendar app; the SOURCE exposes it as two READ-ONLY
 * capabilities + a usage skill. It mirrors the obsidian first-party pattern
 * (a `SourceModule` with `createSource`/`createBridge`, a lifecycle `CapabilitySource`
 * with `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `AppleCalendarSource` (lifecycle): `health()` probes the provider's `available()` —
 *    reachable+granted ⇒ ok; un-granted/unreachable ⇒ unavailable with a precise reason
 *    (the TCC onboarding instruction). `scan()` ALWAYS exposes the read-only entry set
 *    (registration is NOT hard-blocked on TCC — a not-yet-granted source still registers
 *    and shows unavailable+reason, like the obsidian-fs health pattern).
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
import { AppleCalendarBridge } from "./bridge.ts";
import { APPLE_CALENDAR_SOURCE_ID, appleCalendarEntries } from "./entries.ts";
import type { CalendarProvider } from "./calendar-reader.ts";
import { resolveCalendarProvider } from "./provider-select.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface AppleCalendarSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: CalendarProvider;
}

/**
 * Lifecycle-layer source for Apple Calendar. `health()` reflects the provider's
 * `available()`; `scan()` always exposes the read-only entry set (TCC is a health
 * signal, NOT a registration gate).
 */
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

  /**
   * Requirements DERIVE from the provider's availability probe. Reachable+granted ⇒ ok;
   * un-granted/unreachable ⇒ not-ok with the precise reason (the TCC onboarding message).
   * NOTE: this does NOT block registration — `scan()` still exposes the entries. The
   * gateway surfaces this as per-source HEALTH (unavailable + reason), like obsidian-fs.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Calendar reachable" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe — reflects the provider's availability. ok ⇒ "ok"; not ⇒ "unavailable"
   * with the precise reason. Under the FAKE provider this is always ok (no macOS
   * permission needed). Cheap; polled in the background by the health service.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /**
   * Enumerate the READ-ONLY entry set. ALWAYS the same two read capabilities + the
   * how-to-use skill — registration is never hard-blocked on TCC (a not-yet-granted
   * calendar must still register and show unavailable+reason; the source self-heals to
   * green once the user grants access).
   */
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
