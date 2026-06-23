/**
 * Capability registry — the in-memory index of self-describe entries by id
 * (the "entries by id" box in the architecture diagram). Populated by scanning the
 * `SourceRegistry`'s sources; queried by discovery (`.well-known`), the handshake
 * manifest, grant authorization, and invoke routing.
 *
 * t7 IMPLEMENTATION: `refresh()` iterates every `SourceModule`, calls
 * `source.scan()`, aggregates the entries (deduped by id — first source to claim an
 * id wins, with a cross-source-collision guard), and bumps the monotonic revision
 * whenever the entry set changes. Each source's `onEntriesChanged` is wired so a
 * live change (an MCP `list_changed`, a source coming online) re-aggregates and
 * emits a change notification to subscribers (the core's `/events` subscribes via
 * `subscribe()`).
 *
 * With an empty `MODULES` set the registry is simply empty — which is what the
 * bootable M0 server serves.
 */

import type {
  CapabilityEntry,
  CapabilityId,
  CapabilitySource,
  CapabilitySummary,
  ExtensionManifest,
  ExtensionRegisterResponse,
  SourceId,
  SourceModule,
  SourceRegistry,
} from "../protocol/index.ts";
import { getPlatformServices } from "../platform/index.ts";
import {
  materializeExtension,
  manifestEntries,
  type ExtensionHandler,
} from "../sources/extension.ts";

/** A diff hint emitted alongside a revision bump (mirrors `ManifestChangedEvent.changed`). */
export interface EntrySetChange {
  revision: number;
  added: CapabilityId[];
  removed: CapabilityId[];
  updated: CapabilityId[];
}

export interface CapabilityRegistry {
  /** All currently-known entries (full self-describe). */
  all(): CapabilityEntry[];
  /** Look up one entry by id. */
  get(id: CapabilityId): CapabilityEntry | undefined;
  /** Alias of `get` — the lookup name the core's invoke pipeline reads for. */
  getEntry(id: CapabilityId): CapabilityEntry | undefined;
  /** Project every entry to its `.well-known` summary line (§2). */
  summaries(): CapabilitySummary[];
  /** Monotonic revision of the entry set (§3 Manifest.revision). */
  revision(): number;
  /**
   * Start each source (owns persistent clients) then run an initial scan.
   * Idempotent: safe to call once at boot.
   */
  start(): Promise<void>;
  /** Stop each started source (tear down persistent clients). */
  stop(): Promise<void>;
  /** Re-scan all sources and repopulate (bumps revision on change). */
  refresh(): Promise<void>;
  /**
   * Subscribe to entry-set changes (revision bumps). The core's `GET /events`
   * subscribes here to emit `manifest_changed`. Returns an unsubscribe fn.
   */
  subscribe(cb: (change: EntrySetChange) => void): () => void;

  /**
   * GAP B — register a USER EXTENSION at runtime (Flow B). Materializes the
   * `ExtensionManifest` into a runtime `CapabilitySource` (a `SourceModule`),
   * registers it so its capabilities are both DISCOVERABLE (scan / getEntry /
   * manifest / summaries) AND INVOCABLE (the invoke pipeline resolves the source's
   * bridge through the shared `SourceRegistry`), bumps the revision + emits a
   * `manifest_changed` via the change hook, and returns the `ExtensionRegisterResponse`.
   *
   * `opts.handlers` binds in-process capability handlers by declaration name (e.g.
   * the path-confined Obsidian vault read) — the HTTP `POST /extensions` path calls
   * this with the manifest only (transport-backed extensions); the in-process
   * one-sentence flow passes handlers for gateway-owned capabilities.
   */
  registerExtension(
    manifest: ExtensionManifest,
    opts?: { handlers?: Record<string, ExtensionHandler> },
  ): Promise<ExtensionRegisterResponse>;
}

/** Project a full entry to its `.well-known` summary (the SUMMARY tier, ADR-008). */
export function toSummary(entry: CapabilityEntry): CapabilitySummary {
  // One-line teaser of `describe` (full text only in the handshake manifest).
  const summary = entry.describe.split("\n")[0]?.trim() ?? "";
  return {
    id: entry.id,
    source: entry.source,
    kind: entry.kind,
    label: entry.label,
    summary,
    grants: entry.grants,
    transport: entry.transport,
  };
}

class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private entries = new Map<CapabilityId, CapabilityEntry>();
  private rev = 0;
  /** Instantiated lifecycle-layer sources, keyed by source id. */
  private readonly liveSources = new Map<SourceId, CapabilitySource>();
  private readonly subscribers = new Set<(change: EntrySetChange) => void>();
  /**
   * Runtime-registered user-extension modules (Flow B). These are NOT in the
   * compile-time `MODULES` map; they are materialized from an `ExtensionManifest`
   * at `POST /extensions` time. They are surfaced to the rest of the gateway by
   * augmenting the shared `SourceRegistry`'s `get`/`all` (see `ensureRegistryOverlay`)
   * so the invoke pipeline — which resolves a source's bridge via `sources.get(id)` —
   * can route to them without the core ever knowing they were added at runtime.
   */
  private readonly extensionModules = new Map<SourceId, SourceModule>();
  private overlayInstalled = false;

  constructor(private readonly sources: SourceRegistry) {}

  /**
   * Install an overlay over the shared `SourceRegistry` so that runtime extension
   * modules are resolvable through the SAME `get`/`all` every caller uses (notably
   * the invoke pipeline, which reads `state.sources.get(sourceId)`). The capability
   * registry and the invoke pipeline share the SAME `SourceRegistry` object by
   * reference (both come from `createGatewayState`), so wrapping its methods in
   * place is the sanctioned runtime-registration seam — no compile-time `MODULES`
   * edit, no core branching. Idempotent.
   */
  private ensureRegistryOverlay(): void {
    if (this.overlayInstalled) return;
    this.overlayInstalled = true;
    const reg = this.sources;
    const ext = this.extensionModules;
    const baseGet = reg.get.bind(reg);
    const baseAll = reg.all.bind(reg);
    reg.get = (id: SourceId): SourceModule | undefined => baseGet(id) ?? ext.get(id);
    reg.all = (): SourceModule[] => {
      const compile = baseAll();
      const seen = new Set(compile.map((m) => m.id));
      return [...compile, ...[...ext.values()].filter((m) => !seen.has(m.id))];
    };
  }

  all(): CapabilityEntry[] {
    return [...this.entries.values()];
  }

  get(id: CapabilityId): CapabilityEntry | undefined {
    return this.entries.get(id);
  }

  getEntry(id: CapabilityId): CapabilityEntry | undefined {
    return this.entries.get(id);
  }

  summaries(): CapabilitySummary[] {
    return this.all().map(toSummary);
  }

  revision(): number {
    return this.rev;
  }

  subscribe(cb: (change: EntrySetChange) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Lazily instantiate (and cache) a source's lifecycle object via its module. */
  private ensureSource(id: SourceId): CapabilitySource | undefined {
    const existing = this.liveSources.get(id);
    if (existing) return existing;
    const mod = this.sources.get(id);
    if (!mod) return undefined;
    const platform = getPlatformServices();
    const source = mod.createSource(platform);
    this.liveSources.set(id, source);
    // Wire live entry-set changes: a source emitting onEntriesChanged triggers a
    // full re-aggregate so the registry view + revision stay consistent.
    source.onEntriesChanged?.(() => {
      void this.refresh();
    });
    return source;
  }

  async start(): Promise<void> {
    for (const mod of this.sources.all()) {
      const source = this.ensureSource(mod.id);
      if (source) {
        try {
          await source.start();
        } catch {
          // A source failing to start must not abort the whole gateway; it simply
          // contributes no entries (its checkRequirements/scan will report why).
        }
      }
    }
    await this.refresh();
  }

  async stop(): Promise<void> {
    for (const source of this.liveSources.values()) {
      try {
        await source.stop();
      } catch {
        /* best-effort teardown */
      }
    }
  }

  async refresh(): Promise<void> {
    const next = new Map<CapabilityId, CapabilityEntry>();

    for (const mod of this.sources.all()) {
      const source = this.ensureSource(mod.id);
      if (!source) continue;
      let scanned: CapabilityEntry[];
      try {
        scanned = await source.scan();
      } catch {
        // A source that fails to scan contributes nothing this pass; keep going.
        continue;
      }
      for (const entry of scanned) {
        const prior = next.get(entry.id);
        if (prior && prior.source !== entry.source) {
          // ID-DERIVATION RULE makes ids source-recoverable, so a cross-source id
          // collision is a source bug. Keep the first; skip the duplicate.
          continue;
        }
        next.set(entry.id, entry);
      }
    }

    // Diff against the current set to decide whether to bump the revision.
    const change = this.diff(this.entries, next);
    this.entries = next;
    if (change.added.length || change.removed.length || change.updated.length) {
      this.rev += 1;
      const evt: EntrySetChange = { revision: this.rev, ...change };
      for (const cb of this.subscribers) cb(evt);
    }
  }

  private diff(
    prev: Map<CapabilityId, CapabilityEntry>,
    next: Map<CapabilityId, CapabilityEntry>,
  ): { added: CapabilityId[]; removed: CapabilityId[]; updated: CapabilityId[] } {
    const added: CapabilityId[] = [];
    const removed: CapabilityId[] = [];
    const updated: CapabilityId[] = [];
    for (const [id, entry] of next) {
      const before = prev.get(id);
      if (!before) added.push(id);
      else if (JSON.stringify(before) !== JSON.stringify(entry)) updated.push(id);
    }
    for (const id of prev.keys()) {
      if (!next.has(id)) removed.push(id);
    }
    return { added, removed, updated };
  }

  async registerExtension(
    manifest: ExtensionManifest,
    opts?: { handlers?: Record<string, ExtensionHandler> },
  ): Promise<ExtensionRegisterResponse> {
    if (manifest?.manifest !== "plexus-extension/0.1" || !manifest.source) {
      return {
        ok: false,
        source: manifest?.source ?? "",
        registered: [],
        revision: this.rev,
        reason: "invalid extension manifest (expected manifest 'plexus-extension/0.1' + a source)",
      };
    }

    const platform = getPlatformServices();
    const module = materializeExtension(manifest, platform, opts?.handlers);

    // Surface the module to the shared SourceRegistry so the invoke pipeline can
    // resolve its bridge, then re-scan so its entries enter the registry. Drop any
    // stale lifecycle source for this id so a re-register picks up the new module.
    this.ensureRegistryOverlay();
    this.extensionModules.set(manifest.source, module);
    this.liveSources.delete(manifest.source);

    // Start the (idempotent) lifecycle source, then refresh — refresh() iterates
    // sources.all() (now including this module) and bumps the revision + emits a
    // change to subscribers (the core's /events) when the entry set changes.
    const source = this.ensureSource(manifest.source);
    if (source) {
      try {
        await source.start();
      } catch {
        /* a source that fails to start contributes no entries; report below */
      }
    }
    await this.refresh();

    // The ids this extension actually contributed (those now present in the registry).
    const declaredIds = manifestEntries(manifest).map((e) => e.id);
    const registered = declaredIds.filter((id) => this.entries.has(id));

    return {
      ok: registered.length > 0,
      source: manifest.source,
      registered,
      revision: this.rev,
      ...(registered.length === 0
        ? { reason: "extension materialized but contributed no entries" }
        : {}),
    };
  }
}

/** Build the (empty until scanned) capability registry over a source registry. */
export function createCapabilityRegistry(sources: SourceRegistry): CapabilityRegistry {
  return new InMemoryCapabilityRegistry(sources);
}
