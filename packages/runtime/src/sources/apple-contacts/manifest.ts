/**
 * Apple Contacts FIRST-PARTY SourceModule (STRICTLY READ-ONLY, v1).
 *
 * The CONNECTOR is the macOS Contacts app; the SOURCE exposes it as two READ-ONLY
 * capabilities + a usage skill, mirroring the apple-calendar first-party pattern
 * (a `SourceModule` with `createSource`/`createBridge`, a lifecycle `CapabilitySource`
 * with `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `AppleContactsSource` (lifecycle): installation checks are passive; an installed app
 *    reports unknown health while access is unchecked. No application is launched
 *    and no permission is requested. `scan()` always returns the capability entries.
 *  - `AppleContactsBridge` (per-session): in-process read handlers through the
 *    injected `ContactsProvider`.
 *
 * The OS-access seam (`ContactsProvider`) is selected real-by-default, FAKE when
 * `PLEXUS_FAKE_APPLE=1` (tests + hermetic e2e), or injected directly for unit tests.
 *
 * Registered in `src/sources/index.ts` MODULES + reserved in `RESERVED_SOURCE_IDS`, so
 * provenance is "first-party" and a wire extension cannot impersonate it. READ-ONLY by
 * construction — both capabilities are `["read"]`; the seam has no write path.
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
import { AppleContactsBridge } from "./bridge.ts";
import { APPLE_CONTACTS_SOURCE_ID, appleContactsEntries } from "./entries.ts";
import { selectContactsProvider, type ContactsProvider } from "./provider.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface AppleContactsSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: ContactsProvider;
}

/** Lifecycle source with passive requirements and health checks. */
export class AppleContactsSource extends BaseCapabilitySource {
  readonly id = APPLE_CONTACTS_SOURCE_ID;
  readonly label = "Apple Contacts (read-only)";
  // The capabilities are served by in-process read handlers — an ipc (local) transport.
  readonly transport = "ipc" as const;

  private readonly provider: ContactsProvider;

  constructor(options: AppleContactsSourceOptions = {}) {
    super();
    this.provider = selectContactsProvider(options.provider);
  }

  /** Check installation without launching the app or requesting permission. */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Contacts installed" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /** Do not claim healthy access until it has actually been checked. */
  override async health(): Promise<SourceHealth> {
    return appleAvailabilityHealth(await this.provider.available());
  }

  /** Static capability catalog; installation and permission never block discovery. */
  async scan(): Promise<CapabilityEntry[]> {
    return appleContactsEntries();
  }
}

/**
 * The Apple Contacts (read-only) SourceModule. Registered in `src/sources/index.ts`
 * MODULES. The bridge serves the two read capabilities via in-process handlers
 * (provider selected real/fake by env); the how-to-use skill takes the base path.
 */
export const appleContactsSourceModule: SourceModule = {
  id: APPLE_CONTACTS_SOURCE_ID,
  label: "Apple Contacts (read-only)",
  transport: "ipc",
  createSource(_deps: PlatformServices): CapabilitySource {
    return new AppleContactsSource();
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new AppleContactsBridge(deps, sessionId, appleContactsEntries());
  },
};
