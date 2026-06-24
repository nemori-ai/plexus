/**
 * Embedded cc-master plugin RESOLVER (managed-headless launch, v1).
 *
 * Plexus ships the cc-master Claude Code plugin EMBEDDED under
 * `packages/runtime/vendor/cc-master-plugin/` so it can launch a managed
 * `claude --plugin-dir <embedded>` session WITHOUT ever touching the user's
 * `~/.claude`. This module resolves the absolute path to that embedded dir for
 * BOTH dev (relative to this module's `import.meta.url`) and a packaged build
 * (under `process.resourcesPath`), mirroring the dev/prod split in
 * `packages/desktop/src/runtime-resolver.ts`.
 *
 * It also exposes `validateEmbeddedPlugin()` — a STRUCTURAL check (the plugin's
 * `.claude-plugin/plugin.json` parses + key dirs exist) used by the launcher and
 * by tests to assert the vendored copy is intact. The check NEVER launches the
 * plugin (its hooks bootstrap an orchestration — never auto-run in tests).
 *
 * SAFETY: this module only READS the embedded vendor dir. It never reads/writes
 * `~/.claude` and never spawns anything.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** The vendor subdir name the plugin is embedded under (dev + packaged mirror). */
export const EMBEDDED_PLUGIN_DIRNAME = "cc-master-plugin" as const;

/**
 * The pinned IDENTITY (`.claude-plugin/plugin.json` `name`) of the vendored plugin
 * (SECURITY #4 — defense-in-depth). `validateEmbeddedPlugin` rejects any dir whose
 * manifest `name` is not this, so the `PLEXUS_CC_EMBEDDED_PLUGIN_DIR` env override (a
 * trusted-dev convenience) can only ever point at a REAL cc-master plugin — a structural
 * check alone (parses + dirs exist) would otherwise accept an attacker-shaped plugin.
 */
export const EXPECTED_PLUGIN_NAME = "cc-master" as const;

/** The packaged extraResource subdir the embedded plugin ships under. */
export const EMBEDDED_PLUGIN_RESOURCE_DIR = "cc-master-plugin" as const;

/** Inputs the resolver needs — all injected so it stays testable + Electron-free. */
export interface EmbeddedResolveInput {
  /** True in a packaged app (resolve under `resourcesPath`); false in dev. */
  readonly packaged?: boolean;
  /** `process.resourcesPath` — the bundle Resources dir (packaged only). */
  readonly resourcesPath?: string;
  /** Override the dev base dir (defaults to the runtime `vendor/`). Tests inject. */
  readonly devVendorDir?: string;
}

/**
 * The dev-mode vendor directory: `packages/runtime/vendor/`, resolved relative to
 * THIS module (`.../packages/runtime/src/sources/cc-master/embedded-plugin.ts` →
 * up four levels to `packages/runtime/`, then `vendor/`). Kept as a function so a
 * test can resolve it without spawning.
 */
function devVendorDir(): string {
  // import.meta.url → .../packages/runtime/src/sources/cc-master/embedded-plugin.ts
  const here = fileURLToPath(import.meta.url);
  // up: cc-master → sources → src → runtime
  const runtimeRoot = join(here, "..", "..", "..", "..");
  return join(runtimeRoot, "vendor");
}

/**
 * Resolve the ABSOLUTE path to the embedded cc-master plugin directory.
 *
 *   ENV override → `PLEXUS_CC_EMBEDDED_PLUGIN_DIR` (the desktop supervisor sets this
 *                  to `<resourcesPath>/cc-master-plugin` in a packaged app, so the
 *                  compiled runtime sidecar — which has no dev source tree — finds it).
 *   DEV          → `<runtime>/vendor/cc-master-plugin` (relative to this module).
 *   PROD (explicit) → `<resourcesPath>/cc-master-plugin`.
 *
 * Throws in packaged mode if `resourcesPath` is missing (a packaging bug we want
 * loud, not a silent fallback to a dev path that won't exist on the user's box).
 */
export function resolveEmbeddedPluginDir(input: EmbeddedResolveInput = {}): string {
  // An explicit packaged resolution takes precedence over the env (tests pass it).
  if (input.packaged) {
    if (!input.resourcesPath) {
      throw new Error(
        "resolveEmbeddedPluginDir: packaged app has no resourcesPath — cannot locate the embedded cc-master plugin",
      );
    }
    return join(input.resourcesPath, EMBEDDED_PLUGIN_RESOURCE_DIR);
  }
  // Operational override (packaged runtime sidecar). Honored only for the default
  // (non-explicit) dev resolution so tests injecting `devVendorDir` stay deterministic.
  const envDir = process.env.PLEXUS_CC_EMBEDDED_PLUGIN_DIR;
  if (envDir && !input.devVendorDir) return envDir;
  const base = input.devVendorDir ?? devVendorDir();
  return join(base, EMBEDDED_PLUGIN_DIRNAME);
}

/** The default resolved embedded plugin dir (dev, from this module's location). */
export const EMBEDDED_PLUGIN_DIR = resolveEmbeddedPluginDir();

/** Result of a structural validation of an embedded plugin dir. */
export interface EmbeddedPluginValidation {
  ok: boolean;
  /** The plugin dir that was validated. */
  dir: string;
  /** The parsed plugin name (from `.claude-plugin/plugin.json`), when valid. */
  name?: string;
  /** The parsed plugin version, when valid. */
  version?: string;
  /** Why validation failed (absent on success). */
  reason?: string;
}

/**
 * STRUCTURAL + IDENTITY validation of an embedded plugin dir: the dir exists, its
 * `.claude-plugin/plugin.json` parses, its `name` matches the pinned
 * `EXPECTED_PLUGIN_NAME` (SECURITY #4 — so a `PLEXUS_CC_EMBEDDED_PLUGIN_DIR` override
 * can't point at an attacker-shaped plugin), and the key functional dirs (`hooks/`,
 * `skills/`, `commands/`) are present. NEVER launches the plugin — this is a
 * files-on-disk check only (the real cc-master hooks bootstrap an orchestration,
 * which we never trigger in validation/tests).
 */
export function validateEmbeddedPlugin(dir: string = EMBEDDED_PLUGIN_DIR): EmbeddedPluginValidation {
  if (!existsSync(dir) || !safeIsDir(dir)) {
    return { ok: false, dir, reason: `embedded plugin dir not found: ${dir}` };
  }
  const manifestPath = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, dir, reason: `missing .claude-plugin/plugin.json under ${dir}` };
  }
  let parsed: { name?: unknown; version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as typeof parsed;
  } catch (err) {
    return {
      ok: false,
      dir,
      reason: `plugin.json did not parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    return { ok: false, dir, reason: "plugin.json has no `name`" };
  }
  // IDENTITY gate (SECURITY #4): the manifest name must be the pinned vendored plugin.
  // This is what makes the `PLEXUS_CC_EMBEDDED_PLUGIN_DIR` env override safe — even a
  // dev-supplied dir must be a REAL cc-master plugin, not just structurally plausible.
  if (parsed.name !== EXPECTED_PLUGIN_NAME) {
    return {
      ok: false,
      dir,
      reason: `plugin identity mismatch: expected name "${EXPECTED_PLUGIN_NAME}", got "${parsed.name}"`,
    };
  }
  // Key functional dirs the launcher relies on (hooks fire the bootstrap; skills +
  // commands are the orchestration surface). All must exist for a usable launch.
  for (const sub of ["hooks", "skills", "commands"]) {
    const subPath = join(dir, sub);
    if (!existsSync(subPath) || !safeIsDir(subPath)) {
      return { ok: false, dir, reason: `missing key dir "${sub}/" under ${dir}` };
    }
  }
  return {
    ok: true,
    dir,
    name: parsed.name,
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
  };
}

/** Is `path` a directory (best-effort; false on a stat error)? */
function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
