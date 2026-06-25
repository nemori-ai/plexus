/**
 * cc-master launch-profile CONFIG (managed-headless launch, v1).
 *
 * In the corrected domain model the SOURCE is a Plexus-managed Claude Code launch
 * profile whose single config field is `loadCcMaster: boolean`. That config GATES
 * the capability list: on ⇒ the orchestration capabilities are exposed; off ⇒ only
 * a base "launch a managed cc session" capability is exposed.
 *
 * The config is persisted under `~/.plexus/cc-master.json` (NOT `~/.claude` — the
 * whole point of v1 is to leave the user's Claude Code config untouched). It is a
 * tiny versioned doc the admin toggle writes and the source's `scan()` reads fresh
 * each refresh, so flipping the toggle + re-scanning re-gates the capabilities with
 * no restart.
 *
 * SAFETY: reads/writes ONLY `~/.plexus/cc-master.json` (PLEXUS_HOME-overridable for
 * tests). Never touches `~/.claude`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { homePath, plexusHome } from "../../core/paths.ts";

/** The persisted cc-master launch-profile config (versioned). */
export interface CcMasterConfig {
  version: 1;
  /** Gate: expose the orchestration capabilities (true) or just base launch (false). */
  loadCcMaster: boolean;
}

/** v1 DEFAULT — cc-master loading is ON by default (the flagship experience). */
export const DEFAULT_CC_MASTER_CONFIG: CcMasterConfig = { version: 1, loadCcMaster: true };

/** The config file path under the (PLEXUS_HOME-overridable) plexus home. */
function configPath(): string {
  return join(plexusHome(), "cc-master.json");
}

/**
 * Read the persisted cc-master config, falling back to the default (loadCcMaster:true)
 * when absent or malformed. Pure read — never writes.
 */
export function readCcMasterConfig(): CcMasterConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CC_MASTER_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CcMasterConfig>;
    return {
      version: 1,
      loadCcMaster: parsed.loadCcMaster !== false,
    };
  } catch {
    return { ...DEFAULT_CC_MASTER_CONFIG };
  }
}

/**
 * Persist the `loadCcMaster` gate atomically (`.tmp` then rename). Returns the
 * config as written. Writes ONLY `~/.plexus/cc-master.json`.
 */
export function writeCcMasterConfig(loadCcMaster: boolean): CcMasterConfig {
  const cfg: CcMasterConfig = { version: 1, loadCcMaster };
  // homePath ensures ~/.plexus exists.
  const path = homePath("cc-master.json");
  const tmp = `${path}.plexus.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
  return cfg;
}
