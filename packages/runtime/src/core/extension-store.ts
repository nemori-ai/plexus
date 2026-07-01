/**
 * Installed-EXTENSION manifest store — persistence for ADMIN-installed user
 * extensions (`POST /admin/api/extensions`), so they SURVIVE a gateway restart.
 *
 * THE GAP THIS CLOSES: `CapabilityRegistry.registerExtension` only holds a
 * materialized module in an in-memory Map. First-party CONFIG sources persist via
 * `sources.json` (+ `exposure.json`); extension SOURCES did not — so every
 * admin-installed extension (and the capabilities + grants hanging off it) vanished
 * from `.well-known` on the next `bun run start`. This store is the extension-side
 * mirror of `sources.json`: the raw installed `ExtensionManifest` set is written to
 * `~/.plexus/extensions.json` and REPLAYED through `registerExtension` at boot.
 *
 * SCOPE — USER-INSTALLED EXTENSIONS ONLY. `registerExtension` is ALSO called for
 * synthetic `bundle:<id>` sources (grant-service) and tunnel caps (handlers); those
 * must NOT persist here. The write boundary is therefore the ADMIN endpoints
 * (`admin.ts` install/remove), never the raw registry method — see those hooks.
 *
 * Mirrors the `exposure.ts` / `sources/config/store.ts` persistence pattern: an
 * atomic temp-write + rename (never a half-written file), a versioned envelope, and
 * a SAFE load that tolerates a missing/corrupt file by returning an empty set (a bad
 * file must never brick boot — the registry simply stays at its first-party set).
 * Owner-only 0600, like the other credential-adjacent state under `~/.plexus`.
 */

import type { ExtensionManifest, SourceId } from "@plexus/protocol";
import { homePath, readFileBestEffort, atomicWrite } from "./paths.ts";

/** The on-disk filename under `~/.plexus/`. */
export const EXTENSIONS_FILE = "extensions.json" as const;

/** Bump if the persisted shape changes incompatibly. */
const EXTENSIONS_VERSION = 1;

/**
 * One persisted admin-installed extension: the RAW manifest (replayed verbatim
 * through `registerExtension`), the cross-source-attach gate it was installed under
 * (so a boot replay re-applies the SAME gate the human approved), and an install
 * timestamp for the operator's benefit.
 */
export interface InstalledExtension {
  manifest: ExtensionManifest;
  allowCrossSource: boolean;
  installedAt: string;
}

/** The on-disk envelope shape. */
interface PersistedExtensionsFile {
  version: number;
  extensions: InstalledExtension[];
}

export interface ExtensionStore {
  /** The installed extensions, in install order (the boot-replay order). */
  list(): InstalledExtension[];
  /**
   * UPSERT an installed extension keyed by `manifest.source` (a re-install of the
   * same source replaces the prior entry, keeping the original `installedAt`), then
   * atomically persist. Called on a SUCCESSFUL admin install commit.
   */
  upsert(manifest: ExtensionManifest, opts?: { allowCrossSource?: boolean }): void;
  /**
   * REMOVE the installed extension for `source` (idempotent — a no-op for a source
   * that was never persisted, e.g. a bundle/tunnel registration), then persist.
   * Called on an admin remove.
   */
  remove(source: SourceId): void;
}

/** Whether a parsed entry is a structurally-usable installed-extension record. */
function isUsableEntry(e: unknown): e is InstalledExtension {
  if (!e || typeof e !== "object") return false;
  const rec = e as Partial<InstalledExtension>;
  const m = rec.manifest as Partial<ExtensionManifest> | undefined;
  // The manifest must at least carry a non-empty source id — the replay key + the
  // registry's own gate re-validates the rest, so we stay permissive here.
  return !!m && typeof m === "object" && typeof m.source === "string" && m.source.length > 0;
}

class FileExtensionStore implements ExtensionStore {
  /** In-memory record of truth, keyed by source id (install order preserved). */
  private readonly extensions = new Map<SourceId, InstalledExtension>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  private load(): void {
    const raw = readFileBestEffort(this.path);
    if (!raw) return;
    let parsed: Partial<PersistedExtensionsFile>;
    try {
      parsed = JSON.parse(raw) as Partial<PersistedExtensionsFile>;
    } catch {
      // Corrupt file — start empty (fail-open for the rest of boot). Never throw.
      return;
    }
    if (parsed.version !== EXTENSIONS_VERSION || !Array.isArray(parsed.extensions)) return;
    for (const e of parsed.extensions) {
      if (!isUsableEntry(e)) continue; // drop a malformed entry rather than trust it
      this.extensions.set(e.manifest.source, {
        manifest: e.manifest,
        allowCrossSource: e.allowCrossSource === true,
        installedAt: typeof e.installedAt === "string" ? e.installedAt : new Date().toISOString(),
      });
    }
  }

  list(): InstalledExtension[] {
    return [...this.extensions.values()];
  }

  upsert(manifest: ExtensionManifest, opts?: { allowCrossSource?: boolean }): void {
    if (!manifest || typeof manifest.source !== "string" || manifest.source.length === 0) return;
    const prior = this.extensions.get(manifest.source);
    this.extensions.set(manifest.source, {
      manifest,
      allowCrossSource: opts?.allowCrossSource === true,
      // Preserve the ORIGINAL install time across a re-install of the same source.
      installedAt: prior?.installedAt ?? new Date().toISOString(),
    });
    this.persist();
  }

  remove(source: SourceId): void {
    if (this.extensions.delete(source)) this.persist();
  }

  private persist(): void {
    try {
      const out: PersistedExtensionsFile = {
        version: EXTENSIONS_VERSION,
        extensions: [...this.extensions.values()],
      };
      atomicWrite(this.path, JSON.stringify(out, null, 2), 0o600);
    } catch {
      /* best-effort — authoritative state stays in memory (mirrors exposure.ts) */
    }
  }
}

/** Construct a store bound to the real (sandbox-aware) `~/.plexus/extensions.json`. */
export function createExtensionStore(): ExtensionStore {
  return new FileExtensionStore(homePath(EXTENSIONS_FILE));
}
