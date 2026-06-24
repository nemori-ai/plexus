/**
 * cc-master CC-plugin auto-install mechanics — the REAL, idempotent, audited
 * settings.json merge (Acceptance Scenario A / Flow A).
 *
 * The robust programmatic path (verified against the live `~/.claude/` on this
 * machine, 2026-06-23) is to edit `~/.claude/settings.json` ONLY and let Claude
 * Code lazy-fetch the marketplace + plugin on its next session:
 *
 *   settings.enabledPlugins["cc-master@cc-master"] = true
 *   settings.extraKnownMarketplaces["cc-master"] = { source: { source:"github", repo:"nemori-ai/cc-master" } }
 *
 * This is a read-modify-write JSON merge (the jq-merge path) done atomically
 * (write to `.tmp` then rename) so an existing settings.json with many other
 * plugins/marketplaces is never corrupted — we only ADD our two keys.
 *
 * CRITICAL FOR TESTS: the claude-dir is INJECTED (never hard-coded to the real
 * HOME). `resolveClaudeDir()` resolves it from, in order:
 *   1. an explicit `claudeDir` option (tests pass a temp dir),
 *   2. the `PLEXUS_CC_CLAUDE_DIR` env var (operational override),
 *   3. `~/.claude` (production default).
 * Tests MUST pass a temp dir so the real `~/.claude/settings.json` is never
 * touched.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The canonical `<plugin>@<marketplace>` key cc-master is registered under. */
export const CC_MASTER_PLUGIN_KEY = "cc-master@cc-master" as const;
/** The marketplace name (key in `extraKnownMarketplaces`). */
export const CC_MASTER_MARKETPLACE = "cc-master" as const;
/** The GitHub source cc-master is fetched from. */
export const CC_MASTER_REPO = "nemori-ai/cc-master" as const;

/** The marketplace value cc-master is registered with (matches the live schema). */
export const CC_MASTER_MARKETPLACE_SOURCE = {
  source: { source: "github", repo: CC_MASTER_REPO },
} as const;

/** Minimal shape of the parts of `~/.claude/settings.json` we read/merge. */
interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Minimal shape of `~/.claude/plugins/installed_plugins.json` (schema version 2). */
interface InstalledPlugins {
  version?: number;
  plugins?: Record<string, unknown[]>;
  [k: string]: unknown;
}

/**
 * Resolve the `.claude` directory to operate on. Tests inject a temp dir; the
 * env override supports non-default operational installs; production defaults to
 * `~/.claude`.
 */
export function resolveClaudeDir(claudeDir?: string): string {
  if (claudeDir) return claudeDir;
  const env = process.env.PLEXUS_CC_CLAUDE_DIR;
  if (env) return env;
  return join(homedir(), ".claude");
}

const settingsPath = (claudeDir: string) => join(claudeDir, "settings.json");
const installedPath = (claudeDir: string) => join(claudeDir, "plugins", "installed_plugins.json");

/** Read+parse a JSON file, returning `fallback` when absent or malformed. */
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** The live install/enable state of the cc-master plugin under `claudeDir`. */
export interface CcMasterState {
  /** Present (installed) in installed_plugins.json `plugins[key]`. */
  installed: boolean;
  /** Enabled (`enabledPlugins[key] === true`) in settings.json. */
  enabled: boolean;
  /** The marketplace is registered in `extraKnownMarketplaces`. */
  marketplaceKnown: boolean;
  /** installed_plugins.json schema version (for the version-check guard). */
  installedSchemaVersion?: number;
}

/**
 * Inspect the live cc-master install/enable state under `claudeDir`. Pure read —
 * never mutates. Used by `checkRequirements()` and by `install()` for the
 * idempotency short-circuit.
 */
export function readCcMasterState(claudeDir?: string): CcMasterState {
  const dir = resolveClaudeDir(claudeDir);
  const settings = readJson<ClaudeSettings>(settingsPath(dir), {});
  const installedDoc = readJson<InstalledPlugins>(installedPath(dir), {});

  const enabled = settings.enabledPlugins?.[CC_MASTER_PLUGIN_KEY] === true;
  const marketplaceKnown =
    !!settings.extraKnownMarketplaces &&
    Object.prototype.hasOwnProperty.call(settings.extraKnownMarketplaces, CC_MASTER_MARKETPLACE);
  const installed =
    !!installedDoc.plugins &&
    Object.prototype.hasOwnProperty.call(installedDoc.plugins, CC_MASTER_PLUGIN_KEY);

  return {
    installed,
    enabled,
    marketplaceKnown,
    installedSchemaVersion: installedDoc.version,
  };
}

/** Result of the settings merge — what (if anything) changed. */
export interface InstallMergeResult {
  /** True when the settings.json now has cc-master enabled + marketplace known. */
  ok: boolean;
  /** True when this call was a NO-OP (already enabled + marketplace known). */
  alreadyInstalled: boolean;
  /** What changed this call (for audit detail). Empty on a no-op. */
  changed: Array<"enabledPlugins" | "extraKnownMarketplaces">;
  /** The settings.json path that was (or would be) written. */
  settingsPath: string;
}

/**
 * IDEMPOTENT settings.json merge: enable cc-master + register its marketplace.
 *
 * - Already enabled AND marketplace known ⇒ NO-OP success (`alreadyInstalled`).
 * - Otherwise, read-modify-write ADDING only our two keys, preserving every other
 *   key, written atomically (`.tmp` then rename).
 *
 * Never deletes or rewrites unrelated keys (reversible-safe: a later disable just
 * flips our key to false; the marketplace entry is additive).
 */
export function mergeCcMasterIntoSettings(claudeDir?: string): InstallMergeResult {
  const dir = resolveClaudeDir(claudeDir);
  const path = settingsPath(dir);

  const state = readCcMasterState(dir);
  if (state.enabled && state.marketplaceKnown) {
    return { ok: true, alreadyInstalled: true, changed: [], settingsPath: path };
  }

  const settings = readJson<ClaudeSettings>(path, {});
  const changed: Array<"enabledPlugins" | "extraKnownMarketplaces"> = [];

  if (settings.enabledPlugins?.[CC_MASTER_PLUGIN_KEY] !== true) {
    settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [CC_MASTER_PLUGIN_KEY]: true };
    changed.push("enabledPlugins");
  }

  const marketplaces = (settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(marketplaces, CC_MASTER_MARKETPLACE)) {
    settings.extraKnownMarketplaces = {
      ...marketplaces,
      [CC_MASTER_MARKETPLACE]: CC_MASTER_MARKETPLACE_SOURCE,
    };
    changed.push("extraKnownMarketplaces");
  }

  // Ensure the target dir exists (a temp fixture may not have it yet).
  mkdirSync(dir, { recursive: true });

  // Atomic write: serialize to a sibling .tmp then rename over the target so a
  // crash mid-write never leaves a corrupted settings.json.
  const tmp = `${path}.plexus.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);

  return { ok: true, alreadyInstalled: false, changed, settingsPath: path };
}
