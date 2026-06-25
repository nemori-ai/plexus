/**
 * cc-master FIRST-PARTY SourceModule (managed-headless launch, v1).
 *
 * The CONNECTOR is Claude Code (a first-party app Plexus launches + augments). The
 * SOURCE is a Plexus-managed Claude Code launch profile whose `loadCcMaster` config
 * GATES the capability list. Plexus NEVER mutates the user's `~/.claude`: it spawns
 * `claude --plugin-dir <EMBEDDED cc-master> -p ...` headless (see `launch.ts`), so
 * the cc-master plugin loads into a Plexus-launched session.
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `CcMasterSource` (lifecycle): `checkRequirements()` probes Claude Code presence
 *    (resolveBinary "claude" — STILL needed, we spawn it) AND validates the embedded
 *    plugin structurally; `scan()` reads the persisted launch-profile config and
 *    exposes the GATED entry set (base launch always; orchestration only when
 *    loadCcMaster is on). There is NO `install()` — the settings.json merge is gone.
 *  - `CcMasterBridge` (per-session): the in-process handlers — `session.launch` /
 *    `agent.dispatch` REALLY launch a managed headless cc session; the board ops are
 *    local; the workflow + skills take the standard base path.
 *
 * Registered in `src/sources/index.ts` MODULES; discovery / availability / scan /
 * invoke routing flow automatically (no core branching). It stays first-party via the
 * reserved source id (RESERVED_SOURCE_IDS) — provenance is "first-party" regardless of
 * the config gate.
 */

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilitySource,
  PlatformServices,
  SourceModule,
  SourceRequirementResult,
} from "@plexus/protocol";
import { BaseCapabilitySource } from "../base.ts";
import { CcMasterBridge } from "./bridge.ts";
import { CC_MASTER_SOURCE_ID, ccMasterEntries } from "./entries.ts";
import { readCcMasterConfig } from "./config.ts";
import { EMBEDDED_PLUGIN_DIR, validateEmbeddedPlugin } from "./embedded-plugin.ts";

/** Construction options. `loadCcMaster` is INJECTABLE so tests can force the gate. */
export interface CcMasterSourceOptions {
  /** Force the gate (tests); when absent, read the persisted launch-profile config. */
  loadCcMaster?: boolean;
}

/**
 * Lifecycle-layer source for the Claude Code launch profile. `checkRequirements()`
 * reports Claude Code presence + embedded-plugin validity; `scan()` surfaces the
 * GATED entry set (base launch always; orchestration only when loadCcMaster on).
 */
export class CcMasterSource extends BaseCapabilitySource {
  readonly id = CC_MASTER_SOURCE_ID;
  readonly label = "Claude Code (Plexus-managed launch)";
  // The flagship entry is a workflow; the source-level transport advertises it.
  readonly transport = "workflow" as const;

  constructor(
    private readonly platform: PlatformServices,
    private readonly options: CcMasterSourceOptions = {},
  ) {
    super();
  }

  /** The effective gate: the injected option (tests) or the persisted config. */
  private get loadCcMaster(): boolean {
    if (typeof this.options.loadCcMaster === "boolean") return this.options.loadCcMaster;
    return readCcMasterConfig().loadCcMaster;
  }

  /**
   * Probe: Claude Code present (resolveBinary "claude" — we SPAWN it for the managed
   * headless launch) AND the embedded cc-master plugin is structurally valid (so a
   * `--plugin-dir` launch can succeed). `ok` is gated on `claude` being present; the
   * embedded-plugin + launch-profile state is surfaced in `resolved`.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const claude = await this.platform.resolveBinary("claude");
    if (!claude) {
      return {
        ok: false,
        reason:
          "Claude Code (`claude`) not found on PATH — Plexus launches it headless to run cc-master.",
      };
    }
    const validation = validateEmbeddedPlugin(EMBEDDED_PLUGIN_DIR);
    const pluginNote = validation.ok
      ? `embedded cc-master ${validation.version ?? ""} valid`
      : `embedded cc-master INVALID (${validation.reason})`;
    const gateNote = this.loadCcMaster ? "loadCcMaster on" : "loadCcMaster off";
    return {
      ok: true,
      resolved: `claude=${claude}; ${pluginNote}; ${gateNote}`,
    };
  }

  /**
   * Enumerate the GATED entry set. The orchestration runs in a Plexus-LAUNCHED Claude
   * Code session, so when `checkRequirements()` is not ok (no `claude` on PATH) we
   * surface NO entries. When requirements are met, the entry set is gated on the
   * launch profile's `loadCcMaster`: on ⇒ base launch + orchestration workflow +
   * members + skills; off ⇒ ONLY the base launch capability.
   */
  async scan(): Promise<CapabilityEntry[]> {
    const req = await this.checkRequirements();
    if (!req.ok) return [];
    return ccMasterEntries(this.loadCcMaster);
  }
}

/**
 * The cc-master / Claude Code launch-profile SourceModule. Registered in
 * `src/sources/index.ts` MODULES. The bridge serves the orchestration entries (its
 * gating is read live in `scan()`, so the bridge advertises the full set and only
 * exposed entries are reachable through the registry).
 */
export const ccMasterSourceModule: SourceModule = {
  id: CC_MASTER_SOURCE_ID,
  label: "Claude Code (Plexus-managed launch)",
  transport: "workflow",
  createSource(deps: PlatformServices): CapabilitySource {
    return new CcMasterSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The bridge serves the launch + board members via REAL in-process handlers (see
    // bridge.ts); the orchestration workflow + skills take the standard base path.
    // It carries the full entry set; the registry only routes the entries scan()
    // currently exposes, so the live gate is honored.
    return new CcMasterBridge(deps, sessionId, ccMasterEntries(true));
  },
};
