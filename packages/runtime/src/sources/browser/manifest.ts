/**
 * browser FIRST-PARTY SourceModule (READ-ONLY).
 *
 * The CONNECTOR is the user's macOS browsers (Safari + Google Chrome); the SOURCE exposes
 * them as three READ-ONLY capabilities + a usage skill:
 *   - `browser.tabs.list`        — open tabs via fixed AppleScript/JXA (a browser that is
 *                                  not running / not installed ⇒ empty list + note).
 *   - `browser.bookmarks.search` — bookmark substring search, bounded (Safari plist via
 *                                  `plutil`, Chrome JSON).
 *   - `browser.history.search`   — history substring + date-range search, bounded, newest
 *                                  first (both sqlite, ALWAYS copy-before-open; Chrome's
 *                                  WebKit-µs and Safari's Core-Data-s epochs → ISO).
 * ALL grants are `["read"]`; the provider seam has no mutating method — read-only by
 * construction.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link BrowserSource} (lifecycle): `checkRequirements()` + `health()` derive from the
 *    injected provider's `available()`. Health is "ok" when EITHER browser's data is
 *    reachable (partial availability is per-call data, not a health failure) and
 *    "unavailable" with a precise reason — naming the Full Disk Access toggle in System
 *    Settings › Privacy & Security for Safari — only when NEITHER is. NEVER throws, never
 *    blocks registration (the vaultPathHealth precedent): `scan()` always returns the full
 *    UNGATED entry set.
 *  - {@link BrowserBridge} (per-session): in-process handlers drive the injected
 *    BrowserProvider directly, then normalize + audit.
 *
 * macOS-only by nature (osascript + ~/Library paths) — deliberately NOT in
 * `LINUX_PORTABLE_MODULE_IDS`, so a Linux gateway reserves the id but never advertises it.
 * The provider is INJECTABLE: real by default, the FAKE when `PLEXUS_FAKE_BROWSER=1`
 * (mirrors PLEXUS_FAKE_APPLE) or via a constructor arg — tests + hermetic e2e never touch
 * osascript, ~/Library, or a real sqlite file.
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
import { BrowserBridge } from "./bridge.ts";
import { BROWSER_SOURCE_ID, browserEntries } from "./entries.ts";
import { selectBrowserProvider, type BrowserProvider } from "./provider.ts";

/** Construction options. `provider` is INJECTABLE so unit tests force real/fake directly. */
export interface BrowserSourceOptions {
  /** Force the provider (tests); when absent, select real/fake by env (`PLEXUS_FAKE_BROWSER`). */
  provider?: BrowserProvider;
}

/**
 * Lifecycle-layer source for the user's browsers. `health()` reflects the provider's
 * `available()`; `scan()` always exposes the read-only entry set (reachability is a
 * health signal, NOT a registration gate).
 */
export class BrowserSource extends BaseCapabilitySource {
  readonly id = BROWSER_SOURCE_ID;
  readonly label = "Browser (Safari + Chrome, read-only)";
  // The capabilities are served by in-process read handlers — an ipc (local) transport.
  readonly transport = "ipc" as const;

  private readonly provider: BrowserProvider;

  constructor(options: BrowserSourceOptions = {}) {
    super();
    this.provider = options.provider ?? selectBrowserProvider();
  }

  /**
   * Requirements DERIVE from the provider's availability probe (EITHER browser's data
   * reachable ⇒ ok). NOT a registration gate — `scan()` still exposes the entries; an
   * unreachable state surfaces via HEALTH with the precise (FDA-naming) reason.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const a = await this.provider.available();
    return a.ok
      ? { ok: true, ...(a.reason ? { resolved: a.reason } : {}) }
      : { ok: false, ...(a.reason ? { reason: a.reason } : {}) };
  }

  /**
   * HEALTH probe — "ok" when EITHER browser's data is reachable (per-browser partial
   * availability is reported in per-call results, not here); "unavailable" with the
   * precise combined reason only when NEITHER is. NEVER throws — the provider's
   * `available()` degrades every failure to `{ ok:false, reason }`. Cheap; polled in the
   * background by the health service.
   */
  override async health(): Promise<SourceHealth> {
    const a = await this.provider.available();
    return a.ok
      ? { status: "ok" }
      : { status: "unavailable", ...(a.reason ? { detail: a.reason } : {}) };
  }

  /** The full UNGATED entry set (tabs + bookmarks + history + the how-to skill). */
  async scan(): Promise<CapabilityEntry[]> {
    return browserEntries();
  }
}

/**
 * The browser (read-only) SourceModule. Registered in `src/sources/index.ts` MODULES —
 * that registration alone reserves the id (first-party provenance) and wires discovery /
 * availability / scan / invoke routing (no core branching).
 */
export const browserSourceModule: SourceModule = {
  id: BROWSER_SOURCE_ID,
  label: "Browser (Safari + Chrome, read-only)",
  transport: "ipc",
  createSource(_deps: PlatformServices): CapabilitySource {
    return new BrowserSource();
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge intercepts the browser capability ids and drives the injected provider
    // (fake when PLEXUS_FAKE_BROWSER=1, else real); the skill takes the base path.
    return new BrowserBridge(deps, sessionId, browserEntries());
  },
};
