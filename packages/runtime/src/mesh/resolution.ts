/**
 * ResolutionTable — the primary's health-aware `Address → Route` mapping
 * (federated-mesh §3.1 Topology aggregate, §3.4 Invocation, §5 Invariant B/E;
 * phase-1 plan seam (f) / T10).
 *
 * A capability has EXACTLY ONE home — its workload, reached over that workload's
 * single dialed tunnel (§7 Q1; **no replica/failover**). The ResolutionTable is the
 * primary's view of whether that home is currently reachable: a workload's mounted
 * caps are AVAILABLE while its authenticated socket is promoted, and UNAVAILABLE
 * (stamped with `unavailableSince`) the moment that socket drops / closes / times out.
 *
 * INVARIANT B (address ⟂ route): health is a property of the ROUTE, never the address
 * or the grant. A workload going down changes what `resolve()` reports — it NEVER
 * mutates a mounted address or a grant bound to it. When the proxy re-enrolls and the
 * socket is promoted again, the SAME addresses resolve healthy once more (grants
 * survive; no re-grant).
 *
 * INVARIANT E (never a hang): "unavailable" is an ACCURATE, typed signal the
 * invocation path turns into `capability_unavailable` + `unavailableSince` — surfaced
 * UP FRONT (the health gate) and at the forward boundary — so the agent learns the home
 * is down (and for how long) instead of waiting on a request that can never be answered.
 *
 * Keyed by WORKLOAD (the home identity): one workload = one proxy = one socket = one
 * home. Every address mounted from that workload inherits its single health value
 * (per-workload granularity, mirroring the per-source health model).
 */

import type { HealthStatus, IsoTimestamp, WorkloadName } from "@plexus/protocol";

/**
 * Resolution health for a workload's mounted caps. `status`:
 *  - `"ok"`          — the workload's authenticated socket is promoted (reachable now).
 *  - `"unavailable"` — its home is down; `unavailableSince` stamps WHEN it first went down.
 *  - `"unknown"`     — never observed (no socket has ever connected for this workload).
 */
export interface MountHealth {
  status: HealthStatus;
  /** Present with `status:"unavailable"` — when the home first went unreachable (Invariant E). */
  unavailableSince?: IsoTimestamp;
}

/** The "never observed" reading — a workload the table has seen no socket for. */
const UNKNOWN: MountHealth = { status: "unknown" };

/** Read-only resolution view consumed by the health gate + the forward boundary. */
export interface ResolutionView {
  /** Resolution health for a workload's mounted caps. Unseen workload ⇒ `{status:"unknown"}`. */
  healthOf(workload: WorkloadName): MountHealth;
}

/** One workload's mutable resolution state. */
interface Entry {
  status: HealthStatus;
  unavailableSince?: IsoTimestamp;
}

/**
 * The primary's health-aware resolution table (T10). The `MeshServer` drives it:
 * `markAvailable` on authenticated-socket promotion (the "connect" signal), and
 * `markUnavailable` on disconnect / close / ping-timeout (the "down" signal). Reads
 * are synchronous + never block the data plane.
 */
export class ResolutionTable implements ResolutionView {
  private readonly byWorkload = new Map<WorkloadName, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A workload's home is reachable (its authenticated socket was promoted). Clears any
   * prior `unavailableSince` — health changes the resolution, not the address (Invariant B).
   */
  markAvailable(workload: WorkloadName | undefined): void {
    if (!workload) return;
    this.byWorkload.set(workload, { status: "ok" });
  }

  /**
   * A workload's home went down (socket dropped / closed / ping-timeout). Stamps
   * `unavailableSince` ONCE — a repeated down signal (e.g. close after a fail) keeps the
   * ORIGINAL timestamp so "how long down" stays accurate across redundant events.
   */
  markUnavailable(workload: WorkloadName | undefined): void {
    if (!workload) return;
    const prev = this.byWorkload.get(workload);
    if (prev?.status === "unavailable") return; // already down — keep the original stamp.
    this.byWorkload.set(workload, {
      status: "unavailable",
      unavailableSince: new Date(this.now()).toISOString(),
    });
  }

  healthOf(workload: WorkloadName): MountHealth {
    const e = this.byWorkload.get(workload);
    if (!e) return UNKNOWN;
    return e.status === "unavailable"
      ? { status: "unavailable", ...(e.unavailableSince ? { unavailableSince: e.unavailableSince } : {}) }
      : { status: e.status };
  }
}
