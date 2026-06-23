/**
 * cc-master FIRST-PARTY SourceModule (Acceptance Scenario A / Flow A).
 *
 * Two layers, per the frozen adapter contract (§6):
 *  - `CcMasterSource` (lifecycle): `checkRequirements()` probes Claude Code
 *    presence (resolveBinary "claude") AND reports the live cc-master
 *    install/enable state; `scan()` exposes the orchestration workflow + members +
 *    skills; `install()` is the FIRST-CLASS, idempotent, audited auto-install
 *    action (the settings.json merge in install.ts), routed through the gateway's
 *    user-authorization seam by the management client (t11).
 *  - `BaseCapabilityBridge` (per-session): the uniform invoke path; the workflow
 *    transport fans out the orchestration members through the same pipeline.
 *
 * Register `ccMasterSourceModule` in `src/sources/index.ts` MODULES and discovery
 * / availability / scan / invoke routing flow automatically (no core branching).
 */

import type {
  BridgeDeps,
  CapabilityBridge,
  CapabilityEntry,
  CapabilitySource,
  PlatformServices,
  SourceInstallDeps,
  SourceInstallResult,
  SourceModule,
  SourceRequirementResult,
} from "../../protocol/index.ts";
import { BaseCapabilitySource } from "../base.ts";
import { CcMasterBridge } from "./bridge.ts";
import { CC_MASTER_SOURCE_ID, ccMasterEntries } from "./entries.ts";
import {
  CC_MASTER_PLUGIN_KEY,
  mergeCcMasterIntoSettings,
  readCcMasterState,
  resolveClaudeDir,
} from "./install.ts";

/** Construction options — `claudeDir` is INJECTED so tests never touch real ~/.claude. */
export interface CcMasterSourceOptions {
  /** The `.claude` dir to read state from / install into. Defaults to ~/.claude. */
  claudeDir?: string;
}

/**
 * Lifecycle-layer source for cc-master. `checkRequirements()` reports Claude Code
 * presence + the live cc-master install state; `install()` is the audited,
 * idempotent settings.json merge; `scan()` surfaces the orchestration workflow +
 * members + skills.
 */
export class CcMasterSource extends BaseCapabilitySource {
  readonly id = CC_MASTER_SOURCE_ID;
  readonly label = "cc-master (Claude Code orchestration)";
  // The flagship entry is a workflow; its members are cli. The source-level
  // transport advertises the headline orchestration entry's transport.
  readonly transport = "workflow" as const;

  constructor(
    private readonly platform: PlatformServices,
    private readonly options: CcMasterSourceOptions = {},
  ) {
    super();
  }

  /** The resolved `.claude` dir this source operates on (test-injectable). */
  private get claudeDir(): string {
    return resolveClaudeDir(this.options.claudeDir);
  }

  /**
   * Probe: Claude Code present (resolveBinary "claude") AND report whether
   * cc-master is already installed/enabled (live settings.json + installed_plugins
   * registry). `ok` is gated on Claude Code being present (the orchestration runs
   * inside CC); the cc-master install state is surfaced in `resolved` for the
   * management client's availability badge and to drive the install action.
   */
  override async checkRequirements(): Promise<SourceRequirementResult> {
    const claude = await this.platform.resolveBinary("claude");
    if (!claude) {
      return {
        ok: false,
        reason:
          "Claude Code (`claude`) not found on PATH — cc-master orchestration runs inside Claude Code.",
      };
    }
    const state = readCcMasterState(this.claudeDir);
    const installNote = state.enabled
      ? "cc-master enabled"
      : state.installed
        ? "cc-master installed but not enabled — run install() to enable"
        : "cc-master not installed — run install() to register + enable";
    return {
      ok: true,
      resolved: `claude=${claude}; ${installNote} (marketplace ${state.marketplaceKnown ? "known" : "unregistered"})`,
    };
  }

  /**
   * Enumerate cc-master's self-describe entries: the orchestration WORKFLOW + its
   * MEMBERS (so `members[]` resolve to present registry entries — transitive
   * grants have real targets) + the cc-master SKILL entries.
   *
   * GATED ON REQUIREMENTS (t13): the orchestration runs inside Claude Code, so when
   * `checkRequirements()` is not ok (e.g. `claude` is not on PATH) we surface NO
   * entries — there is no point describing an orchestration capability the host can
   * never satisfy. When requirements are met, the full entry set is returned
   * regardless of cc-master's install state (install() makes the underlying skills
   * available inside Claude Code; the board members run as local ops either way).
   */
  async scan(): Promise<CapabilityEntry[]> {
    const req = await this.checkRequirements();
    if (!req.ok) return [];
    return ccMasterEntries();
  }

  /**
   * FIRST-CLASS, IDEMPOTENT, AUDITED auto-install (Flow A). Programmatically
   * installs+enables the cc-master CC plugin via the settings.json merge
   * (enabledPlugins["cc-master@cc-master"]=true + extraKnownMarketplaces["cc-master"]).
   *
   *  - IDEMPOTENT: already enabled + marketplace known ⇒ NO-OP success.
   *  - REVERSIBLE-SAFE: only ADDS our two keys; never rewrites unrelated settings.
   *  - AUDITED: emits a `source.install` audit event (no secrets / raw values).
   *
   * Routed through the gateway as a granted action so the management client (t11)
   * can trigger it. Writes to `this.claudeDir` — INJECTED, so tests never touch
   * the real ~/.claude.
   */
  async install(deps: SourceInstallDeps): Promise<SourceInstallResult> {
    const dir = this.claudeDir;
    let merge: ReturnType<typeof mergeCcMasterIntoSettings>;
    try {
      merge = mergeCcMasterIntoSettings(dir);
    } catch (err) {
      await deps.audit({
        type: "source.install",
        outcome: "error",
        detail: {
          source: CC_MASTER_SOURCE_ID,
          plugin: CC_MASTER_PLUGIN_KEY,
          reason: "settings_merge_failed",
        },
      });
      return {
        ok: false,
        reason: `cc-master install failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Audit-safe detail only: the plugin key, what changed, idempotency — never the
    // file contents or any secret.
    await deps.audit({
      type: "source.install",
      outcome: "ok",
      detail: {
        source: CC_MASTER_SOURCE_ID,
        plugin: CC_MASTER_PLUGIN_KEY,
        alreadyInstalled: merge.alreadyInstalled,
        changed: merge.changed,
      },
    });

    return {
      ok: merge.ok,
      installed: CC_MASTER_PLUGIN_KEY,
      reason: merge.alreadyInstalled
        ? "cc-master already enabled (no-op)"
        : `enabled cc-master + registered marketplace (changed: ${merge.changed.join(", ")})`,
    };
  }
}

/**
 * The cc-master first-party SourceModule. Registered in `src/sources/index.ts`
 * MODULES. `createSource` honors `PLEXUS_CC_CLAUDE_DIR` (or ~/.claude) by default;
 * tests construct `CcMasterSource` directly with an injected temp `claudeDir`.
 */
export const ccMasterSourceModule: SourceModule = {
  id: CC_MASTER_SOURCE_ID,
  label: "cc-master (Claude Code orchestration)",
  transport: "workflow",
  createSource(deps: PlatformServices): CapabilitySource {
    return new CcMasterSource(deps);
  },
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge {
    // The cc-master bridge serves the three coordination MEMBERS via REAL in-process
    // board operations (see bridge.ts); the orchestration workflow + skills still take
    // the standard base path.
    return new CcMasterBridge(deps, sessionId, ccMasterEntries());
  },
};
