/**
 * browser-control FIRST-PARTY SourceModule.
 *
 * Distinct from the read-only `browser` source (tabs / bookmarks / history), which is read-only
 * BY CONSTRUCTION — folding page control into it would quietly falsify that guarantee.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - {@link BrowserControlSource} (lifecycle) — health reflects whether a browser could actually
 *    be driven AND whether the owner has authorized any origin. `scan()` is UNGATED: the entries
 *    are always advertised so an agent is told WHY it cannot drive a browser, instead of never
 *    learning the capability exists.
 *  - {@link BrowserControlBridge} (per-session) — runs the origin gate and the CDP calls.
 *
 * Chromium-only by nature (CDP), and the launch path resolves Chrome at a macOS path today.
 * Deliberately NOT in `LINUX_PORTABLE_MODULE_IDS`: a Linux gateway reserves the id but does not
 * advertise a capability it cannot honour.
 */

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  SourceHealth,
  SourceModule,
  SourceRequirementResult,
} from "@plexus/protocol";
import { BaseCapabilitySource } from "../base.ts";
import { BrowserControlBridge } from "./bridge.ts";
import { BROWSER_CONTROL_SOURCE_ID, browserControlEntries } from "./entries.ts";
import {
  loadBrowserControlConfig,
  resolveChromeBinary,
  type BrowserControlConfig,
} from "./endpoint.ts";
import { endpointAlive } from "./cdp.ts";
import { getExtensionRelay } from "./endpoint.ts";
import { existsSync } from "node:fs";

export interface BrowserControlSourceOptions {
  /** Force the configuration (tests); when absent it is read from the environment. */
  config?: BrowserControlConfig;
}

export class BrowserControlSource extends BaseCapabilitySource {
  readonly id = BROWSER_CONTROL_SOURCE_ID;
  readonly label = "Browser control (Chrome)";
  readonly transport = "ipc" as const;

  private readonly fixedCfg?: BrowserControlConfig;

  constructor(options: BrowserControlSourceOptions = {}) {
    super();
    this.fixedCfg = options.config;
  }

  /** Re-read per call, so the console's changes show in health without a restart. */
  private get cfg(): BrowserControlConfig {
    return this.fixedCfg ?? loadBrowserControlConfig();
  }

  /**
   * Health answers the two questions that actually stop a call, in the order an owner would fix
   * them: is a browser reachable at all, and — for the owner's OWN browser — has anything been
   * authorized?
   *
   * An attach-mode source with no domains named is reported as UNAVAILABLE rather than ok: it
   * would refuse every call, and "ok" for a capability that cannot do anything is a lie the
   * owner would have to discover by watching an agent fail.
   */
  override async health(): Promise<SourceHealth> {
    if (this.cfg.mode === "extension") {
      const relay = getExtensionRelay();
      if (!relay?.connected) {
        return {
          status: "unavailable",
          detail:
            "extension mode: the Plexus browser extension has not connected. Load it from " +
            "`extension/plexus-browser`, then pair it with this gateway's socket URL and token.",
        };
      }
      // An extension drives the owner's OWN browser, so an empty list means refuse everything —
      // the same rule as attach.
      if (this.cfg.allowlist.length === 0) {
        return {
          status: "unavailable",
          detail:
            "extension mode drives the owner's own browser, so it refuses every call until the " +
            "domains an agent may reach are named (PLEXUS_BROWSER_CONTROL_ORIGINS).",
        };
      }
      return { status: "ok" };
    }
    if (this.cfg.mode === "attach") {
      const alive = await endpointAlive({ host: "127.0.0.1", port: this.cfg.attachPort });
      if (!alive) {
        return {
          status: "unavailable",
          detail:
            `attach mode: no Chrome is exposing a debugging endpoint on port ${this.cfg.attachPort}. ` +
            `Enable it once at chrome://inspect/#remote-debugging (Chrome 144+).`,
        };
      }
    } else {
      const binary = resolveChromeBinary(this.cfg);
      if (!binary || !existsSync(binary)) {
        return { status: "unavailable", detail: "launch mode: Google Chrome was not found on this machine." };
      }
    }
    // An empty list is only a problem for the browser that has something to lose. A launched
    // browser runs an empty profile, so "no domains named" means the open web, not "inert".
    if (this.cfg.mode === "attach" && this.cfg.allowlist.length === 0) {
      return {
        status: "unavailable",
        detail:
          "attach mode drives the owner's own browser, so it refuses every call until the " +
          "domains an agent may reach are named (PLEXUS_BROWSER_CONTROL_ORIGINS).",
      };
    }
    return { status: "ok" };
  }

  override async checkRequirements(): Promise<SourceRequirementResult> {
    const h = await this.health();
    return h.status === "ok"
      ? { ok: true }
      : { ok: false, ...(h.detail ? { reason: h.detail } : {}) };
  }

  /** The full UNGATED entry set. */
  async scan(): Promise<CapabilityEntry[]> {
    return browserControlEntries();
  }
}

export const browserControlSourceModule: SourceModule = {
  id: BROWSER_CONTROL_SOURCE_ID,
  label: "Browser control (Chrome)",
  transport: "ipc",
  createSource: () => new BrowserControlSource(),
  createBridge: (deps: BridgeDeps, sessionId: string): CapabilityBridge =>
    new BrowserControlBridge(deps, sessionId, browserControlEntries()),
};
