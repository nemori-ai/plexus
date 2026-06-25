/**
 * ManagedSources — the single managed-capability-sources service (Task 0, "the seam").
 *
 * ============================================================================
 * DELIVERABLE CONTRACT (downstream tasks depend on these STABLE signatures)
 * ----------------------------------------------------------------------------
 * `state.managedSources: ManagedSources` exposes the DESIGN §3 method surface:
 *
 *   list(): ConfiguredSource[]
 *   add(cfg, opts?): Promise<AddResult>
 *   remove(id): Promise<void>
 *   enable(id, opts?): Promise<AddResult>
 *   disable(id): Promise<void>
 *   reconfigure(id, patch, opts?): Promise<AddResult>
 *   detect(): Promise<unknown[]>   // Task 4 fills detectors; stub returns []
 *
 * Task 1 (bin flag bridge), Task 2 (admin API + Sources panel), Task 3 (CLI),
 * Task 4 (detect), and Task 5 (obsidian migration + grant-purge) all build on this
 * surface WITHOUT re-touching this file — except `kinds.ts` (detector wiring, T4)
 * and the `reconfigure` grant-purge surface (T5), which are inside this owned
 * config layer.
 * ============================================================================
 *
 * CORE SEMANTICS — register-then-persist with rollback (DESIGN §3/§4):
 *
 *   add/enable:
 *     1. resolve the kind adapter (unknown kind ⇒ reject, no mutation)
 *     2. project cfg → manifest (+ trusted handlers)
 *     3. registerExtension(manifest, { handlers, trusted:true })   // LIVE first
 *     4. if !ok ⇒ return the failure WITHOUT persisting (a source that won't
 *        register is never written)
 *     5. persist sources.json (config = desired state)
 *     6. if persist throws ⇒ best-effort unregister(id) and report (the two sides
 *        stay consistent — no orphan capability)
 *
 *   disable: unregister(id) + persist enabled:false (config RETAINED).
 *   enable:  add() semantics with enabled:true (re-register + persist).
 *   remove:  unregister(id) + drop from config + PURGE grants for removed ids
 *            (so a re-add of the same id can't silently re-use a prior approval).
 *   reconfigure: re-register the new manifest (registerExtension hot-swaps the
 *            module for the same id) + persist; on fail keep the old live + config.
 *            When the SECURITY SURFACE changes (route.baseUrl/vaultPath, secretRef,
 *            transport, kind) it ALSO purges the source's grants first, so a prior
 *            approval pointed at the OLD endpoint can't carry to the new target.
 *
 * Config = DESIRED state (restart-authoritative); registry = ACTUAL state
 * (run-authoritative, in-memory). ManagedSources is the only writer of both.
 *
 * SECURITY: registering a source makes its capabilities DISCOVERABLE only — grants
 * are still required to invoke (the authorizer + grant store are untouched). No
 * secret VALUE is ever persisted (secretRef is a name; `store.ts` enforces it).
 */

import type {
  AuditEventInput,
  CapabilityId,
  ExtensionManifest,
  ExtensionRegisterResponse,
  PlatformServices,
  SourceId,
} from "@plexus/protocol";
import type { CapabilityRegistry } from "../../core/capability-registry.ts";
import { detectSources, type DetectedSource } from "./detect.ts";
import { resolveKind } from "./kinds.ts";
import {
  readSourcesConfig,
  writeSourcesConfig,
} from "./store.ts";
import type {
  AddResult,
  ConfiguredSource,
  ManageOpts,
  SourcesConfigFile,
} from "./types.ts";

/**
 * The minimal capability-registry surface ManagedSources drives. `GatewayState`'s
 * `capabilities` satisfies it; tests can pass a real `createCapabilityRegistry`.
 */
export type ManagedRegistry = Pick<
  CapabilityRegistry,
  "registerExtension" | "unregister" | "revision"
>;

/** The minimal grant-store surface for the remove/reconfigure purge seam. */
export interface ManagedGrants {
  /** Remove every grant for a capability id (across agents). Returns the count. */
  removeForCapability(capabilityId: CapabilityId): number;
}

/** The minimal audit-writer surface (for the W-1 write-capable boot-load trail). */
export interface ManagedAudit {
  write(event: AuditEventInput): Promise<unknown>;
}

/** Verbs that make a capability WRITE-capable (mutating / executing), per §7. */
const WRITE_VERBS = new Set(["write", "execute", "delete", "admin"]);

/** True iff any capability the manifest declares carries a write-capable verb. */
function manifestIsWriteCapable(manifest: ExtensionManifest): boolean {
  for (const decl of manifest.capabilities ?? []) {
    for (const v of decl.grants ?? []) {
      if (WRITE_VERBS.has(v)) return true;
    }
  }
  return false;
}

/** The dependencies ManagedSources closes over (a slice of `GatewayState`). */
export interface ManagedSourcesDeps {
  capabilities: ManagedRegistry;
  /** Optional — the grant-purge seam (remove / reconfigure surface change). */
  grants?: ManagedGrants;
  /**
   * Optional — the audit writer. Used to log every WRITE-CAPABLE source loaded from
   * `sources.json` at boot (W-1 / F-4): boot-load is the trusted path (no re-pend),
   * so a config-tampered write source is registered without a human click — making
   * it VISIBLE in the audit trail is the W-1 mitigation the design mandates.
   */
  audit?: ManagedAudit;
  /**
   * Optional (Task 4) — the platform seam the scan/detect framework probes through
   * (loopback-enforced `locateLocalService`). Absent ⇒ `detect()` returns []. Used
   * for REACHABILITY probes only; never mutates config or registry.
   */
  platform?: PlatformServices;
}

/** The §3 method surface (the deliverable contract). */
export interface ManagedSources {
  /** Desired state from `sources.json` (in-memory mirror, restart-authoritative). */
  list(): ConfiguredSource[];
  /** Register LIVE then persist, with rollback on persist failure. */
  add(cfg: ConfiguredSource, opts?: ManageOpts): Promise<AddResult>;
  /** Unregister + drop from config + purge grants for the removed ids. */
  remove(id: SourceId): Promise<void>;
  /** Re-register + flip enabled:true + persist. */
  enable(id: SourceId, opts?: ManageOpts): Promise<AddResult>;
  /** Unregister + flip enabled:false + persist (config retained). */
  disable(id: SourceId): Promise<void>;
  /** Hot-swap the module for the same id (re-register) + persist. */
  reconfigure(id: SourceId, patch: Partial<ConfiguredSource>, opts?: ManageOpts): Promise<AddResult>;
  /**
   * Run scan/detect (Task 4). REACHABILITY/ADVISORY ONLY — probes the machine for
   * available sources and returns 0+ `DetectedSource` suggestions. NEVER auto-adds,
   * never persists, never registers, never touches a secret value. Returns [] when
   * no `platform` dep is wired.
   */
  detect(): Promise<DetectedSource[]>;
  /**
   * BOOT-LOAD helper — register every persisted ENABLED source. Best-effort: one
   * source failing to materialize/register logs + is skipped, NEVER aborts boot.
   * Returns the source ids that registered. Called by `bootScanCapabilities` after
   * the compile-time MODULES scan.
   */
  loadPersisted(): Promise<SourceId[]>;
}

class ManagedSourcesImpl implements ManagedSources {
  /** In-memory mirror of `sources.json` (the desired state). */
  private config: SourcesConfigFile;

  constructor(private readonly deps: ManagedSourcesDeps) {
    // Restart-authoritative: hydrate the desired state from disk on construction.
    this.config = readSourcesConfig();
  }

  list(): ConfiguredSource[] {
    return this.config.sources.map((s) => ({ ...s }));
  }

  private indexOf(id: SourceId): number {
    return this.config.sources.findIndex((s) => s.id === id);
  }

  /** Upsert a source into the in-memory config (does NOT write to disk). */
  private upsert(cfg: ConfiguredSource): void {
    const i = this.indexOf(cfg.id);
    if (i >= 0) this.config.sources[i] = cfg;
    else this.config.sources.push(cfg);
  }

  private fail(cfg: ConfiguredSource, reason: string): AddResult {
    return {
      ok: false,
      source: cfg,
      registered: [],
      revision: this.deps.capabilities.revision(),
      reason,
    };
  }

  /**
   * Register a `ConfiguredSource` LIVE then persist, rolling back the live register
   * if persist fails (DESIGN §4.1). Used by both `add` and `enable`/`reconfigure`.
   */
  private async registerThenPersist(cfg: ConfiguredSource): Promise<AddResult> {
    // 1. resolve the kind adapter — unknown kind ⇒ reject, no mutation.
    const adapter = resolveKind(cfg.kind);
    if (!adapter) return this.fail(cfg, `unknown source kind "${cfg.kind}"`);

    // 2. project → manifest (+ trusted in-process handlers).
    let manifest;
    let handlers;
    try {
      manifest = adapter.toManifest(cfg);
      handlers = adapter.handlers?.(cfg);
    } catch (err) {
      return this.fail(cfg, `materialize failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. register LIVE first (overlay + scan + revision++ + manifest_changed).
    let res: ExtensionRegisterResponse;
    try {
      res = await this.deps.capabilities.registerExtension(manifest, {
        ...(handlers ? { handlers } : {}),
        trusted: true,
      });
    } catch (err) {
      return this.fail(cfg, `register failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. a config that won't register is NOT persisted.
    if (!res.ok) {
      return { ok: false, source: cfg, registered: res.registered, revision: res.revision, reason: res.reason };
    }

    // 5. persist only after a clean live register. Snapshot for rollback.
    const prev = this.snapshot();
    this.upsert(cfg);
    try {
      writeSourcesConfig(this.config);
    } catch (err) {
      // 6. persist failed ⇒ roll back the live register so the two sides stay
      //    consistent (no orphan capability) and restore the in-memory mirror.
      this.config = prev;
      try {
        await this.deps.capabilities.unregister(cfg.id);
      } catch {
        /* best-effort rollback */
      }
      return this.fail(cfg, `persist failed (rolled back live register): ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ok: true, source: cfg, registered: res.registered, revision: res.revision };
  }

  /**
   * Does this reconfigure change the SECURITY SURFACE of the source — i.e. WHERE it
   * connects (route.baseUrl), WHICH credential it attaches (secretRef), or the
   * transport CLASS it dispatches over? Any of those means a prior approval was given
   * for a materially different target and must not carry over. A label/metadata-only
   * (or unrelated route extras) change returns false. (DESIGN §4.2.)
   */
  private securitySurfaceChanged(prev: ConfiguredSource, next: ConfiguredSource): boolean {
    return (
      prev.route?.baseUrl !== next.route?.baseUrl ||
      prev.route?.vaultPath !== next.route?.vaultPath ||
      prev.secretRef !== next.secretRef ||
      prev.transport !== next.transport ||
      prev.kind !== next.kind
    );
  }

  /**
   * Purge every grant for the capability ids this source currently materializes to
   * (best-effort). Reuses `grants.removeForCapability` per capability id — the SAME
   * purge `remove`/`DELETE /extensions` use — so a stale approval pointed at the old
   * security surface cannot be reused after the hot-swap. No-op without a grant dep.
   */
  private purgeGrantsForSource(cfg: ConfiguredSource): void {
    if (!this.deps.grants) return;
    let ids: CapabilityId[] = [];
    try {
      ids = this.capabilityIdsFor(cfg);
    } catch {
      /* best-effort: a materialize failure must not block the reconfigure */
    }
    for (const cid of ids) {
      try {
        this.deps.grants.removeForCapability(cid);
      } catch {
        /* best-effort */
      }
    }
  }

  /** The capability ids a `ConfiguredSource` materializes to (via its kind adapter). */
  private capabilityIdsFor(cfg: ConfiguredSource): CapabilityId[] {
    const adapter = resolveKind(cfg.kind);
    if (!adapter) return [];
    const manifest = adapter.toManifest(cfg);
    // A registered capability id is `${source}.${name}` (the registry's id scheme);
    // skill entries carry grants too but never hold an invoke grant, so purging their
    // (empty) grant set is harmless. We purge for ALL entries the manifest declares.
    return manifest.capabilities.map((c) => `${manifest.source}.${c.name}` as CapabilityId);
  }

  /** Deep-ish snapshot of the in-memory config for rollback. */
  private snapshot(): SourcesConfigFile {
    return { version: 1, sources: this.config.sources.map((s) => ({ ...s })) };
  }

  async add(cfg: ConfiguredSource, _opts?: ManageOpts): Promise<AddResult> {
    // NOTE: write-capable pend/approve routing (DESIGN §7) is wired by the
    // entry-point tasks (T2 admin / agent path). The trusted/boot/UI/CLI path is
    // human-approved by construction, so Task 0 registers directly. `_opts` carries
    // the approval context for those tasks.
    const normalized: ConfiguredSource = { ...cfg, enabled: cfg.enabled !== false };
    return this.registerThenPersist(normalized);
  }

  async enable(id: SourceId, opts?: ManageOpts): Promise<AddResult> {
    const i = this.indexOf(id);
    if (i < 0) {
      return this.fail(
        { id, kind: "", label: id, enabled: true, transport: "ipc" } as ConfiguredSource,
        `no configured source "${id}"`,
      );
    }
    const next: ConfiguredSource = { ...this.config.sources[i]!, enabled: true };
    return this.add(next, opts);
  }

  async disable(id: SourceId): Promise<void> {
    const i = this.indexOf(id);
    // Live removal first (revision bump, list_changed).
    try {
      await this.deps.capabilities.unregister(id);
    } catch {
      /* already-not-live is fine; config is the source of truth */
    }
    if (i < 0) return; // nothing persisted to flip — idempotent.
    // Flip enabled:false; config is RETAINED.
    const next: ConfiguredSource = { ...this.config.sources[i]!, enabled: false };
    const prev = this.snapshot();
    this.config.sources[i] = next;
    try {
      writeSourcesConfig(this.config);
    } catch {
      this.config = prev; // keep config consistent if persist fails
    }
  }

  async remove(id: SourceId): Promise<void> {
    // Unregister LIVE; capture the removed ids to purge their grants.
    let removed: CapabilityId[] = [];
    try {
      removed = await this.deps.capabilities.unregister(id);
    } catch {
      /* best-effort */
    }
    // PURGE GRANTS for the removed ids (the grant-purge seam — full surface-change
    // purge on reconfigure is Task 5; remove purges here so a re-add of the same id
    // can't silently re-use a prior approval).
    if (this.deps.grants) {
      for (const cid of removed) {
        try {
          this.deps.grants.removeForCapability(cid);
        } catch {
          /* best-effort */
        }
      }
    }
    // Drop from config + persist.
    const i = this.indexOf(id);
    if (i < 0) return;
    const prev = this.snapshot();
    this.config.sources.splice(i, 1);
    try {
      writeSourcesConfig(this.config);
    } catch {
      this.config = prev;
    }
  }

  async reconfigure(
    id: SourceId,
    patch: Partial<ConfiguredSource>,
    opts?: ManageOpts,
  ): Promise<AddResult> {
    const i = this.indexOf(id);
    if (i < 0) {
      return this.fail(
        { id, kind: "", label: id, enabled: true, transport: "ipc" } as ConfiguredSource,
        `no configured source "${id}"`,
      );
    }
    const current = this.config.sources[i]!;
    // The id is immutable for a reconfigure (hot-swap the SAME source id).
    const next: ConfiguredSource = { ...current, ...patch, id: current.id };
    // SECURITY-SURFACE CHANGE → grant purge (DESIGN §4.2, §7, F-4). A reconfigure that
    // re-points the source at a NEW target (baseUrl/host), swaps the credential it
    // attaches (secretRef), or changes the transport class MUST purge the grants for
    // this source's capabilities BEFORE the hot-swap, so a prior human approval pointed
    // at the OLD endpoint cannot silently carry over to the new one. A label-only /
    // cosmetic reconfigure (no security surface touched) does NOT purge — re-register
    // alone keeps the same approvals. `registerExtension` re-register never purges; only
    // ManagedSources does, here and on `remove`/`disable`.
    const surfaceChanged = this.securitySurfaceChanged(current, next);
    if (surfaceChanged) this.purgeGrantsForSource(current);
    if (next.enabled === false) {
      // A reconfigure that disables ⇒ behave as disable (unregister + persist).
      const prev = this.snapshot();
      this.config.sources[i] = next;
      try {
        await this.deps.capabilities.unregister(id);
      } catch {
        /* best-effort */
      }
      try {
        writeSourcesConfig(this.config);
      } catch (err) {
        this.config = prev;
        return this.fail(next, `persist failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { ok: true, source: next, registered: [], revision: this.deps.capabilities.revision() };
    }
    // Re-register hot-swaps the module for the same id; on fail keep old live+config.
    // Surface-change grant purge already ran above (when route.baseUrl/vaultPath/
    // secretRef/transport/kind changed) so a stale approval can't carry to the new
    // target. The re-register then re-publishes the (now grant-cleared) capabilities.
    return this.add(next, opts);
  }

  async detect(): Promise<DetectedSource[]> {
    // ADVISORY-ONLY: run the reachability detectors against the LIVE platform, mark
    // alreadyConfigured against the in-memory config mirror. NON-MUTATING — no add,
    // no persist, no register, no secret access. Without a platform dep ⇒ [].
    if (!this.deps.platform) return [];
    return detectSources(this.deps.platform, this.config.sources);
  }

  async loadPersisted(): Promise<SourceId[]> {
    const loaded: SourceId[] = [];
    // Re-read from disk so boot reflects the on-disk desired state exactly.
    this.config = readSourcesConfig();
    for (const cfg of this.config.sources) {
      if (!cfg.enabled) continue; // disabled sources are kept in the file, not loaded.
      const adapter = resolveKind(cfg.kind);
      if (!adapter) {
        // eslint-disable-next-line no-console
        console.warn(`[managed-sources] boot-load: unknown kind "${cfg.kind}" for "${cfg.id}" — skipped`);
        continue;
      }
      try {
        const manifest = adapter.toManifest(cfg);
        const handlers = adapter.handlers?.(cfg);
        const res = await this.deps.capabilities.registerExtension(manifest, {
          ...(handlers ? { handlers } : {}),
          trusted: true,
        });
        if (res.ok) {
          loaded.push(cfg.id);
          // W-1 / F-4: boot-load uses the trusted path (no re-pend), so a
          // config-tampered WRITE-capable source becomes live without a human click.
          // The mandated mitigation is VISIBILITY: emit a `source.install` audit event
          // for every write-capable boot-load so it cannot land silently.
          if (this.deps.audit && manifestIsWriteCapable(manifest)) {
            try {
              await this.deps.audit.write({
                type: "source.install",
                detail: {
                  source: cfg.id,
                  kind: "managed-source",
                  outcome: "boot-load",
                  writeCapable: true,
                  registered: res.registered,
                },
              });
            } catch {
              /* audit is best-effort; never abort boot */
            }
          }
        } else {
          // eslint-disable-next-line no-console
          console.warn(`[managed-sources] boot-load: "${cfg.id}" did not register — ${res.reason ?? "no entries"}`);
        }
      } catch (err) {
        // A single source failing to load must NEVER abort boot.
        // eslint-disable-next-line no-console
        console.warn(`[managed-sources] boot-load: "${cfg.id}" failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return loaded;
  }
}

/** Construct the managed-sources service over a slice of `GatewayState`. */
export function createManagedSources(deps: ManagedSourcesDeps): ManagedSources {
  return new ManagedSourcesImpl(deps);
}
