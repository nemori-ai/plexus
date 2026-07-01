/**
 * `mesh` transport — the DATA-PLANE FORWARD for a capability MOUNTED from a remote
 * proxy workload (federated-mesh §3.4 Invocation/InvocationRouter, §7 Q1 primary
 * passthrough + Q4 bare-id-on-the-wire, Invariant B; phase-1 plan seam (d) / T7).
 *
 * In the proxy/passthrough model the agent talks ONLY to the primary; the primary
 * forwards an ALREADY-AUTHORIZED invoke DOWN the persistent reverse tunnel the proxy
 * dialed out on (§7 Q1). This transport is the primary-side end of that forward:
 *
 *   1. TRANSLATE the mounted address back to its BARE `source.capability` id via the
 *      registry's `forwardAddress` (the authoritative inverse of the mount prefix —
 *      Invariant B / Q4: the BARE id travels on the wire, never the location prefix).
 *   2. PIN the enrolled destination: forward ONLY to the proxy bound at enrollment.
 *      An un-enrolled / other target is REFUSED here (no SSRF via a mutable route).
 *   3. FORWARD an `invoke` frame down that proxy's tunnel and AWAIT the matching
 *      `invoke-result` (correlated by `corr`), then normalize it back to a
 *      `TransportResult` the bridge folds into the agent's `InvokeResponse`.
 *
 * The address→bare translation + the tunnel itself live BEHIND injected seams
 * (`configure`): `resolveTarget` is `CapabilityRegistry.forwardAddress`, and the
 * `MeshInvokeForwarder` is implemented by the primary `MeshRuntime`. Keeping all
 * prefix handling at the mount/forward seam (never inside the proxy) is Invariant B.
 *
 * Until `configure()` is called (e.g. a `proxy`-mode gateway, or a primary with no
 * tunnel wired) `dispatch` returns a clean typed `capability_unavailable` (Invariant
 * E vocabulary) rather than throwing, so the transport map stays TOTAL and an early
 * invoke fails as a normal `InvokeResponse` instead of a 500 — never a hang.
 */

import type {
  Transport,
  CapabilityEntry,
  CapabilityAddress,
  CapabilityId,
  WorkloadName,
  InvokeResponse,
  TransportDispatchContext,
  TransportResult,
} from "@plexus/protocol";

/** The forward-boundary target: which workload + which BARE id an address translates to. */
export interface MeshForwardTarget {
  workload: WorkloadName;
  bareId: CapabilityId;
}

/**
 * The forward boundary the mesh transport delegates to — implemented by the PRIMARY
 * `MeshRuntime` (which owns the tunnel + the enrollment ledger). Split out as an
 * interface so the transport stays free of the tunnel/enrollment machinery (and so
 * T8 can wrap it with tunnel-trust hardening without touching this transport).
 */
export interface MeshInvokeForwarder {
  /**
   * THE PIN (no-SSRF guard): whether `workload` is an ENROLLED, pinned destination.
   * The transport refuses to forward to anything this returns `false` for — an
   * un-enrolled or otherwise-unknown target can never be reached over the tunnel.
   */
  isEnrolledDestination(workload: WorkloadName): boolean;
  /**
   * Forward an already-authorized invoke DOWN the enrolled proxy's tunnel and resolve
   * with its `invoke-result` (as an `InvokeResponse`). A down/unreachable proxy or a
   * lost reply resolves to a typed `capability_unavailable` (Invariant E) — never a hang.
   */
  forwardInvoke(
    target: MeshForwardTarget,
    address: CapabilityAddress,
    input: Record<string, unknown>,
    /**
     * The correlation id threading the primary's edge-span (this forward) to the proxy's
     * workload-span (the execution) — put on the wire so the proxy stamps the SAME id onto
     * the audit it records + bubbles back up (mesh §3.5). The same id is stamped on the
     * primary's own edge-span audit, so the two records stitch together.
     */
    correlationId: string,
  ): Promise<InvokeResponse>;
}

/** The injected forward seams (wired at gateway boot for a `primary`). */
interface MeshTransportConfig {
  /** Inverse-translate a mounted address → `{ workload, bareId }` (= `forwardAddress`). */
  resolveTarget: (address: CapabilityAddress) => MeshForwardTarget | undefined;
  /** The primary's forward boundary (tunnel + enrollment pin). */
  forwarder: MeshInvokeForwarder;
}

/** A clean typed `capability_unavailable` TransportResult (Invariant E — never a 500/hang). */
function unavailable(id: CapabilityId, message: string): TransportResult {
  return { ok: false, error: { code: "capability_unavailable", message, capabilityId: id } };
}

/** Fold a forwarded `InvokeResponse` (the proxy's outcome) back into a `TransportResult`. */
function toTransportResult(response: InvokeResponse): TransportResult {
  if (response.ok) {
    return {
      ok: true,
      data: response.output,
      ...(response.mcpResult ? { mcpResult: response.mcpResult } : {}),
    };
  }
  return {
    ok: false,
    ...(response.mcpResult ? { mcpResult: response.mcpResult } : {}),
    error: response.error ?? {
      code: "capability_unavailable",
      message: "mesh: forward failed with no error body",
      capabilityId: response.id,
    },
  };
}

export class MeshTransport implements Transport {
  readonly kind = "mesh" as const;
  private cfg?: MeshTransportConfig;

  /**
   * Wire the forward boundary (gateway boot, `primary` mode). Idempotent — a later
   * call replaces the config. Before this is called the transport is INERT (every
   * dispatch is a clean `capability_unavailable`).
   */
  configure(cfg: MeshTransportConfig): void {
    this.cfg = cfg;
  }

  async dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    _ctx?: TransportDispatchContext,
  ): Promise<TransportResult> {
    const cfg = this.cfg;
    if (!cfg) {
      // No tunnel wired (proxy-mode gateway, or a primary without a mesh runtime).
      return unavailable(entry.id, "mesh transport not active (no primary tunnel wired)");
    }

    // (1) TRANSLATE the mounted address back to its bare id — the single authoritative
    //     inverse of the mount prefix (Invariant B / Q4). Never string-split here.
    const target = cfg.resolveTarget(entry.id);
    if (!target) {
      return unavailable(entry.id, `'${entry.id}' is not a mounted mesh address (no forward route)`);
    }

    // (2) PIN the enrolled destination — refuse any un-enrolled / other target. A
    //     mounted address whose workload is not an active enrollment is unreachable
    //     (no SSRF via a mutable route); fail closed with the typed code.
    if (!cfg.forwarder.isEnrolledDestination(target.workload)) {
      return unavailable(
        entry.id,
        `mesh destination workload '${target.workload}' is not an enrolled proxy`,
      );
    }

    // (2b) CROSS-TIER AUDIT CORRELATION (mesh §3.5 / T9): mint the correlation id that
    //      threads THIS edge-span (the forward, audited at the primary under the mounted
    //      URN) to the proxy's workload-span (the execution, audited at the proxy under the
    //      bare id). Stamp it onto the live invoke context so the bridge's subsequent
    //      edge-span audit inherits it, AND put it on the wire so the proxy stamps the SAME
    //      id — the two records stitch together. Reuse any id already on the context (a
    //      nested/workflow forward keeps one id for the whole logical invoke).
    const ctx = _ctx?.invoke;
    const correlationId = ctx?.correlationId ?? crypto.randomUUID();
    if (ctx && !ctx.correlationId) ctx.correlationId = correlationId;

    // (3) FORWARD the BARE id down the pinned tunnel and await the correlated result.
    const response = await cfg.forwarder.forwardInvoke(target, entry.id, input, correlationId);
    return toTransportResult(response);
  }
}
