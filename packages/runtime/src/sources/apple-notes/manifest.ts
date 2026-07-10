/**
 * Apple Notes FIRST-PARTY SourceModule (read + CREATE-ONLY write).
 *
 * The CONNECTOR is the macOS Notes app. The SOURCE reaches it through the injectable
 * `NotesProvider` seam (real osascript/JXA / fake in-memory). Two layers per the
 * frozen adapter contract (§6):
 *  - `AppleNotesSource` (lifecycle): `checkRequirements()` + `health()` probe the
 *    provider's `available()` (the real impl trips the macOS Automation TCC bucket);
 *    `scan()` returns the capability + skill entries. Registration is NOT hard-blocked
 *    on TCC — like the obsidian-fs `vaultPathHealth` posture, an unavailable backend
 *    still registers and just reports `unavailable` with a precise, actionable reason
 *    (System Settings › Privacy & Security › Automation). Health NEVER throws.
 *  - `AppleNotesBridge` (per-session): REAL in-process handlers calling the provider
 *    (see bridge.ts).
 *
 * CREATE-ONLY WRITE SURFACE: the entry set has exactly one write (`notes.create`);
 * no update/delete/move capability exists anywhere in this source — structurally
 * absent, not merely denied (the provider seam has no such method).
 *
 * Registered in `src/sources/index.ts` MODULES; first-party via the reserved source
 * id (RESERVED_SOURCE_IDS). The fake provider (`PLEXUS_FAKE_APPLE=1`, the shared
 * apple-* env) needs NO macOS permission, so tests run green without real TCC.
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
import { AppleNotesBridge } from "./bridge.ts";
import { APPLE_NOTES_SOURCE_ID, appleNotesEntries } from "./entries.ts";
import { NOTES_TCC_MESSAGE, selectNotesProvider, type NotesProvider } from "./provider.ts";

/** Construction options. The provider is INJECTABLE so tests force the fake. */
export interface AppleNotesSourceOptions {
  /** Inject a provider (tests/probe); when absent, `selectNotesProvider()` chooses. */
  provider?: NotesProvider;
}

/**
 * Lifecycle-layer source. `checkRequirements()` / `health()` reflect the provider's
 * `available()` (the real impl trips the macOS Automation prompt; the fake is always
 * ok). `scan()` surfaces the full entry set regardless of availability — registration
 * is not hard-blocked on TCC.
 */
export class AppleNotesSource extends BaseCapabilitySource {
  readonly id = APPLE_NOTES_SOURCE_ID;
  readonly label = "Apple Notes";
  readonly transport = "ipc" as const;

  private readonly provider: NotesProvider;

  constructor(_platform: PlatformServices, options: AppleNotesSourceOptions = {}) {
    super();
    this.provider = selectNotesProvider(options.provider);
  }

  /**
   * Availability probe via the provider's `available()`. The real osascript provider
   * trips the macOS Automation TCC prompt here; a denial returns `ok:false` with the
   * precise System-Settings instruction. NEVER throws; never blocks registration.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const avail = await this.provider.available();
    if (avail.ok) return { ok: true, resolved: "Notes reachable" };
    return { ok: false, reason: avail.reason ?? NOTES_TCC_MESSAGE };
  }

  /**
   * Per-source HEALTH. Reflects `available()`: reachable ⇒ ok; not ⇒ "unavailable"
   * with the precise Automation reason (System Settings › Privacy & Security ›
   * Automation). Advisory only — does NOT block registration (the vaultPathHealth
   * philosophy: an un-granted source registers, shows red, and self-heals to green
   * once the user grants access).
   */
  override async health(): Promise<SourceHealth> {
    const avail = await this.provider.available();
    return avail.ok
      ? { status: "ok" }
      : { status: "unavailable", detail: avail.reason ?? NOTES_TCC_MESSAGE };
  }

  /**
   * Enumerate the entries. ALWAYS returns the full set (three reads, the ONE create
   * write, the how-to-use skill) — even when TCC is not yet granted — so the
   * capabilities are discoverable + grantable while health carries the unavailable
   * reason. Availability is reported via health, never by hiding entries.
   */
  async scan(): Promise<CapabilityEntry[]> {
    return appleNotesEntries();
  }
}

/**
 * The Apple Notes SourceModule. Registered in `src/sources/index.ts` MODULES;
 * discovery / availability / scan / invoke routing flow automatically. First-party
 * via the reserved source id.
 */
export const appleNotesSourceModule: SourceModule = {
  id: APPLE_NOTES_SOURCE_ID,
  label: "Apple Notes",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    return new AppleNotesSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new AppleNotesBridge(deps, sessionId, appleNotesEntries());
  },
};
