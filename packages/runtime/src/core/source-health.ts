/**
 * Per-source HEALTH cache + probe service (HEALTH).
 *
 * A SOURCE reports health; each of its capabilities INHERITS that one value
 * (per-source granularity). This module owns the short-TTL, stale-while-revalidate
 * cache the capability registry stamps from when it serializes summaries/entries,
 * and the admin `GET /admin/api/health` reads.
 *
 * DESIGN (cheap + non-blocking):
 *  - `cached(sourceId)` is SYNCHRONOUS — it returns the last cached snapshot (or
 *    `{status:"unknown"}` if never probed) and, when the entry is stale/missing,
 *    kicks off a BACKGROUND probe (fire-and-forget). Discovery/handshake/invoke
 *    therefore NEVER block on a slow health probe (stale-while-revalidate): the
 *    first-ever read is "unknown" until the first probe resolves a tick later.
 *  - A probe is DEDUPED per source (one in-flight probe at a time) and the result
 *    is stamped with `checkedAt`.
 *  - DERIVE-FROM-checkRequirements is the default: a source that implements
 *    `health()` is asked directly; otherwise we map `checkRequirements()`
 *    ok→"ok", not-ok→"unavailable" (reason as detail). A source with neither a
 *    meaningful `health()` nor `checkRequirements()` reads "unknown".
 *
 * The cache is keyed by SourceId and resolves the LIVE source object on demand via
 * an injected resolver (the registry hands it `ensureSource`), so the cache never
 * holds source references itself.
 */

import type {
  CapabilityHealth,
  CapabilitySource,
  HealthStatus,
  SourceHealth,
  SourceId,
} from "@plexus/protocol";

/** A cached snapshot + its freshness stamp (epoch ms). */
interface CacheEntry {
  health: CapabilityHealth;
  /** Epoch ms the snapshot was probed (mirrors `health.checkedAt`). */
  at: number;
}

/** Default short TTL — a probe older than this triggers a background refresh. */
export const DEFAULT_HEALTH_TTL_MS = 10_000;

/** The "never probed yet" snapshot (the first-ever read before a probe resolves). */
const UNKNOWN: CapabilityHealth = { status: "unknown" };

/**
 * Derive a `SourceHealth` from a live source: prefer its `health()`; otherwise map
 * `checkRequirements()` (ok→"ok", not-ok→"unavailable"); a source with neither ⇒
 * "unknown". Defensive: a probe that THROWS is reported "unknown" (never crashes
 * the caller — health is advisory).
 */
export async function probeSourceHealth(source: CapabilitySource): Promise<SourceHealth> {
  try {
    if (typeof source.health === "function") {
      return await source.health();
    }
    if (typeof source.checkRequirements === "function") {
      const req = await source.checkRequirements();
      return req.ok
        ? { status: "ok" }
        : { status: "unavailable", ...(req.reason ? { detail: req.reason } : {}) };
    }
    return { status: "unknown" };
  } catch (e) {
    return { status: "unknown", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** A `SourceHealth` → wire `CapabilityHealth` (stamping `checkedAt`). */
function stamp(h: SourceHealth, atIso: string): CapabilityHealth {
  return { status: h.status, ...(h.detail ? { detail: h.detail } : {}), checkedAt: atIso };
}

export interface SourceHealthCache {
  /**
   * SYNCHRONOUS read of a source's cached health (stale-while-revalidate). Returns
   * the last snapshot (or "unknown" if never probed) and kicks off a background
   * refresh when the entry is missing/stale. Never blocks.
   */
  cached(sourceId: SourceId): CapabilityHealth;
  /**
   * Probe a source NOW and update the cache (awaitable — used by the admin
   * `GET /admin/api/health` so the first admin read is accurate, and by tests).
   * Returns the freshly-cached snapshot. Deduped: a concurrent probe is shared.
   */
  refresh(sourceId: SourceId): Promise<CapabilityHealth>;
  /** Drop a source's cached health (e.g. on unregister). */
  forget(sourceId: SourceId): void;
}

/**
 * Build the cache over a live-source resolver. `resolve(id)` returns the live
 * `CapabilitySource` for an id (the registry's `ensureSource`), or `undefined`
 * when the source isn't live — in which case health reads "unavailable" (the
 * source isn't running, so a call would fail).
 */
export function createSourceHealthCache(
  resolve: (sourceId: SourceId) => CapabilitySource | undefined,
  opts?: { ttlMs?: number; now?: () => number },
): SourceHealthCache {
  const ttlMs = opts?.ttlMs ?? DEFAULT_HEALTH_TTL_MS;
  const now = opts?.now ?? Date.now;
  const cache = new Map<SourceId, CacheEntry>();
  const inflight = new Map<SourceId, Promise<CapabilityHealth>>();

  async function doProbe(sourceId: SourceId): Promise<CapabilityHealth> {
    const source = resolve(sourceId);
    const at = now();
    const atIso = new Date(at).toISOString();
    let health: CapabilityHealth;
    if (!source) {
      // No live source for this id ⇒ it isn't running; a call would fail.
      health = stamp({ status: "unavailable" as HealthStatus, detail: "source not live" }, atIso);
    } else {
      health = stamp(await probeSourceHealth(source), atIso);
    }
    cache.set(sourceId, { health, at });
    return health;
  }

  function refresh(sourceId: SourceId): Promise<CapabilityHealth> {
    const existing = inflight.get(sourceId);
    if (existing) return existing;
    const p = doProbe(sourceId).finally(() => inflight.delete(sourceId));
    inflight.set(sourceId, p);
    return p;
  }

  function cached(sourceId: SourceId): CapabilityHealth {
    const entry = cache.get(sourceId);
    const fresh = entry !== undefined && now() - entry.at < ttlMs;
    if (!fresh) {
      // Stale-while-revalidate: refresh in the BACKGROUND, serve the last value.
      void refresh(sourceId).catch(() => {
        /* advisory — a failed probe never propagates */
      });
    }
    return entry?.health ?? UNKNOWN;
  }

  function forget(sourceId: SourceId): void {
    cache.delete(sourceId);
  }

  return { cached, refresh, forget };
}
