/**
 * Apple Photos FIRST-PARTY SourceModule (READ-ONLY posture, v1).
 *
 * The CONNECTOR is macOS Photos.app; the SOURCE exposes it as three READ capabilities +
 * a usage skill, mirroring the apple-calendar first-party pattern (a `SourceModule` with
 * `createSource`/`createBridge`, a lifecycle `CapabilitySource` with
 * `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `ApplePhotosSource` (lifecycle): `health()` probes the provider's `available()` —
 *    reachable+granted ⇒ ok; un-granted/unreachable ⇒ unavailable with the precise
 *    Automation-TCC onboarding reason. `scan()` ALWAYS exposes the entry set —
 *    registration is NOT hard-blocked on TCC (a not-yet-granted source still registers
 *    and shows unavailable+reason; the vaultPathHealth precedent). NEVER throws.
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
import { ApplePhotosBridge } from "./bridge.ts";
import { APPLE_PHOTOS_SOURCE_ID, applePhotosEntries } from "./entries.ts";
import { selectPhotosProvider, type PhotosProvider } from "./provider.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface ApplePhotosSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: PhotosProvider;
}

/**
 * Lifecycle-layer source for Apple Photos. `health()` reflects the provider's
 * `available()`; `scan()` always exposes the entry set (TCC is a health signal, NOT a
 * registration gate).
 */
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

  /**
   * Requirements DERIVE from the provider's availability probe. Reachable+granted ⇒ ok;
   * un-granted/unreachable ⇒ not-ok with the precise reason (the Automation-TCC
   * onboarding message). Does NOT block registration — `scan()` still exposes the
   * entries; the gateway surfaces this as per-source HEALTH (unavailable + reason).
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Photos reachable" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe — reflects the provider's availability. ok ⇒ "ok"; not ⇒ "unavailable"
   * with the precise reason (System Settings ▸ Privacy & Security ▸ Automation ▸ Photos).
   * Under the FAKE provider this is always ok (no macOS permission needed). NEVER
   * throws (`available()` degrades every failure to `{ok:false, reason}`); cheap; polled
   * in the background by the health service.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /**
   * Enumerate the entry set. ALWAYS the same three read capabilities + the how-to-use
   * skill — registration is never hard-blocked on TCC (a not-yet-granted Photos must
   * still register and show unavailable+reason; it self-heals to green once granted).
   */
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
