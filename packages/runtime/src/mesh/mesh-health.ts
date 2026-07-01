/**
 * MeshHealthStore — the primary's per-workload REPORTED-health store (mesh-health-reporting.md
 * §4/§5). Sibling of the `ResolutionTable`: where the ResolutionTable owns the coarse ROUTE fact
 * (is the workload's socket promoted?), this store owns the FINE fact (what did the workload most
 * recently report about its own sources?). The mounted-cap health the admin / `.well-known`
 * surfaces resolves from BOTH, route-first.
 *
 * ANTI-FORGERY: `record(workload, payload)` is keyed by the workload the tunnel bound to the
 * AUTHENTICATED socket the frame arrived on — `payload.reporter` is advisory and ignored (the
 * same discipline as catalog mounting under `authenticatedWorkload`). A proxy cannot report for
 * another workload.
 *
 * INVARIANTS. The store never mutates an address or a grant (Invariant B — it only changes the
 * resolved health VALUE). A dropped socket resolves `unavailable` regardless of the last report
 * (Invariant E — the forward boundary still returns typed `capability_unavailable`; the store
 * never round-trips to probe a remote cap). The last report is KEPT across a transient
 * disconnect, so recovery is a fresh report away (Invariant B / Risk-1 — the mount survives).
 */

import type {
  CapabilityHealth,
  HealthFramePayload,
  HealthReportSource,
  IsoTimestamp,
  WorkloadName,
} from "@plexus/protocol";

import type { ResolutionView } from "./resolution.ts";

/** How many missed reporting intervals before a still-connected workload's report is `stale`. */
export const DEFAULT_STALE_INTERVALS = 3;
/** Fallback stale window when no negotiated interval is known for a workload (ms). */
const DEFAULT_STALE_MS = 45_000;

/**
 * The RICH mesh-health state (finer than the frozen 4-state `HealthStatus`). The wire status
 * stays 4-state; `stale`/`connecting`/`down` distinctions ride here + in `detail` for display.
 *  - `unavailable` — the tunnel ROUTE is down (ResolutionTable) — Invariant E. Wins over any report.
 *  - `connecting`  — tunnel up (or coming up) but NO report received yet.
 *  - `stale`       — tunnel up but the last report is older than N intervals.
 *  - `down`        — tunnel up, fresh report says the remote sources are down.
 *  - `degraded`    — tunnel up, fresh report says impaired.
 *  - `ok`          — tunnel up, fresh report says healthy.
 */
export type MeshHealthState = "ok" | "degraded" | "down" | "stale" | "connecting" | "unavailable";

/** The resolved per-workload mesh-health reading (admin / diagnostics). */
export interface MeshWorkloadHealth {
  state: MeshHealthState;
  /** The last report's aggregate, if any report has been received. */
  overall?: HealthFramePayload["overall"];
  /** The last report's per-source rows (admin detail). */
  sources?: HealthReportSource[];
  /** The last accepted report's sequence number. */
  seq?: number;
  /** When the reporter built the last report (`payload.ts`). */
  reportedAt?: IsoTimestamp;
  /** When the primary received the last report (server clock). */
  receivedAt?: IsoTimestamp;
  /** Present with `state:"unavailable"` — when the route first went down (Invariant E). */
  unavailableSince?: IsoTimestamp;
  /** Human-readable reason for the current state (for admin/tooltips). */
  detail?: string;
}

/** One workload's stored report + timing. */
interface StoredReport {
  overall: HealthFramePayload["overall"];
  sources: HealthReportSource[];
  seq: number;
  /**
   * The CONNECTION EPOCH this report was accepted under. The seq gate only orders reports WITHIN
   * one epoch; a report on a newer epoch (a reconnect) always passes (see `record`). This is what
   * keeps a restarted proxy — whose in-memory `healthSeq` resets to 0/1 — from being wedged
   * forever behind a high pre-restart seq (mesh-health-reporting.md §5 / Invariant B).
   */
  epoch: number;
  reportedAt: IsoTimestamp;
  receivedAtMs: number;
  /** The negotiated reporting interval (ms) for staleness math; undefined ⇒ default window. */
  intervalMs?: number;
}

export class MeshHealthStore {
  private readonly byWorkload = new Map<WorkloadName, StoredReport>();
  /** Negotiated reporting interval per workload (set on connect; drives the stale window). */
  private readonly intervalByWorkload = new Map<WorkloadName, number>();
  /**
   * Monotonic per-workload CONNECTION EPOCH, bumped on every (re)connect via `beginConnection`.
   * The seq gate in `record` is scoped to the current epoch, so a fresh connection's reports
   * (seq restarted at 1 after a proxy process restart) are accepted even though the last stored
   * seq is higher. The last health VALUE survives across the drop (Invariant B) — only the ORDER
   * gate resets.
   */
  private readonly epochByWorkload = new Map<WorkloadName, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Note the negotiated reporting interval for a workload (from the handshake, on connect). */
  noteInterval(workload: WorkloadName | undefined, intervalMs: number | undefined): void {
    if (!workload) return;
    if (intervalMs && intervalMs > 0) this.intervalByWorkload.set(workload, intervalMs);
  }

  /**
   * Open a fresh CONNECTION EPOCH for a workload on (re)connect (called from `onProxyConnected`).
   * Bumps the epoch so the NEXT report — even one whose seq is LOWER than the last stored seq (a
   * restarted proxy restarts its seq at 1) — is accepted rather than dropped as out-of-order. The
   * last stored report (value + rows) is DELIBERATELY retained (Invariant B / Risk-1): a transient
   * drop keeps the last health, and the seq gate reset lets the genuine reconnect recover
   * connecting→ok. Idempotent-safe to call on every promotion.
   */
  beginConnection(workload: WorkloadName | undefined): void {
    if (!workload) return;
    this.epochByWorkload.set(workload, (this.epochByWorkload.get(workload) ?? 0) + 1);
  }

  /** Forget a workload entirely (e.g. on revoke/unmount). */
  forget(workload: WorkloadName | undefined): void {
    if (!workload) return;
    this.byWorkload.delete(workload);
    this.intervalByWorkload.delete(workload);
    this.epochByWorkload.delete(workload);
  }

  /**
   * Record a report ATTRIBUTED to the authenticated `workload` (never `payload.reporter`). Drops
   * an out-of-order (stale-seq) report so a delayed frame can't overwrite a newer one — but ONLY
   * within the SAME connection epoch: a report on a newer epoch (post-reconnect) always passes, so
   * a restarted proxy's seq-reset can't wedge recovery. Returns `true` when the report was accepted
   * (stored), `false` when dropped as out-of-order.
   */
  record(workload: WorkloadName | undefined, payload: HealthFramePayload): boolean {
    if (!workload) return false;
    const epoch = this.epochByWorkload.get(workload) ?? 0;
    const prev = this.byWorkload.get(workload);
    // Same-epoch out-of-order / duplicate ⇒ drop (keep the newer). A newer epoch bypasses the gate.
    if (prev && prev.epoch === epoch && payload.seq <= prev.seq) return false;
    this.byWorkload.set(workload, {
      overall: payload.overall,
      sources: payload.sources,
      seq: payload.seq,
      epoch,
      reportedAt: payload.ts,
      receivedAtMs: this.now(),
      ...(this.intervalByWorkload.has(workload) ? { intervalMs: this.intervalByWorkload.get(workload) } : {}),
    });
    return true;
  }

  /** The last accepted report for a workload, if any (diagnostics). */
  lastReport(workload: WorkloadName): StoredReport | undefined {
    return this.byWorkload.get(workload);
  }

  /**
   * Resolve a workload's mesh-health, ROUTE-FIRST (mesh-health-reporting.md §5). `resolution` is
   * the primary's coarse socket up/down view; this store adds the fine reported detail.
   */
  stateFor(workload: WorkloadName, resolution: ResolutionView): MeshWorkloadHealth {
    // 1 — ROUTE wins: a down socket is `unavailable` no matter what the last report said
    // (Invariant E — the forward boundary returns typed capability_unavailable).
    const route = resolution.healthOf(workload);
    const report = this.byWorkload.get(workload);
    const base: MeshWorkloadHealth = report
      ? {
          state: "ok",
          overall: report.overall,
          sources: report.sources,
          seq: report.seq,
          reportedAt: report.reportedAt,
          receivedAt: new Date(report.receivedAtMs).toISOString(),
        }
      : { state: "ok" };

    if (route.status === "unavailable") {
      return {
        ...base,
        state: "unavailable",
        ...(route.unavailableSince ? { unavailableSince: route.unavailableSince } : {}),
        detail: "proxy tunnel down",
      };
    }

    // 2 — tunnel up but no report yet ⇒ connecting.
    if (!report) return { state: "connecting", detail: "awaiting first health report" };

    // 3 — tunnel up but the last report is older than N intervals ⇒ stale.
    const interval = report.intervalMs ?? this.intervalByWorkload.get(workload);
    const staleMs = interval ? interval * DEFAULT_STALE_INTERVALS : DEFAULT_STALE_MS;
    if (this.now() - report.receivedAtMs > staleMs) {
      return { ...base, state: "stale", detail: "health report stale" };
    }

    // 4-6 — fresh report ⇒ map its aggregate.
    if (report.overall === "down") return { ...base, state: "down", detail: "remote sources down" };
    if (report.overall === "degraded") return { ...base, state: "degraded", detail: "remote sources degraded" };
    return { ...base, state: "ok" };
  }
}

/**
 * Map a resolved mesh-health reading to a wire `CapabilityHealth` (the frozen 4-state stamped
 * onto the `mesh:<workload>` bridge source + every cap that inherits it). The finer `stale`/
 * `connecting`/`down` distinctions collapse into `status` + `detail`:
 *  - ok         → ok
 *  - degraded   → degraded
 *  - down       → unavailable (a call will likely fail — reconciles with `capability_unavailable`)
 *  - stale      → degraded (impaired: we can't vouch for freshness)
 *  - connecting → unknown (not yet probed; detail says "connecting")
 *  - unavailable→ unavailable (+ unavailableSince — Invariant E)
 *
 * PROVENANCE MARKER (P6-HEALTH-PROV): EVERY value this function emits is tagged `reported:true`.
 * A mesh cap's health is the remote home's UNVERIFIED SELF-ASSERTION relayed over the tunnel —
 * never something the primary gateway probed. The marker rides on the wire `CapabilityHealth` so a
 * consumer can tell "remote says ok" (`reported:true`) from a locally-PROBED "gateway proved ok"
 * (marker absent). It stays ADVISORY: health gates nothing (route/ResolutionTable gates invoke).
 * Even the `unavailable` route-down states carry it — the whole reading is the mesh path's, whose
 * fine detail is reported (the coarse route fact aside).
 */
export function meshHealthToCapabilityHealth(h: MeshWorkloadHealth): CapabilityHealth {
  const checkedAt = h.receivedAt ?? h.unavailableSince;
  // Stamped on every branch: a mesh-sourced health value is always a remote self-assertion.
  const reported = { reported: true } as const;
  switch (h.state) {
    case "ok":
      return { status: "ok", ...(checkedAt ? { checkedAt } : {}), ...reported };
    case "degraded":
      return { status: "degraded", ...(h.detail ? { detail: h.detail } : {}), ...(checkedAt ? { checkedAt } : {}), ...reported };
    case "stale":
      return { status: "degraded", detail: h.detail ?? "health report stale", ...(checkedAt ? { checkedAt } : {}), ...reported };
    case "down":
      return { status: "unavailable", detail: h.detail ?? "remote sources down", ...(checkedAt ? { checkedAt } : {}), ...reported };
    case "connecting":
      return { status: "unknown", detail: h.detail ?? "connecting — awaiting first health report", ...reported };
    case "unavailable":
      return {
        status: "unavailable",
        detail: h.detail ?? "proxy tunnel down",
        ...(h.unavailableSince ? { checkedAt: h.unavailableSince } : {}),
        ...reported,
      };
  }
}
