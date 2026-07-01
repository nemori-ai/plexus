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
  CapabilityAddress,
  CapabilityEntry,
  CapabilityHealth,
  CapabilityId,
  CapabilitySource,
  CapabilitySummary,
  ExtensionManifest,
  ExtensionRegisterResponse,
  GrantVerb,
  Provenance,
  Sensitivity,
  SourceId,
  SourceModule,
  SourceRegistry,
  TenantId,
  TrustWindow,
  TrustWindowKind,
  WorkloadName,
} from "@plexus/protocol";
import { DEFAULT_TENANT, mountAddress } from "../mesh/addressing.ts";
import { createSourceHealthCache, type SourceHealthCache } from "./source-health.ts";
import {
  DEFAULT_TRUST_WINDOWS,
  type DefaultTrustWindows,
  type TrustWindowClassKey,
} from "../config.ts";
import { getPlatformServices } from "../platform/index.ts";
import {
  materializeExtension,
  manifestEntries,
  validateManifest,
  applyCrossSourceAttach,
  type ExtensionHandler,
} from "../sources/extension.ts";
import { validateWorkflowGraph } from "./workflow-validate.ts";
import { MODULES } from "../sources/index.ts";

/**
 * RESERVED FIRST-PARTY SOURCE IDS (security review must-fix #5). A wire
 * `POST /extensions` manifest must NOT declare a `source` that collides with a
 * compile-time first-party source id — that would let a user extension impersonate
 * cc-master/obsidian/… (the first-claim-wins collision rule would otherwise let it
 * register the non-colliding rest while masquerading). Seeded from the compile-time
 * `MODULES` set plus the well-known first-party sources that self-register in-process
 * (obsidian/mock). Trusted in-process registrations (those supplying handlers or
 * `trusted:true`) ARE these sources and are exempt.
 *
 * RESERVED-vs-ACTIVE split (P3-1): this set keys on the FULL `MODULES` map, so EVERY
 * first-party id is reserved on EVERY platform — including ids gated OUT of the active
 * registry on Linux (Apple/exec sources). A Linux gateway does not SCAN/ADVERTISE them
 * (the active set is platform-filtered in `createSourceRegistry` via
 * `activeModulesForPlatform`), but it still RESERVES their ids so a Linux extension can
 * never squat `apple-calendar`/`codex`/… The two notions are intentionally decoupled:
 * reservation is static + cross-platform; the active module set is platform-filtered.
 */
export const RESERVED_SOURCE_IDS: ReadonlySet<SourceId> = new Set<SourceId>([
  ...MODULES.map((m) => m.id),
  "obsidian",
  "mock",
]);

// ── Unified-trust posture derivation (ADR-018) ───────────────────────────────

/**
 * The 3-class source-class rule (ADR-018). A source is:
 *  - "first-party" when it is a reserved/in-process id (RESERVED_SOURCE_IDS);
 *  - "managed"     when the user added it through the admin UI (in `managedSourceIds`);
 *  - "extension"   otherwise (wire-registered by an agent).
 * `managed` shares first-party READ posture; `extension` is strictest (any verb pends).
 */
export function provenanceFor(
  source: SourceId,
  managedSourceIds?: ReadonlySet<SourceId>,
): Provenance {
  if (RESERVED_SOURCE_IDS.has(source)) return "first-party";
  if (managedSourceIds?.has(source)) return "managed";
  return "extension";
}

/** Whether a verb set is mutating (write or execute). */
function isMutating(verbs: readonly GrantVerb[]): boolean {
  return verbs.includes("write") || verbs.includes("execute");
}

/**
 * Sensitivity derivation (ADR-018, §SENS — gateway-computed so all surfaces agree):
 *  - "low"      = read on first-party/managed.
 *  - "elevated" = write/exec on first-party/managed, OR read on extension.
 *  - "high"     = write/exec on extension, OR any cli/local-rest transport with write/exec.
 * Workflow entries roll up their members' sensitivity (max wins) — handled by the caller
 * that has the registry to resolve members; for a leaf this derives from verbs+provenance.
 */
export function sensitivityFor(entry: CapabilityEntry, verbs: readonly GrantVerb[]): Sensitivity {
  const provenance = entry.provenance ?? provenanceFor(entry.source);
  const mutating = isMutating(verbs);
  if (mutating) {
    // Any cli/local-rest transport with write/exec is high; extension write/exec is high.
    if (entry.transport === "cli" || entry.transport === "local-rest" || provenance === "extension") {
      return "high";
    }
    return "elevated";
  }
  // Read-only.
  if (provenance === "extension") return "elevated";
  return "low";
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = { low: 0, elevated: 1, high: 2 };

/** The higher (riskier) of two sensitivities (max wins, for workflow roll-up). */
function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

/** Map a window kind to its descriptor (ms filled for fixed durations). */
const WINDOW_MS: Partial<Record<TrustWindowKind, number>> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** Build a `TrustWindow` descriptor from a kind (informational ms for fixed kinds). */
export function trustWindowFromKind(kind: TrustWindowKind): TrustWindow {
  const ms = WINDOW_MS[kind];
  return ms !== undefined ? { kind, ms } : { kind };
}

/**
 * The recommended default trust-window for an entry by class+verb (ADR-018 D-window).
 * Reads the (config-backed) `defaultTrustWindows` table; falls back to the ratified
 * `DEFAULT_TRUST_WINDOWS` when no table is supplied.
 */
export function recommendedTrustWindowFor(
  provenance: Provenance,
  verbs: readonly GrantVerb[],
  table: DefaultTrustWindows = DEFAULT_TRUST_WINDOWS,
): TrustWindow {
  const verbClass: "read" | "write" = isMutating(verbs) ? "write" : "read";
  const key = `${provenance}:${verbClass}` as TrustWindowClassKey;
  return trustWindowFromKind(table[key]);
}

/** A diff hint emitted alongside a revision bump (mirrors `ManifestChangedEvent.changed`). */
export interface EntrySetChange {
  revision: number;
  added: CapabilityId[];
  removed: CapabilityId[];
  updated: CapabilityId[];
}

/** The zero-exposure posture a freshly-mounted remote workload's caps default into (§7 Q3). */
export type MeshExposureDefault = "hidden";

/** Options for `mountRemoteWorkload` (the primary-mount / ascent-rewrite seam, Invariant F). */
export interface MeshMountOptions {
  /** Top address segment; defaults to the implicit personal tenant (`"local"`, §7 Q5). */
  tenant?: TenantId;
  /** Posture mounted caps enter in; defaults to `"hidden"` (zero-exposure, §7 Q3). */
  exposureDefault?: MeshExposureDefault;
  /** Bare ids withdrawn since the last push — their mounted addresses are un-mounted. */
  withdrawn?: CapabilityId[];
}

/** Result of a mount — the addresses now in/out of the directory + the new revision. */
export interface MeshMountResult {
  mounted: CapabilityAddress[];
  withdrawn: CapabilityAddress[];
  revision: number;
}

/** The forward-boundary target: which workload + which BARE id an address translates to (T7). */
export interface MeshForwardTarget {
  workload: WorkloadName;
  bareId: CapabilityId;
}

/** One per-source health row (HEALTH) for `GET /admin/api/health`. */
export interface SourceHealthRow {
  id: SourceId;
  label: string;
  status: CapabilityHealth["status"];
  detail?: string;
  checkedAt?: string;
  /** The capability ids that INHERIT this source's health (per-source granularity). */
  capabilities: CapabilityId[];
}

/** The per-source health report — one row per live source, stamped with the revision. */
export interface SourceHealthReport {
  sources: SourceHealthRow[];
  /** The registry revision the report was taken at (so a stale report is detectable). */
  revision: number;
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
  /**
   * Project every entry to a full `CapabilityEntry` with trust posture STAMPED
   * (provenance/sensitivity/recommendedTrustWindow) — the manifest projection so
   * every surface reads identical values (ADR-018). `all()` stays the raw routing
   * view; this is the descriptive projection.
   */
  projectedEntries(): CapabilityEntry[];
  /** Stamp trust posture onto a single entry (provenance/sensitivity/recommendedTrustWindow). */
  stampPosture(entry: CapabilityEntry): CapabilityEntry;
  /**
   * The CACHED per-source health snapshot (HEALTH) for a source id — synchronous,
   * stale-while-revalidate (returns the last value + refreshes in the background;
   * "unknown" until the first probe resolves). Used to STAMP summaries/entries and
   * to answer `GET /admin/api/health` + reconcile the invoke `source_unavailable`.
   */
  healthOf(sourceId: SourceId): CapabilityHealth;
  /**
   * MESH HEALTH PROVIDER (mesh-health-reporting.md §6). Install a resolver the registry consults
   * FIRST when stamping/serving the health of a synthetic `mesh:<workload>` bridge source. The
   * mesh runtime wires it to the last REPORTED health (route-first), so a mounted remote cap
   * resolves a real status instead of the SourceHealthCache's "unavailable/unknown" for a source
   * that has no live local object. Returns `undefined` for a non-mesh source ⇒ the cache governs.
   * Idempotent; a second call replaces the provider.
   */
  setMeshHealthProvider(provider: (sourceId: SourceId) => CapabilityHealth | undefined): void;
  /**
   * Probe a source's health NOW and update the cache (awaitable). The admin health
   * endpoint calls this so the first admin read is accurate (not a lazy "unknown").
   */
  refreshHealth(sourceId: SourceId): Promise<CapabilityHealth>;
  /** The per-source health report: one row per live source + its inherited capabilities. */
  healthReport(): SourceHealthReport;
  /**
   * Configure the unified-trust posture inputs (ADR-018): a provider of the LIVE
   * managed-source-id set (for the `managed` class) + the default-trust-window
   * table. Injected at state construction so the registry stays decoupled from
   * `managedSources`. Idempotent.
   */
  setPostureInputs(inputs: {
    managedSourceIds?: () => ReadonlySet<SourceId>;
    defaultTrustWindows?: DefaultTrustWindows;
  }): void;
  /** Monotonic revision of the entry set (§3 Manifest.revision). */
  revision(): number;
  /**
   * Force a monotonic revision bump WITHOUT a source re-scan, returning the new
   * revision. Used when the AGENT-VISIBLE manifest projection changes for a reason
   * other than the entry set itself — notably a top-level EXPOSURE toggle ("What I
   * expose"), which hides/reveals an existing entry. The caller publishes the
   * `manifest_changed` event so connected agents re-fetch `GET /manifest`.
   */
  bumpRevision(): number;
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
    opts?: RegisterExtensionOptions,
  ): Promise<ExtensionRegisterResponse>;

  /**
   * VALIDATE-vs-COMMIT SEAM (for m4sec-auth). Run the FULL registration-time
   * validation for a candidate manifest WITHOUT committing it — returns the reasons
   * it would be rejected (empty ⇒ would register cleanly) plus the cross-source
   * provenance to surface at the user-confirm step. m4sec-auth calls this to build
   * the confirm prompt, then calls `registerExtension` only after the user confirms.
   * `registerExtension` runs the SAME validation internally so a direct register can
   * never bypass it.
   */
  validateRegistration(
    manifest: ExtensionManifest,
    opts?: RegisterExtensionOptions,
  ): ValidateRegistrationResult;

  /**
   * UNREGISTER (security review fork #3, P-3). Remove a runtime-registered
   * extension's entries + module, bump the revision, and emit a `list_changed`
   * change to subscribers. Returns the ids that were removed. A no-op (returns `[]`)
   * for a source that was not runtime-registered (compile-time MODULES are NOT
   * removable this way). The DELETE /extensions ENDPOINT is m4sec-auth's job; this
   * is the registry function it calls.
   */
  unregister(sourceId: SourceId): Promise<CapabilityId[]>;

  /**
   * MESH PRIMARY-MOUNT (federated-mesh §3.2 / §7 Q4, Invariant F; T6). Mount a remote
   * proxy workload's BARE-id `CapabilityEntry[]` into THIS directory: prepend
   * `tenant/workload/` onto each id → a full `CapabilityAddress` (the ascent-rewrite —
   * the prefix is applied EXACTLY ONCE, here), stamp `transport:"mesh"` + a `mesh:<workload>`
   * source, default them ZERO-EXPOSURE (§7 Q3), bump the revision + emit a change. The
   * sibling of `registerExtension` for capabilities that arrive over the tunnel rather
   * than from a local `SourceModule`. Idempotent per address (re-push overwrites).
   */
  mountRemoteWorkload(
    workload: WorkloadName,
    entries: CapabilityEntry[],
    opts?: MeshMountOptions,
  ): MeshMountResult;

  /**
   * INVERSE TRANSLATE for the forward boundary (T7 calls this): map a mounted
   * `CapabilityAddress` back to `{ workload, bareId }` so the primary can forward the BARE
   * id down the right proxy tunnel. The counterpart to the prefix `mountRemoteWorkload`
   * applied — keeping ALL prefix handling at this one seam. Returns `undefined` for an
   * address this registry never mounted.
   */
  forwardAddress(address: CapabilityAddress): MeshForwardTarget | undefined;

  /**
   * MESH REVOCATION (B6, federated-mesh §6.4 / Invariant E). UN-mount EVERY address
   * this registry holds for `workload` in one shot — the whole-workload counterpart to
   * `mountRemoteWorkload(..., {withdrawn})` (which un-mounts a single bare id). Deletes
   * each mounted entry + its forward route + its exposure default, bumps the revision, and
   * emits ONE `EntrySetChange` whose `removed` lists the gone addresses (so the core's
   * `/events` publishes `manifest_changed` and connected agents re-fetch the manifest).
   * Returns the un-mounted addresses so the revoke orchestrator can purge their grants.
   * A no-op (returns `[]`) for a workload with nothing mounted.
   */
  unmountWorkload(workload: WorkloadName): CapabilityAddress[];

  /**
   * The per-id exposure DEFAULT hook (phase-1 plan risk #4): `"hidden"` for a
   * mesh-mounted address (so it is invisible in discovery until the owner enables it,
   * §7 Q3), `undefined` for everything else (local sources keep their default-EXPOSED
   * semantics). The `ExposureStore` consults this so zero-exposure rides on provenance
   * WITHOUT bloating `exposure.json` (a hidden-by-default id needs no explicit entry).
   */
  exposureDefaultFor(id: CapabilityId): MeshExposureDefault | undefined;
}

/** Options for `registerExtension` / `validateRegistration`. */
export interface RegisterExtensionOptions {
  /**
   * In-process capability handlers bound by declaration name (the TRUSTED path —
   * Obsidian's path-confined vault read). Supplying handlers marks this as a
   * first-party in-process registration, which is exempt from first-party-id
   * RESERVATION (a wire `POST /extensions` register supplies NO handlers and is
   * therefore subject to reservation). `route.handler` over the wire is always
   * stripped regardless.
   */
  handlers?: Record<string, ExtensionHandler>;
  /**
   * Explicit trust marker for an in-process registration that supplies no handlers
   * but is still first-party (e.g. a compile-time source re-materialized). When
   * true, first-party-id reservation is bypassed. Defaults to "trusted iff handlers
   * supplied".
   */
  trusted?: boolean;
  /**
   * Gate for CROSS-SOURCE skill attach (P-1, must-fix #6). Default OFF: a skill in
   * this manifest may NOT attach onto another source's capability unless this is
   * true (m4sec-auth flips it behind a user-confirm). Same-source attach is always
   * allowed.
   */
  allowCrossSource?: boolean;
}

/** Result of the validate-vs-commit seam. */
export interface ValidateRegistrationResult {
  ok: boolean;
  /** Why it would be rejected (empty ⇒ valid). */
  reasons: string[];
  /** Workflow → foreign source ids reached, for the confirm prompt. */
  crossSourceProvenance: Record<CapabilityId, SourceId[]>;
}

/**
 * Project a full entry to its `.well-known` summary (the SUMMARY tier, ADR-008).
 * Mirrors the entry's trust posture (provenance/sensitivity/recommendedTrustWindow)
 * when present so the discovery summary carries the same facts as the manifest.
 *
 * `health` (HEALTH) is the INHERITED per-source health snapshot, threaded in by the
 * caller (the registry stamps it from its short-TTL cache). When supplied it rides
 * onto the summary so a window-shopping agent sees the advisory health up front.
 */
export function toSummary(entry: CapabilityEntry, health?: CapabilityHealth): CapabilitySummary {
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
    ...(entry.provenance ? { provenance: entry.provenance } : {}),
    ...(entry.sensitivity ? { sensitivity: entry.sensitivity } : {}),
    ...(entry.recommendedTrustWindow ? { recommendedTrustWindow: entry.recommendedTrustWindow } : {}),
    // Prefer a pre-stamped health on the entry; else the caller-threaded snapshot.
    ...(entry.health ?? health ? { health: entry.health ?? health } : {}),
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
  /**
   * MESH-MOUNTED entries (T6), keyed by full `CapabilityAddress`. Kept SEPARATE from
   * `entries` (the locally-scanned set) so `refresh()` — which rebuilds `entries` from
   * `sources.all()` — never wipes capabilities that arrived over the tunnel. Merged into
   * `all()`/`get()` so every read surface (discovery/manifest/grant/invoke) sees them.
   */
  private readonly mountedEntries = new Map<CapabilityAddress, CapabilityEntry>();
  /** address → forward target (`{ workload, bareId }`) — the inverse-translate index (T7). */
  private readonly mountedRoutes = new Map<CapabilityAddress, MeshForwardTarget>();
  /** address → its zero-exposure default posture (drives `exposureDefaultFor`, §7 Q3). */
  private readonly mountedExposure = new Map<CapabilityAddress, MeshExposureDefault>();
  /** Per-source cross-source-attach gate, remembered so refresh() matches register. */
  private readonly crossSourceAllowed = new Map<SourceId, boolean>();
  /** Provider of the LIVE managed-source-id set (ADR-018 `managed` class). */
  private managedSourceIds: () => ReadonlySet<SourceId> = () => new Set<SourceId>();
  /** The config-backed default-trust-window table (ADR-018 D-window). */
  private defaultTrustWindows: DefaultTrustWindows = DEFAULT_TRUST_WINDOWS;
  /**
   * Per-source HEALTH cache (HEALTH). Resolves the LIVE source via `ensureSource`
   * (without starting it — it's already started at boot) and caches each probe on a
   * short TTL, stale-while-revalidate. Summaries/entries stamp from it synchronously.
   */
  private readonly health: SourceHealthCache;
  /**
   * MESH HEALTH PROVIDER (mesh-health-reporting.md §6). Consulted FIRST for a `mesh:<workload>`
   * source's health (the last REPORTED value), falling back to the local `SourceHealthCache`.
   * `undefined` until the mesh runtime wires it (a non-mesh gateway never sets it).
   */
  private meshHealthProvider?: (sourceId: SourceId) => CapabilityHealth | undefined;

  constructor(private readonly sources: SourceRegistry) {
    this.health = createSourceHealthCache((id) => this.ensureSource(id));
  }

  setMeshHealthProvider(provider: (sourceId: SourceId) => CapabilityHealth | undefined): void {
    this.meshHealthProvider = provider;
  }

  /**
   * Resolve a source's health, mesh-provider-FIRST (mesh-health-reporting.md §6): a
   * `mesh:<workload>` source resolves from the reported health; every local source falls through
   * to the short-TTL `SourceHealthCache`. The one seam that turns a mounted remote cap's "unknown"
   * into a real value across every read surface (stamp/manifest/summaries/health report).
   */
  private resolvedHealth(sourceId: SourceId): CapabilityHealth {
    return this.meshHealthProvider?.(sourceId) ?? this.health.cached(sourceId);
  }

  setPostureInputs(inputs: {
    managedSourceIds?: () => ReadonlySet<SourceId>;
    defaultTrustWindows?: DefaultTrustWindows;
  }): void {
    if (inputs.managedSourceIds) this.managedSourceIds = inputs.managedSourceIds;
    if (inputs.defaultTrustWindows) this.defaultTrustWindows = inputs.defaultTrustWindows;
  }

  /**
   * Stamp the unified-trust posture onto an entry (ADR-018): provenance from the
   * 3-class rule, sensitivity from the derivation (workflows roll up members),
   * recommendedTrustWindow from the class+verb default table. Returns a NEW object
   * (never mutates the stored entry); a pre-stamped value on the entry is preserved.
   */
  stampPosture(entry: CapabilityEntry): CapabilityEntry {
    const managed = this.managedSourceIds();
    const provenance = entry.provenance ?? provenanceFor(entry.source, managed);
    // Pass the RESOLVED provenance into the derivation: `sensitivityFor` re-derives
    // provenance from `entry.source` WITHOUT the managed-source set, so a managed
    // source would otherwise be mis-seen as `extension` (managed reads → elevated
    // instead of low). Mirrors the member roll-up below (`{ ...m, provenance: mProv }`).
    let sensitivity = entry.sensitivity ?? sensitivityFor({ ...entry, provenance }, entry.grants);
    // Workflow roll-up: the blast radius is the max of the workflow's own + members'.
    if (entry.kind === "workflow" && entry.members?.length) {
      for (const member of entry.members) {
        const m = this.entries.get(member.id);
        if (!m) continue;
        const mProv = m.provenance ?? provenanceFor(m.source, managed);
        const mSens = m.sensitivity ?? sensitivityFor({ ...m, provenance: mProv }, member.verbs);
        sensitivity = maxSensitivity(sensitivity, mSens);
      }
    }
    const recommendedTrustWindow =
      entry.recommendedTrustWindow ??
      recommendedTrustWindowFor(provenance, entry.grants, this.defaultTrustWindows);
    // HEALTH: stamp the INHERITED per-source health snapshot (per-source granularity).
    // Cached + stale-while-revalidate — never blocks this synchronous projection. A
    // `mesh:<workload>` source resolves via the mesh-health provider (reported), else the cache.
    const health = entry.health ?? this.resolvedHealth(entry.source);
    return { ...entry, provenance, sensitivity, recommendedTrustWindow, health };
  }

  projectedEntries(): CapabilityEntry[] {
    return this.all().map((e) => this.stampPosture(e));
  }

  healthOf(sourceId: SourceId): CapabilityHealth {
    return this.resolvedHealth(sourceId);
  }

  refreshHealth(sourceId: SourceId): Promise<CapabilityHealth> {
    return this.health.refresh(sourceId);
  }

  healthReport(): SourceHealthReport {
    // One row per source that currently contributes ≥1 live entry (per-source
    // granularity: every capability inherits its source's single health value).
    const bySource = new Map<SourceId, { label: string; capabilities: CapabilityId[] }>();
    for (const entry of this.all()) {
      let row = bySource.get(entry.source);
      if (!row) {
        const live = this.liveSources.get(entry.source);
        row = { label: live?.label ?? entry.source, capabilities: [] };
        bySource.set(entry.source, row);
      }
      row.capabilities.push(entry.id);
    }
    const sources: SourceHealthRow[] = [];
    for (const [id, row] of bySource) {
      const h = this.resolvedHealth(id);
      sources.push({
        id,
        label: row.label,
        status: h.status,
        ...(h.detail ? { detail: h.detail } : {}),
        ...(h.checkedAt ? { checkedAt: h.checkedAt } : {}),
        capabilities: row.capabilities,
      });
    }
    return { sources, revision: this.rev };
  }

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
    // Local (scanned) ∪ mesh-mounted. Addresses carry `/`, bare local ids do not, so the
    // two key spaces never collide — the merge is disjoint.
    return [...this.entries.values(), ...this.mountedEntries.values()];
  }

  get(id: CapabilityId): CapabilityEntry | undefined {
    return this.entries.get(id) ?? this.mountedEntries.get(id);
  }

  getEntry(id: CapabilityId): CapabilityEntry | undefined {
    return this.get(id);
  }

  summaries(): CapabilitySummary[] {
    return this.all().map((e) => toSummary(this.stampPosture(e)));
  }

  revision(): number {
    return this.rev;
  }

  bumpRevision(): number {
    // Monotonic bump with NO entry-set diff (the exposure toggle hides/reveals an
    // existing entry; the registry's own entries are unchanged). The admin toggle
    // handler publishes `manifest_changed` with this revision — we do not fan out to
    // `subscribers` here to avoid double-emitting that event.
    this.rev += 1;
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
    // HEALTH: warm the per-source health cache in the BACKGROUND so the first
    // `.well-known`/manifest read carries a real snapshot rather than "unknown".
    // Fire-and-forget — never blocks boot (each probe is short + best-effort).
    for (const sourceId of new Set(this.all().map((e) => e.source))) {
      void this.health.refresh(sourceId).catch(() => {
        /* advisory — a failed warm-up probe never propagates */
      });
    }
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

    // CROSS-SOURCE SKILL ATTACH (must-fix #6): apply across the FULL aggregated set
    // so a skill can attach onto another source's capability — but ONLY when that
    // skill's source opted in (gated OFF by default; m4sec-auth flips it behind a
    // user-confirm). Same-source attach is always applied. The host entry carries
    // authoring-source provenance so a foreign skill stays distinguishable.
    applyCrossSourceAttach([...next.values()], {
      allowCrossSource: (skillSource: SourceId) =>
        this.crossSourceAllowed.get(skillSource) === true,
    });

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

  /**
   * Whether a registration is the TRUSTED in-process path: it supplies in-process
   * handlers (Obsidian) or is explicitly marked `trusted`. The wire
   * `POST /extensions` path supplies NEITHER and is therefore untrusted — subject to
   * first-party-id reservation.
   */
  private isTrusted(opts?: RegisterExtensionOptions): boolean {
    return opts?.trusted === true || !!(opts?.handlers && Object.keys(opts.handlers).length > 0);
  }

  /**
   * Run the full registration-time validation WITHOUT committing (the validate side
   * of the validate-vs-commit seam). Computes the candidate entry set (current
   * registry entries + this manifest's projected entries, cross-source attach gate
   * applied) and runs: manifest §8 rules, first-party-id reservation (untrusted
   * only), and the global transitive workflow anti-cycle / unresolved / cross-source
   * member walk. PURE: no mutation.
   */
  validateRegistration(
    manifest: ExtensionManifest,
    opts?: RegisterExtensionOptions,
  ): ValidateRegistrationResult {
    const reasons: string[] = [];

    // (a) manifest §8 shape/size/secret-ref rules.
    reasons.push(...validateManifest(manifest));

    // If the manifest is structurally broken, stop — id derivation isn't meaningful.
    if (manifest?.manifest !== "plexus-extension/0.1" || !manifest.source) {
      return { ok: false, reasons, crossSourceProvenance: {} };
    }

    // (b) first-party-id RESERVATION — untrusted (wire) registrations may not claim
    //     a reserved first-party source id (no impersonation).
    if (!this.isTrusted(opts) && RESERVED_SOURCE_IDS.has(manifest.source)) {
      reasons.push(
        `source "${manifest.source}" is a reserved first-party id; a runtime extension may not register under it (no first-party impersonation)`,
      );
    }

    // (c) build the candidate entry set the way a commit would (so the workflow walk
    //     sees existing entries + the new ones, and the cross-source attach gate is
    //     applied). Foreign existing entries for THIS source are replaced (re-register).
    const incoming = manifestEntries(manifest);
    // DEEP-CLONE so this validate pass NEVER mutates live registry entries
    // (`applyCrossSourceAttach` writes skills/extras onto host entries). Validation
    // must be pure — the real attach happens at refresh()-time on commit.
    const candidate: CapabilityEntry[] = JSON.parse(
      JSON.stringify([
        ...this.all().filter((e) => e.source !== manifest.source),
        ...incoming,
      ]),
    ) as CapabilityEntry[];
    const attachResult = applyCrossSourceAttach(candidate, {
      allowCrossSource: opts?.allowCrossSource === true,
    });
    for (const r of attachResult.rejected) {
      reasons.push(
        `skill ${r.skillId} attempts a CROSS-SOURCE attach onto ${r.hostId} (different source); cross-source attach is OFF by default (prompt-injection channel) — gate with allowCrossSource + user-confirm`,
      );
    }

    // (d) global transitive workflow validation (cycle / unresolved / cross-source).
    const wf = validateWorkflowGraph(candidate);
    reasons.push(...wf.reasons);

    return {
      ok: reasons.length === 0,
      reasons,
      crossSourceProvenance: wf.crossSourceProvenance,
    };
  }

  async registerExtension(
    manifest: ExtensionManifest,
    opts?: RegisterExtensionOptions,
  ): Promise<ExtensionRegisterResponse> {
    // VALIDATE BEFORE COMMIT. Default-deny: any reason ⇒ reject without materializing
    // or mutating the registry. This is the commit side of the validate-vs-commit
    // seam — m4sec-auth may insert a user-confirm between `validateRegistration` and
    // this commit, but the commit re-validates so nothing can slip past unconfirmed.
    const verdict = this.validateRegistration(manifest, opts);
    if (!verdict.ok) {
      return {
        ok: false,
        source: manifest?.source ?? "",
        registered: [],
        revision: this.rev,
        reason: verdict.reasons.join("; "),
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
    // Remember the gate so refresh()-time cross-source attach matches register-time.
    this.crossSourceAllowed.set(manifest.source, opts?.allowCrossSource === true);

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

  async unregister(sourceId: SourceId): Promise<CapabilityId[]> {
    // Only runtime-registered extensions are removable here; compile-time MODULES
    // are not (they are not in `extensionModules`).
    if (!this.extensionModules.has(sourceId)) return [];

    // Snapshot this source's ids BEFORE dropping it so we can report what was removed.
    const ownedIds = this.all()
      .filter((e) => e.source === sourceId)
      .map((e) => e.id);

    // Best-effort stop of the live source before dropping it.
    const live = this.liveSources.get(sourceId);
    if (live) {
      try {
        await live.stop();
      } catch {
        /* best-effort teardown */
      }
    }
    this.extensionModules.delete(sourceId);
    this.liveSources.delete(sourceId);
    this.crossSourceAllowed.delete(sourceId);
    this.health.forget(sourceId);

    // Re-scan: the dropped module no longer contributes entries; refresh() diffs the
    // removal, bumps the revision, and emits the list_changed to subscribers.
    await this.refresh();

    // Report the ids that are genuinely gone after the re-scan.
    return ownedIds.filter((id) => !this.entries.has(id));
  }

  // ── MESH primary-mount (T6, federated-mesh §3.2 / §7 Q4, Invariant F) ───────────

  mountRemoteWorkload(
    workload: WorkloadName,
    entries: CapabilityEntry[],
    opts: MeshMountOptions = {},
  ): MeshMountResult {
    const tenant = opts.tenant ?? DEFAULT_TENANT;
    const exposureDefault = opts.exposureDefault ?? "hidden";
    // Mounted caps route through the mesh transport, under a per-workload synthetic source
    // (mirrors the `mcp:<server>` convention) — the routing slug T7's bridge registers under.
    const source: SourceId = `mesh:${workload}`;

    const mounted: CapabilityAddress[] = [];
    for (const entry of entries) {
      const bareId = entry.id;
      // PREFIX APPLIED EXACTLY ONCE — `mountAddress` throws on a non-bare id, so a
      // double-mount can never produce `tenant/workload/tenant/workload/…`.
      const address = mountAddress(tenant, workload, bareId);
      // TRUST-BOUNDARY DEFENSE (P6-MOUNT-PROV): a remote-pushed entry is UNTRUSTED input from a
      // proxy over the tunnel. The gateway-stamped trust posture (`provenance` / `sensitivity` /
      // `recommendedTrustWindow`) and the `health` snapshot are LOCALLY-DERIVED facts — never
      // fields a remote may assert about itself. Strip any the proxy stamped so they are ALWAYS
      // re-derived HERE by the primary: `stampPosture` re-derives provenance from the
      // `mesh:<workload>` source (→ "extension", the strictest class, so a mounted remote read
      // PENDS and never auto-allows) + the correct sensitivity, and `resolvedHealth` routes the
      // health through the mesh-health provider (carrying the `reported` self-assertion marker).
      // Without this, a malicious proxy pushing `provenance:"first-party"` (or a low `sensitivity`,
      // or an `ok` `health`) would spoof the authorizer/console — the boundary must not depend on
      // remote entries being honest.
      const { provenance: _p, sensitivity: _s, recommendedTrustWindow: _w, health: _h, ...bare } =
        entry;
      // Re-address the entry: its id BECOMES the address (the grant/audit/invocation key,
      // Invariant B). The bare tail survives inside the address; the forward index holds the
      // clean `{ workload, bareId }` for translation back at the boundary (never recomputed
      // by string-splitting at the seam — the mount is the single source of truth).
      const reAddressed: CapabilityEntry = { ...bare, id: address, source, transport: "mesh" };
      this.mountedEntries.set(address, reAddressed);
      this.mountedRoutes.set(address, { workload, bareId });
      this.mountedExposure.set(address, exposureDefault);
      mounted.push(address);
    }

    // WITHDRAW: un-mount any addresses for this workload's withdrawn bare ids.
    const withdrawn: CapabilityAddress[] = [];
    for (const bareId of opts.withdrawn ?? []) {
      const address = mountAddress(tenant, workload, bareId);
      if (this.mountedEntries.delete(address)) {
        this.mountedRoutes.delete(address);
        this.mountedExposure.delete(address);
        withdrawn.push(address);
      }
    }

    if (mounted.length || withdrawn.length) {
      this.rev += 1;
      const evt: EntrySetChange = {
        revision: this.rev,
        added: mounted,
        removed: withdrawn,
        updated: [],
      };
      for (const cb of this.subscribers) cb(evt);
    }
    return { mounted, withdrawn, revision: this.rev };
  }

  forwardAddress(address: CapabilityAddress): MeshForwardTarget | undefined {
    return this.mountedRoutes.get(address);
  }

  unmountWorkload(workload: WorkloadName): CapabilityAddress[] {
    // The forward index is the authoritative `address → { workload, bareId }` map, so it is
    // the one place to find EVERY address mounted from this workload (entries/exposure are
    // kept perfectly in lockstep with it by `mountRemoteWorkload`).
    const removed: CapabilityAddress[] = [];
    for (const [address, target] of [...this.mountedRoutes.entries()]) {
      if (target.workload !== workload) continue;
      this.mountedEntries.delete(address);
      this.mountedRoutes.delete(address);
      this.mountedExposure.delete(address);
      removed.push(address);
    }
    if (removed.length) {
      this.rev += 1;
      const evt: EntrySetChange = { revision: this.rev, added: [], removed, updated: [] };
      for (const cb of this.subscribers) cb(evt);
    }
    return removed;
  }

  exposureDefaultFor(id: CapabilityId): MeshExposureDefault | undefined {
    return this.mountedExposure.get(id);
  }
}

/** Build the (empty until scanned) capability registry over a source registry. */
export function createCapabilityRegistry(sources: SourceRegistry): CapabilityRegistry {
  return new InMemoryCapabilityRegistry(sources);
}
