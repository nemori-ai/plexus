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
import { existsSync } from "node:fs";

export interface BrowserControlSourceOptions {
  /** Force the configuration (tests); when absent it is read from the environment. */
  config?: BrowserControlConfig;
}

export class BrowserControlSource extends BaseCapabilitySource {
  readonly id = BROWSER_CONTROL_SOURCE_ID;
  readonly label = "Browser control (Chrome)";
  readonly transport = "ipc" as const;

  private readonly cfg: BrowserControlConfig;

  constructor(options: BrowserControlSourceOptions = {}) {
    super();
    this.cfg = options.config ?? loadBrowserControlConfig();
  }

  /**
   * Health answers the two questions that actually stop a call, in the order an owner would fix
   * them: is a browser reachable at all, and has anything been authorized?
   *
   * An empty allowlist is reported as UNAVAILABLE rather than ok — the source would refuse every
   * call, and "ok" for a capability that cannot do anything is a lie the owner would have to
   * discover by watching an agent fail.
   */
  override async health(): Promise<SourceHealth> {
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
    if (this.cfg.allowlist.length === 0) {
      return {
        status: "unavailable",
        detail:
          "no authorized origins yet, so every call is refused. Set the sites browser control " +
          "may reach (PLEXUS_BROWSER_CONTROL_ORIGINS).",
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
