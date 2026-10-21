/**
 * Apple Photos FIRST-PARTY SourceModule (READ-ONLY posture, v1).
 *
 * The CONNECTOR is macOS Photos.app; the SOURCE exposes it as three READ capabilities +
 * a usage skill, mirroring the apple-calendar first-party pattern (a `SourceModule` with
 * `createSource`/`createBridge`, a lifecycle `CapabilitySource` with
 * `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `ApplePhotosSource` (lifecycle): installation checks are passive; an installed app
 *    reports unknown health while access is unchecked. No application is launched
 *    and no permission is requested. `scan()` always returns the capability entries.
 *  - `ApplePhotosBridge` (per-session): in-process handlers through the injected
 *    `PhotosProvider` (real osascript/JXA by default; fake under `PLEXUS_FAKE_APPLE=1`).
 *
 * POSTURE: every capability is `["read"]` — the provider seam has no library-mutating
 * method. The ONE disk side effect (`export`) writes only into the gateway-owned
 * `~/.plexus/exports/photos/` jail and is declared in the describe text + skill.
 *
 * Registered in `src/sources/index.ts` MODULES (⇒ reserved in `RESERVED_SOURCE_IDS`, so
 * provenance is "first-party" and a wire extension cannot impersonate it). macOS-only —
 * automatically gated OUT of the Linux active set by the portable-allowlist.
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
import { ApplePhotosBridge } from "./bridge.ts";
import { APPLE_PHOTOS_SOURCE_ID, applePhotosEntries } from "./entries.ts";
import { selectPhotosProvider, type PhotosProvider } from "./provider.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface ApplePhotosSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: PhotosProvider;
}

/** Lifecycle source with passive requirements and health checks. */
export class ApplePhotosSource extends BaseCapabilitySource {
  readonly id = APPLE_PHOTOS_SOURCE_ID;
  readonly label = "Apple Photos (read-only)";
  // The capabilities are served by in-process handlers — an ipc (local) transport.
  readonly transport = "ipc" as const;

  private readonly provider: PhotosProvider;

  constructor(options: ApplePhotosSourceOptions = {}) {
    super();
    this.provider = selectPhotosProvider(options.provider);
  }

  /** Check installation without launching the app or requesting permission. */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Photos installed" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /** Do not claim healthy access until it has actually been checked. */
  override async health(): Promise<SourceHealth> {
    return appleAvailabilityHealth(await this.provider.available());
  }

  /** Static capability catalog; installation and permission never block discovery. */
  async scan(): Promise<CapabilityEntry[]> {
    return applePhotosEntries();
  }
}

/**
 * The Apple Photos (read-only) SourceModule. Registered in `src/sources/index.ts`
 * MODULES. The bridge serves the three read capabilities via in-process handlers
 * (provider selected real/fake by env); the how-to-use skill takes the standard base path.
 */
export const applePhotosSourceModule: SourceModule = {
  id: APPLE_PHOTOS_SOURCE_ID,
  label: "Apple Photos (read-only)",
  transport: "ipc",
  createSource(_deps: PlatformServices): CapabilitySource {
    return new ApplePhotosSource();
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new ApplePhotosBridge(deps, sessionId, applePhotosEntries());
  },
};
