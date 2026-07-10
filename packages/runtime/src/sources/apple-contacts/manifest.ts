/**
 * Apple Contacts FIRST-PARTY SourceModule (STRICTLY READ-ONLY, v1).
 *
 * The CONNECTOR is the macOS Contacts app; the SOURCE exposes it as two READ-ONLY
 * capabilities + a usage skill, mirroring the apple-calendar first-party pattern
 * (a `SourceModule` with `createSource`/`createBridge`, a lifecycle `CapabilitySource`
 * with `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `AppleContactsSource` (lifecycle): `health()` probes the provider's `available()`
 *    — reachable+granted ⇒ ok; un-granted/unreachable ⇒ unavailable with a precise
 *    reason (System Settings ▸ Privacy & Security ▸ Automation ▸ Contacts). `scan()`
 *    ALWAYS exposes the read-only entry set — registration is NEVER hard-blocked on
 *    TCC (the vaultPathHealth / apple-calendar precedent).
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
import { AppleContactsBridge } from "./bridge.ts";
import { APPLE_CONTACTS_SOURCE_ID, appleContactsEntries } from "./entries.ts";
import { selectContactsProvider, type ContactsProvider } from "./provider.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface AppleContactsSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: ContactsProvider;
}

/**
 * Lifecycle-layer source for Apple Contacts. `health()` reflects the provider's
 * `available()`; `scan()` always exposes the read-only entry set (TCC is a health
 * signal, NOT a registration gate). NEVER throws from the probes.
 */
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

  /**
   * Requirements DERIVE from the provider's availability probe. Reachable+granted ⇒ ok;
   * un-granted/unreachable ⇒ not-ok with the precise Automation onboarding reason.
   * Does NOT block registration — `scan()` still exposes the entries.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Contacts reachable" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe — reflects the provider's availability. ok ⇒ "ok"; not ⇒ "unavailable"
   * with the precise reason (System Settings ▸ Privacy & Security ▸ Automation ▸
   * Contacts). Under the FAKE provider this is always ok. Cheap; polled in background.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /**
   * Enumerate the READ-ONLY entry set. ALWAYS the same two read capabilities + the
   * how-to-use skill — registration is never hard-blocked on TCC (an un-granted
   * Contacts still registers, shows unavailable+reason, and self-heals once granted).
   */
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
