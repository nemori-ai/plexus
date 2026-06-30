/**
 * Catalog push + primary mount glue (federated-mesh §3.2 CapabilityDirectory, §7 Q3/Q4,
 * Invariant F; phase-1 plan seam (d) / T6).
 *
 * TWO ENDS, ONE FRAME (`catalog`, T1):
 *
 *   PROXY (`buildCatalogPush`) — after enrollment, advertises its LOCAL capabilities with
 *     BARE `source.capability` ids. The proxy is WORKLOAD-AGNOSTIC ON THE WIRE: it never
 *     prefixes its own mesh name onto an id (so it stays renamable/relocatable without
 *     redeploy, §7 Q4). The `workload` field is the enrollment CLAIM the primary maps to a
 *     prefix per its enrollment record — NOT a name baked into the capability ids.
 *
 *   PRIMARY (`applyCatalog`) — MOUNTS the pushed entries via
 *     `CapabilityRegistry.mountRemoteWorkload`: prepends `tenant/workload/` → full
 *     `CapabilityAddress` (Invariant F), marks them `transport:"mesh"`, defaults them
 *     ZERO-EXPOSURE / hidden (§7 Q3 — join ≠ access), and bumps the revision. The inverse
 *     translate (address → bare id) used at the forward boundary is `registry.forwardAddress`
 *     (T7) — ALL prefix handling stays at this mount/forward seam, never inside the proxy.
 *
 * This module owns NO address grammar of its own — it delegates to `mesh/addressing.ts`
 * (the one place the prefix is applied) and to the registry (the one place mounts live).
 */

import type { CapabilityAddress, CapabilityEntry, CapabilityId, TenantId, WorkloadName } from "@plexus/protocol";

import type { CapabilityRegistry } from "../core/capability-registry.ts";
import { isBareCapabilityId } from "./addressing.ts";
import type { CatalogFrame } from "@plexus/protocol";
import { newCorr } from "./frames.ts";

/** Posture a mounted workload's caps enter the directory in — `"hidden"` is the only v1 value (§7 Q3). */
export type MeshExposureDefault = "hidden";

/**
 * PROXY: build the `catalog` frame advertising `entries` for the claimed `workload`.
 *
 * The entries MUST carry BARE ids (their own `source.capability` tail, no `/` location
 * prefix). We assert that here — fail-closed — so a proxy can never accidentally leak a
 * pre-prefixed address onto the wire (the prefix is exclusively the primary's act, Q4).
 */
export function buildCatalogPush(
  workload: WorkloadName,
  entries: CapabilityEntry[],
  opts: { revision?: number; withdrawn?: CapabilityId[]; corr?: string } = {},
): CatalogFrame {
  for (const entry of entries) {
    if (!isBareCapabilityId(entry.id)) {
      throw new Error(
        `mesh/catalog: proxy may only push BARE ids; "${entry.id}" carries a location prefix (the primary mounts, not the proxy — §7 Q4)`,
      );
    }
  }
  return {
    t: "catalog",
    corr: opts.corr ?? newCorr(),
    payload: {
      workload,
      entries,
      ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
      ...(opts.withdrawn && opts.withdrawn.length ? { withdrawn: opts.withdrawn } : {}),
    },
  };
}

/** Outcome of mounting a catalog push at the primary. */
export interface CatalogMountResult {
  /** The full addresses now mounted (prefix applied). */
  mounted: CapabilityAddress[];
  /** Addresses withdrawn (un-mounted) by this push, if any. */
  withdrawn: CapabilityAddress[];
  /** The registry revision after the mount (monotonic). */
  revision: number;
}

/**
 * PRIMARY: apply a pushed `catalog` payload by MOUNTING its entries under `workload`.
 * `tenant` defaults to the implicit personal tenant; `exposureDefault` defaults to the
 * zero-exposure marker (§7 Q3) — callers wire it from the enrollment record's
 * `exposureDefaultFor(workload)`. Returns the mounted/withdrawn addresses + new revision.
 */
export function applyCatalog(
  registry: CapabilityRegistry,
  payload: { workload: WorkloadName; entries: CapabilityEntry[]; withdrawn?: CapabilityId[] },
  opts: { tenant?: TenantId; exposureDefault?: MeshExposureDefault } = {},
): CatalogMountResult {
  return registry.mountRemoteWorkload(payload.workload, payload.entries, {
    ...(opts.tenant !== undefined ? { tenant: opts.tenant } : {}),
    ...(opts.exposureDefault !== undefined ? { exposureDefault: opts.exposureDefault } : {}),
    ...(payload.withdrawn && payload.withdrawn.length ? { withdrawn: payload.withdrawn } : {}),
  });
}
