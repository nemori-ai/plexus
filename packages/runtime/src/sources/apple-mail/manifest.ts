/**
 * Apple Mail FIRST-PARTY SourceModule (STRICTLY READ-ONLY, v1).
 *
 * The CONNECTOR is the macOS Mail app; the SOURCE exposes it as three READ-ONLY
 * capabilities + a usage skill, mirroring the apple-calendar first-party pattern
 * (a `SourceModule` with `createSource`/`createBridge`, a lifecycle `CapabilitySource`
 * with `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `AppleMailSource` (lifecycle): installation checks are passive; an installed app
 *    reports unknown health while access is unchecked. No application is launched
 *    and no permission is requested. `scan()` always returns the capability entries.
 *  - `AppleMailBridge` (per-session): in-process read handlers through the injected
 *    `MailProvider`.
 *
 * The OS-access seam (`MailProvider`) is selected real-by-default, FAKE when
 * `PLEXUS_FAKE_APPLE=1` (tests + hermetic e2e), or injected directly for unit tests.
 *
 * Registered in `src/sources/index.ts` MODULES + reserved in `RESERVED_SOURCE_IDS`, so
 * provenance is "first-party" and a wire extension cannot impersonate it. READ-ONLY by
 * construction — all capabilities are `["read"]`; NO draft/send/write capability exists.
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
import { AppleMailBridge } from "./bridge.ts";
import { APPLE_MAIL_SOURCE_ID, appleMailEntries } from "./entries.ts";
import { selectMailProvider, type MailProvider } from "./provider.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface AppleMailSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: MailProvider;
}

/** Lifecycle source with passive requirements and health checks. */
export class AppleMailSource extends BaseCapabilitySource {
  readonly id = APPLE_MAIL_SOURCE_ID;
  readonly label = "Apple Mail (read-only)";
  // The capabilities are served by in-process read handlers — an ipc (local) transport.
  readonly transport = "ipc" as const;

  private readonly provider: MailProvider;

  constructor(options: AppleMailSourceOptions = {}) {
    super();
    this.provider = selectMailProvider(options.provider);
  }

  /** Check installation without launching the app or requesting permission. */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Mail installed" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /** Do not claim healthy access until it has actually been checked. */
  override async health(): Promise<SourceHealth> {
    return appleAvailabilityHealth(await this.provider.available());
  }

  /** Static capability catalog; installation and permission never block discovery. */
  async scan(): Promise<CapabilityEntry[]> {
    return appleMailEntries();
  }
}

/**
 * The Apple Mail (read-only) SourceModule. Registered in `src/sources/index.ts`
 * MODULES. The bridge serves the three read capabilities via in-process handlers
 * (provider selected real/fake by env); the how-to-use skill takes the base path.
 */
export const appleMailSourceModule: SourceModule = {
  id: APPLE_MAIL_SOURCE_ID,
  label: "Apple Mail (read-only)",
  transport: "ipc",
  createSource(_deps: PlatformServices): CapabilitySource {
    return new AppleMailSource();
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new AppleMailBridge(deps, sessionId, appleMailEntries());
  },
};
