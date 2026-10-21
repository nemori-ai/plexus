/**
 * Apple Shortcuts FIRST-PARTY SourceModule.
 *
 * The CONNECTOR is Apple's Shortcuts app (macOS), reached through the injectable
 * `ShortcutsProvider` seam (real `shortcuts` CLI / fake in-memory when
 * `PLEXUS_FAKE_SHORTCUTS=1`). Two capabilities:
 *
 *   - `shortcuts.list` (read)    — enumerate shortcut names + folder names.
 *   - `shortcuts.run`  (EXECUTE) — run one named user-defined automation. Follows the
 *     claudecode/codex precedent EXACTLY: `grants:["execute"]` ⇒ the gateway PENDS it
 *     for the owner, and the REAL execution is additionally gated behind the owner's
 *     opt-in (persisted console `realLaunch` setting, `PLEXUS_SHORTCUTS_LAUNCH=1` env
 *     fallback; default OFF = record-mode — see the bridge).
 *
 * Two layers per the frozen adapter contract (§6):
 *  - `ShortcutsSource` (lifecycle): installation checks are passive; an installed app
 *    reports unknown health while access is unchecked. No application is launched
 *    and no permission is requested. `scan()` always returns the capability entries.
 *  - {@link ShortcutsBridge} (per-session): in-process handlers drive the provider;
 *    the execute gate lives in the bridge (see bridge.ts).
 *
 * Registered in `src/sources/index.ts` MODULES; the reserved source id ⇒ first-party
 * provenance. macOS-only by nature: NOT in the Linux portable allowlist, so on a
 * Linux gateway it stays gated out (never "advertised but dead").
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
import { ShortcutsBridge } from "./bridge.ts";
import { SHORTCUTS_SOURCE_ID, shortcutsEntries } from "./entries.ts";
import {
  selectShortcutsProvider,
  SHORTCUTS_UNAVAILABLE_REASON,
  type ShortcutsProvider,
} from "./provider.ts";

/** Construction options. The provider is INJECTABLE so tests force the fake. */
export interface ShortcutsSourceOptions {
  /** Inject a provider (tests/probe); when absent, `selectShortcutsProvider()` chooses. */
  provider?: ShortcutsProvider;
}

/** Lifecycle source with passive requirements and health checks. */
export class ShortcutsSource extends BaseCapabilitySource {
  readonly id = SHORTCUTS_SOURCE_ID;
  readonly label = "Apple Shortcuts";
  readonly transport = "ipc" as const;

  private readonly provider: ShortcutsProvider;

  constructor(_platform: PlatformServices, options: ShortcutsSourceOptions = {}) {
    super();
    this.provider = selectShortcutsProvider(options.provider);
  }

  /** Check installation without launching the app or requesting permission. */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    try {
      const avail = await this.provider.available();
      if (avail.ok) return { ok: true, resolved: "shortcuts CLI installed" };
      return { ok: false, reason: avail.reason ?? SHORTCUTS_UNAVAILABLE_REASON };
    } catch (err) {
      // Belt-and-braces: even a surprising provider failure never breaks the probe.
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Shortcuts unavailable: ${why}` };
    }
  }

  /** Do not claim healthy access until it has actually been checked. */
  override async health(): Promise<SourceHealth> {
    try {
      return appleAvailabilityHealth(await this.provider.available());
    } catch (err) {
      return { status: "unavailable", detail: `Shortcuts unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Static capability catalog; installation and permission never block discovery. */
  async scan(): Promise<CapabilityEntry[]> {
    return shortcutsEntries();
  }
}

/**
 * The Apple Shortcuts SourceModule. Registered in `src/sources/index.ts` MODULES;
 * discovery / availability / scan / invoke routing flow automatically.
 */
export const shortcutsSourceModule: SourceModule = {
  id: SHORTCUTS_SOURCE_ID,
  label: "Apple Shortcuts",
  transport: "ipc",
  createSource(deps: PlatformServices): CapabilitySource {
    return new ShortcutsSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    return new ShortcutsBridge(deps, sessionId, shortcutsEntries());
  },
};
