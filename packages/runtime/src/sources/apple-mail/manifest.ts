/**
 * Apple Mail FIRST-PARTY SourceModule (STRICTLY READ-ONLY, v1).
 *
 * The CONNECTOR is the macOS Mail app; the SOURCE exposes it as three READ-ONLY
 * capabilities + a usage skill, mirroring the apple-calendar first-party pattern
 * (a `SourceModule` with `createSource`/`createBridge`, a lifecycle `CapabilitySource`
 * with `checkRequirements`/`scan`/`health`, plus a per-session bridge).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `AppleMailSource` (lifecycle): `health()` probes the provider's `available()` —
 *    reachable+granted ⇒ ok; un-granted/unreachable ⇒ unavailable with a precise reason
 *    (the Automation-TCC onboarding instruction: System Settings ▸ Privacy & Security ▸
 *    Automation ▸ Mail). `scan()` ALWAYS exposes the read-only entry set — registration
 *    is NEVER hard-blocked on TCC (the vaultPathHealth / apple-calendar precedent: a
 *    not-yet-granted source still registers and shows unavailable+reason).
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
import { AppleMailBridge } from "./bridge.ts";
import { APPLE_MAIL_SOURCE_ID, appleMailEntries } from "./entries.ts";
import { selectMailProvider, type MailProvider } from "./provider.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface AppleMailSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_APPLE`). */
  provider?: MailProvider;
}

/**
 * Lifecycle-layer source for Apple Mail. `health()` reflects the provider's
 * `available()`; `scan()` always exposes the read-only entry set (TCC is a health
 * signal, NOT a registration gate). NEVER throws from the probes.
 */
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

  /**
   * Requirements DERIVE from the provider's availability probe. Reachable+granted ⇒ ok;
   * un-granted/unreachable ⇒ not-ok with the precise Automation onboarding reason.
   * Does NOT block registration — `scan()` still exposes the entries.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, resolved: "Apple Mail reachable" }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe — reflects the provider's availability. ok ⇒ "ok"; not ⇒ "unavailable"
   * with the precise reason (System Settings ▸ Privacy & Security ▸ Automation ▸ Mail).
   * Under the FAKE provider this is always ok. Cheap; polled in the background.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /**
   * Enumerate the READ-ONLY entry set. ALWAYS the same three read capabilities + the
   * how-to-use skill — registration is never hard-blocked on TCC (an un-granted Mail
   * still registers, shows unavailable+reason, and self-heals to green once granted).
   */
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
