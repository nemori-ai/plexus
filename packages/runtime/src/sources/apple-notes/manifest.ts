/**
 * Apple Notes FIRST-PARTY SourceModule (read + CREATE-ONLY write).
 *
 * The CONNECTOR is the macOS Notes app. The SOURCE reaches it through the injectable
 * `NotesProvider` seam (real osascript/JXA / fake in-memory). Two layers per the
 * frozen adapter contract (§6):
 *  - `AppleNotesSource` (lifecycle): installation checks are passive; an installed app
 *    reports unknown health while access is unchecked. No application is launched
 *    and no permission is requested. `scan()` always returns the capability entries.
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
import { appleAvailabilityHealth } from "../apple-availability.ts";
import { AppleNotesBridge } from "./bridge.ts";
import { APPLE_NOTES_SOURCE_ID, appleNotesEntries } from "./entries.ts";
import { NOTES_TCC_MESSAGE, selectNotesProvider, type NotesProvider } from "./provider.ts";

/** Construction options. The provider is INJECTABLE so tests force the fake. */
export interface AppleNotesSourceOptions {
  /** Inject a provider (tests/probe); when absent, `selectNotesProvider()` chooses. */
  provider?: NotesProvider;
}

/** Lifecycle source with passive requirements and health checks. */
export class AppleNotesSource extends BaseCapabilitySource {
  readonly id = APPLE_NOTES_SOURCE_ID;
  readonly label = "Apple Notes";
  readonly transport = "ipc" as const;

  private readonly provider: NotesProvider;

  constructor(_platform: PlatformServices, options: AppleNotesSourceOptions = {}) {
    super();
    this.provider = selectNotesProvider(options.provider);
  }

  /** Check installation without launching the app or requesting permission. */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const avail = await this.provider.available();
    if (avail.ok) return { ok: true, resolved: "Notes installed" };
    return { ok: false, reason: avail.reason ?? NOTES_TCC_MESSAGE };
  }

  /** Do not claim healthy access until it has actually been checked. */
  override async health(): Promise<SourceHealth> {
    return appleAvailabilityHealth(await this.provider.available());
  }

  /** Static capability catalog; installation and permission never block discovery. */
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
