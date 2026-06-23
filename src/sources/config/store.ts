/**
 * Managed sources — PERSISTENCE store for `~/.plexus/sources.json` (Task 0).
 *
 * Owns the atomic read/write of the versioned `SourcesConfigFile`, reusing the
 * `paths.ts` helpers (so it honors the `PLEXUS_HOME` sandbox override every test
 * relies on). Tolerates a missing/corrupt file (returns an empty config). Validates
 * that no source carries an unsafe `secretRef` (name only, no `../`, no value).
 *
 * Crash-consistency: `atomicWrite` is temp-write + rename, so a reader never sees a
 * half-written file. The live registry is authoritative WHILE running; this file is
 * authoritative ACROSS restarts (DESIGN §4.4).
 */

import { homePath, readFileBestEffort, atomicWrite } from "../../core/paths.ts";
import { isSafeSecretName } from "../extension.ts";
import type { ConfiguredSource, SourcesConfigFile } from "./types.ts";

/** The on-disk filename under `~/.plexus/`. */
export const SOURCES_FILE = "sources.json" as const;

/** Absolute path to `sources.json` under the (sandbox-aware) plexus home. */
export function sourcesConfigPath(): string {
  return homePath(SOURCES_FILE);
}

/** An empty (no-sources) config in the current schema version. */
export function emptyConfig(): SourcesConfigFile {
  return { version: 1, sources: [] };
}

/**
 * Validate a `ConfiguredSource`'s persistence-safety: it must have an id + kind, a
 * boolean `enabled`, and — crucially — `secretRef` (when present) must be a SAFE
 * secret NAME (no path traversal, no value smuggling). Returns the reasons it is
 * unsafe (empty ⇒ safe). The same `isSafeSecretName` the manifest layer uses.
 */
export function validateConfiguredSource(cfg: ConfiguredSource): string[] {
  const reasons: string[] = [];
  if (!cfg || typeof cfg !== "object") {
    return ["source entry is not an object"];
  }
  if (typeof cfg.id !== "string" || cfg.id.length === 0) reasons.push("missing id");
  if (typeof cfg.kind !== "string" || cfg.kind.length === 0) reasons.push("missing kind");
  if (typeof cfg.enabled !== "boolean") reasons.push("enabled must be a boolean");
  if (cfg.secretRef !== undefined && !isSafeSecretName(cfg.secretRef)) {
    reasons.push(`unsafe secretRef "${String(cfg.secretRef)}" (must be a name, no path traversal, no value)`);
  }
  return reasons;
}

/**
 * Read `sources.json`. Missing/empty/corrupt ⇒ an empty config (never throws). Any
 * entry that fails `validateConfiguredSource` (e.g. an unsafe secretRef someone
 * hand-edited in) is DROPPED defensively rather than loaded — a tampered value can
 * never become live state.
 */
export function readSourcesConfig(): SourcesConfigFile {
  const raw = readFileBestEffort(sourcesConfigPath());
  if (!raw) return emptyConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyConfig();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as SourcesConfigFile).version !== 1 ||
    !Array.isArray((parsed as SourcesConfigFile).sources)
  ) {
    return emptyConfig();
  }
  const sources = (parsed as SourcesConfigFile).sources.filter(
    (s) => validateConfiguredSource(s).length === 0,
  );
  return { version: 1, sources };
}

/**
 * Atomically write `sources.json`. Rejects (throws) if any entry is unsafe so a
 * caller can roll back its live register (DESIGN §4.1 step 7) — we NEVER persist a
 * source that carries a secret value or an unsafe ref. The version is forced to 1.
 */
export function writeSourcesConfig(config: SourcesConfigFile): void {
  for (const s of config.sources) {
    const reasons = validateConfiguredSource(s);
    if (reasons.length) {
      throw new Error(`refusing to persist unsafe source "${s?.id}": ${reasons.join("; ")}`);
    }
  }
  const out: SourcesConfigFile = { version: 1, sources: config.sources };
  atomicWrite(sourcesConfigPath(), JSON.stringify(out, null, 2));
}
