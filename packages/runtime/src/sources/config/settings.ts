/**
 * Per-source SETTINGS — the owner's machine-level configuration for first-party
 * sources, persisted to `~/.plexus/source-settings.json` and admin-manageable
 * (GET/PUT `/admin/api/source-settings`, connection-key gated + audited).
 *
 * First (and so far only) setting: **`realLaunch`** — whether an approved
 * `execute` capability on this source actually spawns the underlying tool
 * (codex / claude / cc-master), or performs the honest dry-run "record mode"
 * (returns the full sandboxed argv it WOULD run, `launched:false`). This is a
 * RESOURCE-side static asset decision ("may this gateway spend my model quota /
 * run agents on this machine at all"), deliberately distinct from the per-call
 * grant approval ("may THIS agent do it NOW") — the two compose: a call runs for
 * real only when the owner approved the call AND the machine allows real launches.
 *
 * Precedence at read time: persisted setting (when present) WINS over the legacy
 * env flags (`PLEXUS_CODEX_HEADLESS_LAUNCH` / `PLEXUS_CC_HEADLESS_LAUNCH`), which
 * stay as boot-time fallbacks for recipes and tests. Absent both ⇒ OFF (fail-safe:
 * nothing spends money or spawns agents by default).
 *
 * Read-per-call on purpose: invokes are rare and the file is tiny, so the toggle
 * takes effect LIVE — no gateway restart, matching how the console mutates it.
 */

import { homePath, readFileBestEffort, atomicWrite } from "../../core/paths.ts";

/** The on-disk filename under `~/.plexus/`. */
export const SOURCE_SETTINGS_FILE = "source-settings.json" as const;

/** The settable per-source knobs. Additive by design — new knobs get new keys. */
export interface SourceSettings {
  /** Approved execute calls REALLY spawn the tool (vs the honest record-mode dry-run). */
  realLaunch?: boolean;
}

interface SourceSettingsFile {
  version: 1;
  settings: Record<string, SourceSettings>;
}

/** The exec-class first-party sources that honor `realLaunch` (the console's list). */
export const REAL_LAUNCH_SOURCES: readonly { sourceId: string; envFallback: string }[] = [
  { sourceId: "codex", envFallback: "PLEXUS_CODEX_HEADLESS_LAUNCH" },
  { sourceId: "claudecode", envFallback: "PLEXUS_CC_HEADLESS_LAUNCH" },
  { sourceId: "cc-master", envFallback: "PLEXUS_CC_HEADLESS_LAUNCH" },
];

function readFile(): SourceSettingsFile {
  const raw = readFileBestEffort(homePath(SOURCE_SETTINGS_FILE));
  if (!raw) return { version: 1, settings: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as SourceSettingsFile).settings &&
      typeof (parsed as SourceSettingsFile).settings === "object"
    ) {
      return { version: 1, settings: (parsed as SourceSettingsFile).settings };
    }
  } catch {
    /* corrupt ⇒ fail-safe empty (everything defaults OFF) */
  }
  return { version: 1, settings: {} };
}

/** Read one source's persisted settings (empty object when unset). */
export function sourceSettings(sourceId: string): SourceSettings {
  const s = readFile().settings[sourceId];
  return s && typeof s === "object" ? s : {};
}

/** All persisted settings (for the admin GET). */
export function allSourceSettings(): Record<string, SourceSettings> {
  return readFile().settings;
}

/**
 * Persist a partial update for one source (merge; `undefined` values delete keys).
 * Returns the merged record now on disk.
 */
export function writeSourceSettings(sourceId: string, patch: SourceSettings): SourceSettings {
  const file = readFile();
  const merged: SourceSettings = { ...(file.settings[sourceId] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
    else (merged as Record<string, unknown>)[k] = v;
  }
  if (Object.keys(merged).length === 0) delete file.settings[sourceId];
  else file.settings[sourceId] = merged;
  atomicWrite(homePath(SOURCE_SETTINGS_FILE), JSON.stringify(file, null, 2) + "\n");
  return merged;
}

/**
 * THE gate the exec launchers consult per call: the persisted `realLaunch` wins
 * when set; else the legacy env flag; else OFF.
 */
export function realLaunchEnabled(sourceId: string, envFallback: string): boolean {
  const persisted = sourceSettings(sourceId).realLaunch;
  if (typeof persisted === "boolean") return persisted;
  return process.env[envFallback] === "1";
}
