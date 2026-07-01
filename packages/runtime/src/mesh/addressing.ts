/**
 * Capability ADDRESS grammar — the pure prefix/translate seam for the primary mount
 * (federated-mesh §1 / §3.2 CapabilityAddress, Invariant B address⟂route, Invariant F
 * mount/ascent-rewrite; §7 Q4 primary-mount; phase-1 plan seam (d) + risk #5).
 *
 * This module is the ONE place the address grammar is constructed and inverted. It is
 * pure (no I/O, no state) so the "exactly one prefix/translate per hop" rule (risk #5)
 * is a property of a single, testable function pair:
 *
 *   GRAMMAR:  tenant / <workload-path…> / source.capability
 *     - `/` separates LOCATION segments (tenant, then the variable-depth workload path);
 *     - `.` separates the `source.capability` TAIL — today's bare `CapabilityId`.
 *
 * A proxy advertises BARE `source.capability` ids and is workload-agnostic on the wire;
 * the PRIMARY mounts (PREPENDS `tenant/workload/` → a full `CapabilityAddress`) on ascent,
 * and TRANSLATES BACK to the bare id at the forward boundary (T7). Because a bare id never
 * contains `/` (its segments are `.`-joined), the location prefix and the bare tail are
 * cleanly separable: the tail is everything after the LAST `/`.
 *
 * Address is IDENTITY (grants + audit bind to it); route is LOCATION (Invariant B). Mount
 * applies the prefix once on the way up; forward strips it once on the way down. Neither
 * the proxy nor any code below this seam ever sees or constructs the prefix.
 */

import type { CapabilityAddress, CapabilityId, TenantId, WorkloadName } from "@plexus/protocol";

/** The implicit personal tenant — the top address segment when none is configured (§7 Q5). */
export const DEFAULT_TENANT: TenantId = "local";

/** The location-segment separator (tenant + workload path). `.` stays the source.capability tail. */
const LOCATION_SEP = "/";

/**
 * A bare `source.capability` id is the address TAIL: it must not already carry a `/`
 * location prefix (that would mean it was mounted twice — the double-prefix bug risk #5
 * guards against). The grammar reserves `/` for location segments only.
 */
export function isBareCapabilityId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && !id.includes(LOCATION_SEP);
}

/** Whether a string is a MOUNTED address (carries at least one `/` location segment). */
export function isMountedAddress(value: string): boolean {
  return typeof value === "string" && value.includes(LOCATION_SEP);
}

/**
 * MOUNT (ascent-rewrite, Invariant F): prepend `tenant/workload/` onto a bare local id
 * to form the full `CapabilityAddress`. The single point where the location prefix is
 * applied. Throws if `bareId` is not bare (already prefixed) — fail-closed so a
 * double-mount can never silently produce `tenant/workload/tenant/workload/…`.
 */
export function mountAddress(
  tenant: TenantId,
  workload: WorkloadName,
  bareId: CapabilityId,
): CapabilityAddress {
  if (!isBareCapabilityId(bareId)) {
    throw new Error(`mesh/addressing: cannot mount a non-bare id (already prefixed?): "${bareId}"`);
  }
  if (!workload || workload.includes(LOCATION_SEP)) {
    throw new Error(`mesh/addressing: invalid workload segment: "${workload}"`);
  }
  if (!tenant || tenant.includes(LOCATION_SEP)) {
    throw new Error(`mesh/addressing: invalid tenant segment: "${tenant}"`);
  }
  return `${tenant}${LOCATION_SEP}${workload}${LOCATION_SEP}${bareId}`;
}

/**
 * FORWARD TRANSLATE (the inverse of `mountAddress`): recover the BARE `source.capability`
 * id from a full address by taking everything after the LAST `/`. This is what the forward
 * boundary (T7) sends down the tunnel so the proxy stays workload-agnostic in execution.
 *
 * Round-trip law: `forwardTranslate(mountAddress(t, w, bare)) === bare` for every bare id.
 * A value with no `/` is already bare and is returned unchanged (idempotent — a defensive
 * no-op if a caller passes a bare id by mistake).
 */
export function forwardTranslate(address: CapabilityAddress): CapabilityId {
  const lastSep = address.lastIndexOf(LOCATION_SEP);
  return lastSep === -1 ? address : address.slice(lastSep + 1);
}

/** The parsed shape of an address — its location coordinates + the bare tail. */
export interface ParsedAddress {
  tenant: TenantId;
  /** The variable-depth workload path (one segment in the v1 convention). */
  workloadPath: WorkloadName[];
  /** The bare `source.capability` id the owning gateway executes. */
  bareId: CapabilityId;
}

/**
 * Parse a full address into `{ tenant, workloadPath, bareId }`. Returns `undefined` for a
 * value with no location prefix (a bare id is not an address). Variable-depth tolerant:
 * the FIRST segment is the tenant, the LAST is the bare tail, the middle is the workload path.
 */
export function parseAddress(address: CapabilityAddress): ParsedAddress | undefined {
  if (!isMountedAddress(address)) return undefined;
  const segments = address.split(LOCATION_SEP);
  if (segments.length < 3) return undefined; // need at least tenant / workload / bareId
  const tenant = segments[0]!;
  const bareId = segments[segments.length - 1]!;
  const workloadPath = segments.slice(1, -1);
  if (!tenant || !bareId || workloadPath.length === 0) return undefined;
  return { tenant, workloadPath, bareId };
}
