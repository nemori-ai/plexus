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
 *  - {@link ShortcutsSource} (lifecycle): `checkRequirements()` + `health()` derive
 *    from the provider's `available()` (`shortcuts` CLI present + responding).
 *    Availability is HEALTH-only — a missing CLI (non-macOS) reports "unavailable"
 *    with a reason; it never hides the entries or blocks registration, never throws.
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

/**
 * Lifecycle-layer source. `checkRequirements()` / `health()` reflect the provider's
 * `available()` (the real impl probes the `shortcuts` CLI; the fake is always ok).
 * `scan()` surfaces the full entry set regardless of availability — an absent CLI
 * (non-macOS) registers + reports "unavailable" with a reason, never a crash.
 */
export class ShortcutsSource extends BaseCapabilitySource {
  readonly id = SHORTCUTS_SOURCE_ID;
  readonly label = "Apple Shortcuts";
  readonly transport = "ipc" as const;

  private readonly provider: ShortcutsProvider;

  constructor(_platform: PlatformServices, options: ShortcutsSourceOptions = {}) {
    super();
    this.provider = selectShortcutsProvider(options.provider);
  }

  /**
   * Availability probe via the provider's `available()`. NEVER throws — a missing
   * `shortcuts` CLI (non-macOS) returns `ok:false` with the actionable reason. Not a
   * registration gate: `scan()` always returns the entries; this surfaces via health.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    try {
      const avail = await this.provider.available();
      if (avail.ok) return { ok: true, resolved: "shortcuts CLI reachable" };
      return { ok: false, reason: avail.reason ?? SHORTCUTS_UNAVAILABLE_REASON };
    } catch (err) {
      // Belt-and-braces: even a surprising provider failure never breaks the probe.
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Shortcuts unavailable: ${why}` };
    }
  }

  /** HEALTH probe: ok iff the `shortcuts` CLI is present + responding. */
  override async health(): Promise<SourceHealth> {
    const req = await this.checkRequirements();
    return req.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(req.reason ? { detail: req.reason } : {}) };
  }

  /** The full UNGATED entry set (list + run + the how-to skill). */
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
