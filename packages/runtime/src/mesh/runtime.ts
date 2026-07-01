/**
 * MeshRuntime — the per-mode tunnel lifecycle + the primary's forward boundary
 * (federated-mesh §3.4 InvocationRouter, §7 Q1 primary passthrough; phase-1 plan
 * seam (b)/(d) / T7). The ONE place the tunnel (T4) is bound to the gateway: a
 * `primary` ACCEPTS a proxy tunnel (the second routable listener) and forwards
 * authorized invokes DOWN it; a `proxy` DIALS its upstream and EXECUTES the invokes
 * the primary forwards.
 *
 *   PRIMARY  — owns a `MeshServer` (the tunnel acceptor) + the durable
 *     `EnrollmentRegistry` (the pinned-destination ledger). Implements
 *     `MeshInvokeForwarder`: `isEnrolledDestination` PINS the forward target to an
 *     active enrollment (no SSRF), `forwardInvoke` sends an `invoke` frame down the
 *     proxy's tunnel and resolves with its `invoke-result` (or a typed
 *     `capability_unavailable` when the proxy is down — Invariant E, never a hang).
 *
 *   PROXY    — owns a `MeshClient` dialing the configured `upstream.url`. Its inbound
 *     handler receives forwarded `invoke` frames and EXECUTES the BARE id through the
 *     proxy's OWN local invoke path, replying with an `invoke-result`.
 *
 * TUNNEL-TRUST INGRESS (T8 — hardened here): the proxy-side receive runs the forwarded
 * invoke through the proxy's OWN `InvokePipeline` under a SYNTHETIC TRUSTED context
 * (`mintTunnelTrustContext`) that carries the pipeline's module-private tunnel-trust brand.
 * That brand — and ONLY that brand — makes `invokeById` skip the grant/scope/session gates
 * (Inv E: authority already terminated at the primary; the proxy never re-decides a grant).
 * The LOCAL exposure veto, schema/health gates, and audit STILL run (Inv C: join/forward ≠
 * access). The brand is unforgeable from the agent HTTP surface, so the auth-skip is reachable
 * ONLY for calls that provably arrived on the authenticated tunnel. The proxy never mints or
 * verifies a JWT and never touches the agent↔primary HS256 secret — this is a SECOND, separate
 * trust boundary (Ed25519 tunnel).
 */

import type {
  AuditEvent,
  AuditFrame,
  BridgeDeps,
  CapabilityAddress,
  CapabilityEntry,
  CapabilityId,
  Frame,
  GatewayMode,
  HealthFramePayload,
  HealthReportingCapability,
  HealthReportSource,
  InvokeFrame,
  InvokeFramePayload,
  InvokeRequest,
  InvokeResponse,
  InvokeResultFrame,
  NegotiatedHealthReporting,
  SourceModule,
  WorkloadName,
} from "@plexus/protocol";

import { readFileSync } from "node:fs";

import type { TLSOptions } from "bun";

import type { GatewayState } from "../core/state.ts";
import type { EntrySetChange } from "../core/capability-registry.ts";
import { BaseCapabilityBridge } from "../sources/base.ts";
import { InvokePipeline, PipelineError, mintTunnelTrustContext } from "../core/pipeline.ts";
import type { JsonlAuditWriterLike } from "../audit/index.ts";
import type { MeshForwardTarget, MeshInvokeForwarder } from "../transports/mesh.ts";
import { MeshServer, MeshClient, type MeshConnectionState, type HealthReportBody } from "./tunnel.ts";
import { buildCatalogPush, applyCatalog } from "./catalog.ts";
import { isBareCapabilityId } from "./addressing.ts";
import { newCorr, isFrame, validateHealthPayload } from "./frames.ts";
import { createEnrollmentRegistry, type EnrollmentRegistry } from "./enrollment.ts";
import { loadOrCreateMeshIdentity, type MeshIdentity } from "./keys.ts";
import { createPrimaryHandshakeDriver, createProxyHandshakeDriver } from "./handshake.ts";
import { ResolutionTable, type ResolutionView } from "./resolution.ts";
import {
  MeshHealthStore,
  meshHealthToCapabilityHealth,
  type MeshHealthState,
} from "./mesh-health.ts";

/** The synthetic source id every `mesh:<workload>` mounted entry routes its bridge through. */
export const MESH_BRIDGE_SOURCE_ID = "mesh";

/**
 * HEARTBEAT cadence (networking-resilience §2). The proxy pings every
 * `MESH_PROXY_HEARTBEAT_INTERVAL_MS`; the primary tears a connection down only after
 * `MESH_SERVER_IDLE_TIMEOUT_MS` of silence (~3× the interval) so a single missed beat (or a
 * transient stall) never trips a false teardown — only a genuinely dead/half-open socket does.
 */
const MESH_PROXY_HEARTBEAT_INTERVAL_MS = 15_000;
const MESH_PROXY_HEARTBEAT_TIMEOUT_MS = 5_000;
const MESH_SERVER_IDLE_TIMEOUT_MS = MESH_PROXY_HEARTBEAT_INTERVAL_MS * 3;

/**
 * HEALTH REPORTING (mesh-health-reporting.md §2). Both peers advertise this at the handshake;
 * reporting activates only when BOTH do (else the bare heartbeat above governs). The negotiated
 * interval is the MAX of the two adverts; it doubles as the liveness cadence when active. Default
 * matches the heartbeat interval so liveness cadence is unchanged.
 */
const MESH_HEALTH_VERSION = 1;
const MESH_HEALTH_INTERVAL_MS = 15_000;

/**
 * The synthetic AUDIT-ATTRIBUTION identity a forwarded invoke executes under on the PROXY
 * (tunnel-trust: the primary already authorized it — Invariant E). These values exist ONLY
 * to make the proxy-side audit linkage non-empty and attributable to the tunnel; they are
 * NEVER re-verified (no session lookup, no jti revocation check, no token) — the tunnel-trust
 * brand minted in `mintTunnelTrustContext` is what authorizes the call, not these strings.
 */
const MESH_TUNNEL_SESSION = "mesh-tunnel";
const MESH_TUNNEL_JTI = "mesh-tunnel";
const MESH_TUNNEL_AGENT = "mesh:primary";

/**
 * The generic bridge module a mounted `mesh:<workload>` source resolves to. It owns
 * no local lifecycle source; its bridge is the uniform `BaseCapabilityBridge`, which
 * resolves the mounted entry from the registry and dispatches it through the `mesh`
 * transport (the data-plane forward). Shared across every mounted workload — the
 * per-address routing lives entirely in the entry's `transport:"mesh"` + the
 * registry's forward index, not in a per-workload module.
 */
export function createMeshBridgeModule(): SourceModule {
  return {
    id: MESH_BRIDGE_SOURCE_ID,
    label: "Mesh (remote workloads)",
    transport: "mesh",
    createSource: () => {
      throw new Error("mesh bridge module has no local lifecycle source (entries arrive over the tunnel)");
    },
    createBridge: (deps: BridgeDeps, sessionId: string) =>
      new BaseCapabilityBridge(MESH_BRIDGE_SOURCE_ID, deps, sessionId, []),
  };
}

/**
 * Construction-time inputs for the mesh runtime (T12). Both are injectable so an
 * in-process test can run a primary AND a proxy with DISTINCT identities under one
 * `PLEXUS_HOME` (the persisted-identity cache would otherwise hand them the same key).
 */
export interface MeshRuntimeOptions {
  /** This gateway's Ed25519 mesh identity. Defaults to the persisted `loadOrCreateMeshIdentity()`. */
  identity?: MeshIdentity;
  /**
   * PROXY: the one-time join token to present at first enroll (delivered out-of-band by
   * the operator). Absent ⇒ the proxy attempts only the challenge leg (it must already be
   * enrolled, else the primary rejects it — fail-closed).
   */
  joinToken?: string;
  /**
   * PROXY: TLS trust for a `wss://` upstream (B7). Forwarded to the `MeshClient`'s per-connection
   * `tls` option — e.g. `{ ca: <primary cert PEM> }` to trust a self-signed primary. Injectable
   * here (like `identity`) so an in-process test can dial `wss://` with a test CA; in production a
   * proxy trusts the primary's cert via the host trust store / `NODE_EXTRA_CA_CERTS`.
   */
  upstreamTls?: TLSOptions;
  /**
   * HEALTH REPORTING (mesh-health-reporting.md §2) override. Absent ⇒ advertise the default
   * `{version, intervalMs}` (health reporting on when the peer also advertises). `disabled:true`
   * ⇒ do NOT advertise (bare-heartbeat fallback — the backward-compat path). `intervalMs` shrinks
   * the cadence (tests use a small value for fast, deterministic reports).
   */
  healthReporting?: { intervalMs?: number; disabled?: boolean };
}

/**
 * The outcome of a whole-workload revoke (B6) — what the orchestrator tore down, for the
 * admin route + CLI to report. `tombstoned` is whether an ACTIVE enrollment was flipped to
 * the terminal tombstone (false ⇒ unknown / already-revoked workload — the unmount/purge
 * still run idempotently). `unmounted` are the addresses removed from the directory;
 * `purgedGrants` is how many grants bound to them were dropped (Invariant C: ¬revoked).
 */
export interface MeshRevokeResult {
  workload: WorkloadName;
  tombstoned: boolean;
  unmounted: CapabilityAddress[];
  purgedGrants: number;
}

/**
 * One bound tunnel listener the primary advertises to operators (B7 / P4-0). `scheme`
 * distinguishes the plain (`ws`, enc-OFF) from the TLS (`wss`, enc-ON) endpoint; `host` is the
 * CONFIGURED bind host (may be `0.0.0.0` — the operator substitutes a routable host when handing
 * a proxy its upstream URL). Mint/status report the full set so a container/VM proxy can dial in.
 */
export interface TunnelEndpoint {
  scheme: "ws" | "wss";
  host: string;
  port: number;
}

/**
 * One row of the primary's per-workload REPORTED-health view (mesh-health-reporting.md §5/§6),
 * surfaced by the admin `/api/mesh` `workloads[]`. Combines the coarse route (`connection`) with
 * the fine reported state + per-source detail.
 */
export interface MeshWorkloadHealthRow {
  workload: WorkloadName;
  /** Whether an authenticated socket is currently promoted for this workload. */
  connection: "connected" | "disconnected";
  /** Whether health reporting was NEGOTIATED (both advertised) on the current connection. */
  healthReporting: boolean;
  /** The resolved rich mesh-health state (ok/degraded/down/stale/connecting/unavailable). */
  state: MeshHealthState;
  /** The last report's aggregate, if any. */
  overall?: HealthFramePayload["overall"];
  /** The last report's per-source rows (admin detail). */
  sources?: HealthReportSource[];
  /** The last accepted report's sequence number. */
  seq?: number;
  /** When the reporter built the last report. */
  reportedAt?: string;
  /** When the primary received the last report. */
  receivedAt?: string;
  /** When the route first went down (present with `state:"unavailable"`). */
  unavailableSince?: string;
  /** Human-readable reason for the current state. */
  detail?: string;
}

/** The wired mesh subsystem attached to `GatewayState`. */
export interface MeshRuntime {
  readonly mode: GatewayMode;
  /** The primary's forward boundary (consumed by the `mesh` transport). */
  readonly forwarder: MeshInvokeForwarder;
  /** Bind the tunnel for this mode (primary: accept; proxy: dial). Idempotent. */
  start(): Promise<void>;
  /** Tear the tunnel down. Idempotent + best-effort. */
  stop(): void;
  /** PRIMARY: the bound plain-`ws` tunnel-acceptor port (after `start()`), else `0`. */
  readonly tunnelPort: number;
  /**
   * PRIMARY: every bound tunnel listener (B7 / P4-0) — the plain `ws` endpoint plus, when TLS is
   * configured, the `wss` one. Empty before `start()` / on a proxy. The mint/status surfaces
   * report this so an operator can hand a container/VM proxy a reachable upstream URL + scheme.
   */
  readonly tunnelEndpoints: TunnelEndpoint[];
  /**
   * PRIMARY: this gateway's pinned Ed25519 public key (SPKI PEM) — the identity a
   * remote proxy must pin as its `upstream.primaryPubKey` (M1). Available only after
   * `start()` resolves the identity on a primary; `undefined` on a proxy (its key is
   * not the mesh trust root) or before the tunnel listener is bound. The out-of-process
   * join-token mint surface (A1) hands this to the operator alongside the token.
   */
  readonly meshPublicKey: string | undefined;
  /** PRIMARY: whether a proxy tunnel is currently attached. */
  readonly connected: boolean;
  /**
   * PROXY: this proxy's own tunnel connection state (networking-resilience §3) — `connecting`
   * | `authenticating` | `connected` | `reconnecting` | `closed`. Lets the admin/diagnostics
   * surface render a proxy as connected/reconnecting/down. `undefined` on a primary (it accepts,
   * it does not dial) or before `start()`.
   */
  readonly proxyConnectionState: MeshConnectionState | undefined;
  /**
   * PRIMARY: force-drop every attached proxy socket (they auto-reconnect — networking-resilience
   * §1). Operational hook to bounce tunnels (e.g. after a TLS reload) + the transient-drop test
   * seam. The mounted addresses + grants SURVIVE (Invariant B / Risk 1 — no unmount on a transient
   * drop); resolution flips unavailable then back to ok as each proxy re-authenticates. No-op on a proxy.
   */
  dropProxyConnections(): void;
  /**
   * PRIMARY: hot-reload the `wss` TLS cert without a full restart (encryption-policy §2.1). Re-reads
   * the configured `PLEXUS_MESH_TLS_CERT`/`_KEY` files and rebinds ONLY the `wss` listener; the
   * plain-`ws` listener + HTTP plane are untouched. Open `wss` tunnels drop + auto-reconnect onto
   * the fresh cert (Ed25519 identity unchanged ⇒ no re-enroll). No-op when no `wss` listener is
   * configured or on a proxy. Returns the bound `wss` port, or `undefined`.
   */
  reloadTunnelTls(): number | undefined;
  /** PRIMARY: the durable enrollment ledger (the pinned-destination authority). */
  readonly enrollment: EnrollmentRegistry | undefined;
  /**
   * PRIMARY: REVOKE a workload across the mesh (B6 — terminal). Tombstones its enrollment
   * (fail-closed durable write), un-mounts every address it owns, purges the grants bound
   * to them, drops its live tunnel socket, and stamps its resolution unavailable — so the
   * revoked workload is refused everywhere and a reconnect with its old pinned key fails
   * closed (`not_enrolled`). Idempotent; see `MeshRevokeResult`.
   */
  revokeWorkload(workload: WorkloadName): MeshRevokeResult;
  /**
   * PRIMARY: health-aware resolution view (T10). Reports whether a mounted workload's
   * home (its dialed tunnel) is reachable — read by the health gate + forward boundary so
   * a cap whose proxy is down surfaces a typed `capability_unavailable` + `unavailableSince`
   * (Invariant E), never a hang. On a proxy gateway it stays empty (no mounted caps).
   */
  readonly resolution: ResolutionView;
  /**
   * PRIMARY: the per-workload REPORTED-health view (mesh-health-reporting.md §5/§6). One row per
   * active enrolled workload (plus any with a stored report): route + rich mesh-health state +
   * per-source detail. Empty on a proxy. The admin `/api/mesh` surfaces it so the console renders
   * the real status of mounted mesh caps instead of "health unknown".
   */
  meshWorkloadHealth(): MeshWorkloadHealthRow[];
  /**
   * PROXY: the most recent forwarded invoke payload this proxy received over the
   * tunnel. A diagnostics/test seam proving the BARE id (never the prefix) arrived
   * on the wire (Q4).
   */
  readonly lastForwardedInvoke: InvokeFramePayload | undefined;
  /**
   * PROXY: the most recent health frame the primary sent DOWN the tunnel (cascade / bidirectional
   * liveness — mesh-health-reporting.md §4). Diagnostics/test seam. `undefined` on a primary or
   * before any primary→proxy report is received.
   */
  readonly lastPrimaryHealth: HealthFramePayload | undefined;
}

/**
 * A typed `capability_unavailable` InvokeResponse (Invariant E — never a hang). When the
 * home's down-time is known (from the ResolutionTable) it carries `unavailableSince` so the
 * caller learns HOW LONG it has been down rather than just THAT it is down.
 */
function unavailableResponse(id: CapabilityId, message: string, unavailableSince?: string): InvokeResponse {
  return {
    id,
    ok: false,
    error: {
      code: "capability_unavailable",
      message,
      capabilityId: id,
      ...(unavailableSince ? { unavailableSince } : {}),
    },
    auditId: "",
  };
}

class MeshRuntimeImpl implements MeshRuntime, MeshInvokeForwarder {
  // This gateway's Ed25519 mesh identity (T12) — lazily resolved at start().
  private identity?: MeshIdentity;
  // PRIMARY side.
  private server?: MeshServer;
  private enrollmentReg?: EnrollmentRegistry;
  // PRIMARY: the health-aware resolution table (T10). The MeshServer drives it as the
  // active socket comes/goes; the health gate + forward boundary read it. Always present
  // (a proxy's stays empty — it mounts nothing).
  private readonly resolutionTable = new ResolutionTable();
  // PRIMARY: the per-workload REPORTED-health store (mesh-health-reporting.md §4/§5). Populated
  // from `health` frames (attributed to the AUTHENTICATED workload, never `payload.reporter`);
  // read by the mesh-health provider wired onto the registry so mounted caps resolve their health.
  private readonly meshHealth = new MeshHealthStore();
  // PRIMARY: the negotiated health-reporting params per workload (from the handshake, on connect).
  private readonly negotiatedByWorkload = new Map<WorkloadName, NegotiatedHealthReporting>();
  // PRIMARY: per-workload primary→proxy health-send timers (cleared on disconnect/revoke/stop).
  private readonly primaryHealthTimers = new Map<WorkloadName, ReturnType<typeof setInterval>>();
  // PRIMARY: monotonic sequence for the primary→proxy health frames it emits (cascade downward).
  private primaryHealthSeq = 0;
  // PROXY: the most recent primary→proxy health frame (bidirectional/cascade diagnostics).
  private primaryHealthReport?: HealthFramePayload;
  // PROXY side.
  private client?: MeshClient;
  // PROXY: whether the one-time enroll handshake has been accepted on this process (so a
  // reconnect runs only the challenge leg — the join token is single-use, T12).
  private enrolled = false;
  // PROXY tunnel-trust ingress pipeline (T8). The proxy's OWN local invoke pipeline,
  // entered under a synthetic tunnel-trust context. Lazily built, gateway-lived (NOT
  // session-scoped) so the tunnel's bridge cache survives across forwarded invokes and is
  // never torn down by an agent `disposeSession` (it lives on a separate pipeline instance).
  private tunnelPipeline?: InvokePipeline;
  // PROXY diagnostics/test seam.
  private lastInvoke?: InvokeFramePayload;
  // PROXY audit-bubble subscription (T9). Unhooks the `onAppend` listener on `stop()`.
  private unsubscribeAudit?: () => void;
  // PROXY catalog-delta subscription (A2). Unhooks the registry `subscribe` on `stop()`;
  // re-pushes the changed/withdrawn ids so the primary's mounted directory tracks local
  // capability changes (a source coming online, an extension registering/unregistering).
  private unsubscribeCatalog?: () => void;

  constructor(
    private readonly state: GatewayState,
    private readonly opts: MeshRuntimeOptions = {},
  ) {}

  /** This gateway's mesh identity — injected for tests, else the persisted per-host key. */
  private meshIdentity(): MeshIdentity {
    return (this.identity ??= this.opts.identity ?? loadOrCreateMeshIdentity());
  }

  get mode(): GatewayMode {
    return this.state.mode;
  }

  get forwarder(): MeshInvokeForwarder {
    return this;
  }

  get tunnelPort(): number {
    return this.server?.port ?? 0;
  }

  get tunnelEndpoints(): TunnelEndpoint[] {
    // PRIMARY-only, post-start (a bound `server` is the proof). The configured bind host is
    // reported verbatim (it may be `0.0.0.0`); the `ws` endpoint always exists, the `wss` one
    // only when a TLS listener was bound.
    if (this.mode !== "primary" || !this.server) return [];
    const host = this.state.config.tunnel?.host ?? "127.0.0.1";
    const endpoints: TunnelEndpoint[] = [{ scheme: "ws", host, port: this.server.port }];
    const wssPort = this.server.wssPort;
    if (wssPort !== undefined) endpoints.push({ scheme: "wss", host, port: wssPort });
    return endpoints;
  }

  get meshPublicKey(): string | undefined {
    // PRIMARY-only, post-start: the listener being bound (`server`) is the proof the
    // identity has been resolved. A proxy's identity is never the mesh trust root, so
    // it reports nothing here (the proxy PINS the primary's key, it doesn't publish one).
    if (this.mode !== "primary" || !this.server) return undefined;
    return this.identity?.publicKeyPem;
  }

  get connected(): boolean {
    return this.server?.connected ?? false;
  }

  get proxyConnectionState(): MeshConnectionState | undefined {
    return this.client?.connectionState;
  }

  /** PRIMARY: force-drop attached proxy sockets (they auto-reconnect). No-op on a proxy. */
  dropProxyConnections(): void {
    this.server?.dropActiveConnection();
  }

  /**
   * PRIMARY: hot-reload the `wss` cert (encryption-policy §2.1). Re-reads the configured cert/key
   * files and rebinds only the `wss` listener. Throws a clear error if the files cannot be read
   * (so a bad rotation is loud, never a silent dead-end). No-op when no TLS material is configured.
   */
  reloadTunnelTls(): number | undefined {
    const tls = this.state.config.tunnel?.tls;
    if (!this.server || !tls) return undefined;
    let material: { cert: string; key: string };
    try {
      material = { cert: readFileSync(tls.certPath, "utf8"), key: readFileSync(tls.keyPath, "utf8") };
    } catch (err) {
      throw new Error(
        `[plexus] failed to reload mesh TLS material (PLEXUS_MESH_TLS_CERT/_KEY): ${(err as Error).message}`,
      );
    }
    return this.server.reloadTls(material);
  }

  get enrollment(): EnrollmentRegistry | undefined {
    return this.enrollmentReg;
  }

  get resolution(): ResolutionView {
    return this.resolutionTable;
  }

  get lastForwardedInvoke(): InvokeFramePayload | undefined {
    return this.lastInvoke;
  }

  get lastPrimaryHealth(): HealthFramePayload | undefined {
    return this.primaryHealthReport;
  }

  /**
   * This gateway's health-reporting advertisement (mesh-health-reporting.md §2), or `undefined`
   * when disabled (bare-heartbeat fallback). Both a primary and a proxy advertise; reporting
   * activates only when the peer also advertises.
   */
  private healthAdvert(): HealthReportingCapability | undefined {
    if (this.opts.healthReporting?.disabled) return undefined;
    return {
      version: MESH_HEALTH_VERSION,
      intervalMs: this.opts.healthReporting?.intervalMs ?? MESH_HEALTH_INTERVAL_MS,
    };
  }

  /**
   * Aggregate THIS gateway's LOCAL source health into a health-report body (proxy→primary ascent
   * and primary→proxy cascade share this). Excludes `mesh:*` mounted sources (never recurse a
   * mount into our own report). `overall` is the worst-of the local sources' statuses
   * (unavailable→down, degraded→degraded, else ok — `unknown` does not alarm).
   */
  private buildLocalHealthReport(): HealthReportBody {
    const sources: HealthReportSource[] = [];
    let anyDown = false;
    let anyDegraded = false;
    const report =
      typeof this.state.capabilities.healthReport === "function"
        ? this.state.capabilities.healthReport()
        : { sources: [], revision: 0 };
    for (const row of report.sources) {
      if (row.id.startsWith("mesh:")) continue; // don't fold mounted mesh caps into our own report
      sources.push({
        source: row.id,
        status: row.status,
        ...(row.detail ? { detail: row.detail } : {}),
        ...(row.checkedAt ? { checkedAt: row.checkedAt } : {}),
      });
      if (row.status === "unavailable") anyDown = true;
      else if (row.status === "degraded") anyDegraded = true;
    }
    const overall: HealthFramePayload["overall"] = anyDown ? "down" : anyDegraded ? "degraded" : "ok";
    return { overall, sources };
  }

  /**
   * PRIMARY: the per-workload reported-health view (mesh-health-reporting.md §5/§6). One row per
   * active enrolled workload (plus any with a stored report), route + rich state + detail.
   */
  meshWorkloadHealth(): MeshWorkloadHealthRow[] {
    if (this.mode !== "primary") return [];
    const workloads = new Set<WorkloadName>();
    for (const rec of this.enrollmentReg?.list() ?? []) {
      if (rec.status === "active") workloads.add(rec.workload);
    }
    for (const w of this.negotiatedByWorkload.keys()) workloads.add(w);
    const rows: MeshWorkloadHealthRow[] = [];
    for (const workload of workloads) {
      const h = this.meshHealth.stateFor(workload, this.resolutionTable);
      rows.push({
        workload,
        connection: this.server?.isConnected(workload) ? "connected" : "disconnected",
        healthReporting: this.negotiatedByWorkload.has(workload),
        state: h.state,
        ...(h.overall ? { overall: h.overall } : {}),
        ...(h.sources ? { sources: h.sources } : {}),
        ...(h.seq !== undefined ? { seq: h.seq } : {}),
        ...(h.reportedAt ? { reportedAt: h.reportedAt } : {}),
        ...(h.receivedAt ? { receivedAt: h.receivedAt } : {}),
        ...(h.unavailableSince ? { unavailableSince: h.unavailableSince } : {}),
        ...(h.detail ? { detail: h.detail } : {}),
      });
    }
    return rows;
  }

  /** The mesh-health provider wired onto the registry: resolves a `mesh:<workload>` source's health. */
  private meshHealthForSource(sourceId: string): ReturnType<typeof meshHealthToCapabilityHealth> | undefined {
    if (!sourceId.startsWith("mesh:")) return undefined;
    const workload = sourceId.slice("mesh:".length);
    return meshHealthToCapabilityHealth(this.meshHealth.stateFor(workload, this.resolutionTable));
  }

  async start(): Promise<void> {
    if (this.mode === "primary") this.startPrimary();
    else this.startProxy();
  }

  stop(): void {
    // Clear every primary→proxy health loop before dropping the server (no orphan timers).
    for (const timer of this.primaryHealthTimers.values()) clearInterval(timer);
    this.primaryHealthTimers.clear();
    this.negotiatedByWorkload.clear();
    this.server?.stop();
    this.server = undefined;
    this.unsubscribeAudit?.();
    this.unsubscribeAudit = undefined;
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = undefined;
    this.client?.close();
    this.client = undefined;
  }

  // ── PRIMARY: accept the proxy tunnel + own the enrollment ledger ───────────────

  private startPrimary(): void {
    if (this.server) return;
    // The pinned-destination authority (T5). Created lazily at start so a non-mesh
    // boot never touches the ledger on disk.
    const reg = (this.enrollmentReg = createEnrollmentRegistry());
    const identity = this.meshIdentity();
    // CROSS-HOST SPINE (B7 / P4-0): the tunnel bind config from boot env. Defaults to today's
    // loopback + ephemeral `ws` listener (back-compat); a routable host + fixed `ws`/`wss` ports
    // + TLS open it to containers/VMs. The TLS material (file paths) is read here — fail-fast
    // with a clear error so a missing cert aborts the tunnel at boot, never a silent dead-end.
    const tunnel = this.state.config.tunnel;
    const hostname = tunnel?.host ?? "127.0.0.1";
    let tls: { cert: string; key: string } | undefined;
    if (tunnel?.tls) {
      try {
        tls = {
          cert: readFileSync(tunnel.tls.certPath, "utf8"),
          key: readFileSync(tunnel.tls.keyPath, "utf8"),
        };
      } catch (err) {
        throw new Error(
          `[plexus] failed to read mesh TLS material (PLEXUS_MESH_TLS_CERT/_KEY): ${(err as Error).message}`,
        );
      }
    }
    // The second routable listener (ephemeral port). The proxy DIALS this; the primary
    // FORWARDS down it. The T12 AUTH GATE (`createHandshake`) fronts every accepted
    // socket: it runs the LIVE enroll `admit()` (H1) + the Ed25519 mutual challenge, and
    // ONLY a socket that proves the LEDGER-pinned proxy key is promoted to carry frames.
    // Until then no `invoke`/`audit`/`catalog` frame reaches `onPrimaryInbound` (an
    // unauthenticated/unenrolled socket can neither invoke nor push — fail-closed).
    // MANDATORY-ENCRYPTION POLICY (B7 hardening): when set, the primary refuses a plain-`ws`
    // proxy at the handshake (typed `encryption_required`) and accepts only the `wss` channel.
    // Identity ⟂ encryption (mesh §7 Q2) — the Ed25519 gate is unchanged. Config fails fast if
    // this is set without TLS, so a `true` here is always paired with a bound `wss` listener.
    const requireEncryption = tunnel?.requireEncryption === true;
    // HEALTH REPORTING (mesh-health-reporting.md §6): wire the registry's mesh-health provider so a
    // `mesh:<workload>` bridge source resolves its health from the last REPORT (route-first), not
    // the local SourceHealthCache (which would read "unavailable/unknown" for a synthetic source).
    if (typeof this.state.capabilities.setMeshHealthProvider === "function") {
      this.state.capabilities.setMeshHealthProvider((sourceId) => this.meshHealthForSource(sourceId));
    }
    const healthAdvert = this.healthAdvert();
    this.server = new MeshServer({
      hostname,
      ...(tunnel?.wsPort !== undefined ? { port: tunnel.wsPort } : {}),
      ...(tunnel?.wssPort !== undefined && tls ? { wssPort: tunnel.wssPort, tls } : {}),
      onRequest: (f, workload) => this.onPrimaryInbound(f, workload),
      // PRIMARY-SIDE IDLE TEARDOWN (heartbeat): tear down a half-open proxy socket within ~3×
      // the proxy heartbeat interval so the ResolutionTable stamps it unavailable promptly even
      // with no forward in flight (networking-resilience §2). Comfortably above one missed beat.
      heartbeatTimeoutMs: MESH_SERVER_IDLE_TIMEOUT_MS,
      createHandshake: ({ encrypted }) =>
        createPrimaryHandshakeDriver({
          identity,
          // H1 — wire the enrollment admission into the LIVE connect path.
          admit: (req) => reg.admit(req, identity),
          pinnedProxyPubKeyFor: (workload) => this.pinnedProxyPubKeyFor(workload),
          // B7 — refuse a non-encrypted channel when the policy is on (this connection's
          // `encrypted` flag is threaded from the listener it arrived on).
          requireEncryption,
          encrypted,
          // HEALTH REPORTING (mesh-health-reporting.md §2): advertise so a proxy that also
          // advertises activates bidirectional reporting; a pre-health proxy omits it ⇒ fallback.
          ...(healthAdvert ? { healthReporting: healthAdvert } : {}),
        }),
      // T10 — RESOLUTION HEALTH: a workload's mounted caps become reachable on
      // authenticated-socket promotion and unreachable (stamped) on drop/close/teardown.
      // (Invariant B: this changes the RESOLUTION, never the address or its grants.)
      onConnect: (workload, negotiated) => this.onProxyConnected(workload, negotiated),
      onDisconnect: (workload) => this.onProxyDisconnected(workload),
    });
    this.server.start();
  }

  /** The proxy pubkey pinned for an ACTIVE enrollment of `workload`, else undefined (T12). */
  private pinnedProxyPubKeyFor(workload: WorkloadName): string | undefined {
    const rec = this.enrollmentReg?.get(workload);
    return rec && rec.status === "active" ? rec.pinnedProxyPubKey : undefined;
  }

  /**
   * PRIMARY: an authenticated proxy socket was PROMOTED (mesh-health-reporting.md §4). Marks the
   * resolution available (T10) and, when health reporting was NEGOTIATED, records the interval +
   * starts the primary→proxy health loop (initial snapshot + periodic cascade downward).
   */
  private onProxyConnected(workload: WorkloadName | undefined, negotiated?: NegotiatedHealthReporting): void {
    this.resolutionTable.markAvailable(workload);
    if (!workload) return;
    // SEQ-GATE RESET (mesh-health-reporting.md §5) — open a fresh connection epoch so a reconnect's
    // reports (a restarted proxy restarts its in-memory `healthSeq` at 1) are accepted rather than
    // dropped behind the stale pre-restart seq. The last health VALUE is retained (Invariant B).
    this.meshHealth.beginConnection(workload);
    if (negotiated) {
      this.negotiatedByWorkload.set(workload, negotiated);
      this.meshHealth.noteInterval(workload, negotiated.intervalMs);
      this.startPrimaryHealthLoop(workload, negotiated.intervalMs);
    } else {
      this.negotiatedByWorkload.delete(workload);
      this.stopPrimaryHealthLoop(workload);
    }
  }

  /**
   * PRIMARY: a proxy socket DROPPED (mesh-health-reporting.md §5). Stamps the resolution
   * unavailable (T10 / Invariant E) and stops the primary→proxy health loop. The last REPORT is
   * KEPT in the store (Invariant B / Risk-1 — a transient drop resolves `unavailable` via the
   * route, and recovery is a fresh report away; the mount + grants survive).
   */
  private onProxyDisconnected(workload: WorkloadName | undefined): void {
    this.resolutionTable.markUnavailable(workload);
    if (workload) this.stopPrimaryHealthLoop(workload);
  }

  /**
   * PRIMARY: start (or restart) the primary→proxy health-send loop for `workload`. Sends an
   * initial snapshot immediately (so the proxy has liveness right away) then one every
   * `intervalMs`. Each frame carries the primary's OWN aggregated local health (cascade). Sent via
   * `server.forward` (the proxy acks it); best-effort — a slow/absent proxy never wedges the primary.
   */
  private startPrimaryHealthLoop(workload: WorkloadName, intervalMs: number): void {
    this.stopPrimaryHealthLoop(workload);
    // DEFENSE IN DEPTH (mesh-health-reporting.md §4) — a non-finite/≤0 interval must NEVER arm a
    // 0-delay `setInterval` (NaN coerces to 0 → a health-frame flood + CPU spin). `negotiate…`
    // already validates + clamps the advert fail-closed, but mirror the proxy-side heartbeat guard
    // (tunnel.ts) here so a bad interval reaching this loop skips it entirely rather than spinning.
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const send = () => {
      const server = this.server;
      if (!server) return;
      const body = this.buildLocalHealthReport();
      this.primaryHealthSeq += 1;
      const frame: HealthFramePayload = {
        reporter: "primary",
        overall: body.overall,
        sources: body.sources,
        seq: this.primaryHealthSeq,
        ts: new Date().toISOString(),
      };
      void server.forward(workload, { t: "health", corr: newCorr(), payload: frame }).catch(() => {
        /* primary→proxy cascade is best-effort — the proxy may be mid-reconnect */
      });
    };
    send(); // initial snapshot on connect
    const timer = setInterval(send, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.primaryHealthTimers.set(workload, timer);
  }

  /** PRIMARY: stop the primary→proxy health loop for `workload` (idempotent). */
  private stopPrimaryHealthLoop(workload: WorkloadName): void {
    const timer = this.primaryHealthTimers.get(workload);
    if (timer) {
      clearInterval(timer);
      this.primaryHealthTimers.delete(workload);
    }
  }

  /**
   * PRIMARY: REVOKE `workload` across the mesh (B6). The orchestrator wiring the five
   * teardown seams in a deliberate, fail-closed ORDER:
   *
   *   1. TOMBSTONE   — `enrollment.revoke` flips the record to the terminal `"revoked"`
   *                    status (durable, fail-closed). Runs FIRST so a durable-write failure
   *                    throws BEFORE any destructive step below — nothing half-revokes.
   *   2. UN-MOUNT    — drop every mounted address this workload owns from the directory
   *                    (bumps the revision + emits `removed`; agents re-fetch the manifest).
   *   3. PURGE GRANTS — remove the grants bound to each un-mounted address (Invariant C:
   *                    effective access requires ¬revoked; no orphaned standing grant survives).
   *   4. DROP SOCKET — force-close the workload's live tunnel (A3's per-workload map); its
   *                    in-flight forwards reject, and it cannot carry another frame.
   *   5. RESOLUTION  — stamp the home unavailable so any racing read agrees it is down.
   *
   * The tombstone is what makes this TERMINAL: a reconnect's challenge finds no pin
   * (`pinnedProxyPubKeyFor` gates on `status==="active"`) → `not_enrolled`, fail-closed.
   * Idempotent — safe to call for an unknown / already-revoked workload (steps 2-5 no-op).
   */
  revokeWorkload(workload: WorkloadName): MeshRevokeResult {
    // 1 — terminal tombstone (throws on a failed durable write, before anything destructive).
    const tombstoned = this.enrollmentReg?.revoke(workload) ?? false;
    // 2 — un-mount every address this workload owns.
    const unmounted = this.state.capabilities.unmountWorkload(workload);
    // 3 — purge the grants bound to each un-mounted address (Invariant C: ¬revoked).
    let purgedGrants = 0;
    for (const address of unmounted) {
      purgedGrants += this.state.grants.removeForCapability(address);
    }
    // 4 — drop the live tunnel socket (A3's per-workload `byWorkload` map).
    this.server?.dropConnection(workload);
    // 5 — the home is gone: stamp the resolution unavailable (Invariant E) + forget its reported
    // health + stop any primary→proxy health loop (a revoked workload reports nothing).
    this.resolutionTable.markUnavailable(workload);
    this.stopPrimaryHealthLoop(workload);
    this.negotiatedByWorkload.delete(workload);
    this.meshHealth.forget(workload);
    return { workload, tombstoned, unmounted, purgedGrants };
  }

  /**
   * Frames a proxy sends UP the tunnel. The primary keeps liveness sane (echo a `ping`)
   * and MIRRORS audit bubbles (T9): an `audit` frame carries the proxy's authoritative,
   * already-redacted local event; we re-write it through the primary's OWN audit writer
   * (same redactor — the mirror never reveals more than the proxy's local log, §7 Q7),
   * stamping `tier:"proxy"` + the originating workload, then ACK so the proxy's bubble
   * resolves. A `catalog` frame (A2) MOUNTS the pushed BARE entries under the SOCKET-bound
   * authenticated workload (live ascent). Anything else gets a typed no-op result so a stray
   * frame can never wedge the mux.
   *
   * NOTE (T12/A3): a frame only reaches here on an ALREADY-AUTHENTICATED socket — the
   * connection-auth gate promotes a socket to its mux only after the Ed25519 handshake, and
   * the tunnel hands us the per-connection `workload` bound to THAT socket (fan-out: the
   * catalog/audit ascent is attributed to the originating proxy, never to "the sole active
   * record" nor a payload field). `enroll` is consumed by the gate's LIVE `admit()` (H1),
   * not here; an `enroll` frame arriving post-auth is unexpected and gets the benign default.
   */
  private onPrimaryInbound(frame: Frame, workload: WorkloadName | undefined): Frame {
    if (isFrame(frame, "ping")) return { t: "ping", corr: frame.corr, payload: {} };
    if (isFrame(frame, "health")) {
      // PROXY→PRIMARY health report (mesh-health-reporting.md §4). ANTI-FORGERY: attribute it to
      // the AUTHENTICATED `workload` bound to THIS socket by the tunnel — NEVER `payload.reporter`
      // (a proxy must not report for another workload, same discipline as catalog mounting). The
      // frame doubles as liveness: the tunnel already bumped this connection's `lastSeen` on
      // receipt. Validate fail-closed so a malformed report can't corrupt the store. Ack ping-style.
      const validated = validateHealthPayload(frame.payload);
      if (validated) this.meshHealth.record(workload, validated);
      return { t: "ping", corr: frame.corr, payload: {} };
    }
    if (isFrame(frame, "audit")) {
      // BEST-EFFORT mirror (Invariant D): fire-and-forget the write, then ACK immediately.
      // A mirror-write failure must never delay the ack or wedge the proxy's ascent.
      this.mirrorProxyAudit(frame.payload, workload);
      return { t: "ping", corr: frame.corr, payload: {} };
    }
    if (isFrame(frame, "catalog")) {
      // LIVE CATALOG ASCENT (A2 / §3.2 / Invariant B address⟂route, Invariant F): mount the
      // pushed BARE entries under THIS gateway's directory. The mount workload is the
      // SOCKET-BOUND authenticated identity threaded in from the tunnel — NEVER
      // `frame.payload.workload`, which is untrusted: a proxy must never mount under another
      // workload's prefix (a forged payload workload is ignored). The entries default to
      // ZERO-EXPOSURE / hidden (§7 Q3 — join ≠ access); the owner reveals them later.
      const authedWorkload = workload;
      if (authedWorkload) {
        applyCatalog(
          this.state.capabilities,
          {
            workload: authedWorkload,
            entries: frame.payload.entries,
            ...(frame.payload.withdrawn ? { withdrawn: frame.payload.withdrawn } : {}),
          },
          {
            ...(this.state.config.tenant ? { tenant: this.state.config.tenant } : {}),
            exposureDefault: "hidden",
          },
        );
      }
      // Ack (ping-style) so the proxy's mux-acked push resolves; a frame on an
      // un-authenticated socket never reaches here (the gate fails it closed).
      return { t: "ping", corr: frame.corr, payload: {} };
    }
    return {
      t: "invoke-result",
      corr: frame.corr,
      payload: unavailableResponse("", "primary: tunnel ascent frame not handled"),
    };
  }

  /**
   * PRIMARY: persist a redacted MIRROR of a proxy's bubbled audit event (T9 / §7 Q7). The
   * event arrives ALREADY redacted by the proxy's writer (the SAME `JsonlAuditWriter`
   * redactor both tiers run), so re-writing it through the primary's writer is idempotent
   * on the redacted content — the mirror can never reveal more than the proxy's local log.
   * The primary RE-STAMPS the authority-owned metadata: `tier:"proxy"` (this is a
   * proxy-tier record in the primary's single-pane log) + the originating workload (derived
   * from the authenticated enrollment, NOT trusted from the payload). The proxy's local log
   * stays authoritative; the primary holds the full redacted mirror. Best-effort: a write
   * failure is swallowed (Invariant D — audit aggregation never blocks the data plane).
   */
  private mirrorProxyAudit(event: AuditEvent, originating: WorkloadName | undefined): void {
    // The originating workload is the SOCKET-bound identity the tunnel threaded in (fan-out:
    // the bubble provably came from THAT proxy). Fall back to the single-active heuristic only
    // for the legacy path where the tunnel did not supply one.
    const workload = originating ?? this.originatingWorkload();
    // Drop the proxy-local `id`/`at`; the primary's writer re-stamps a fresh id + receive
    // time for the mirror record. `tier`/correlationId are preserved (correlationId threads
    // to the edge-span; tier is force-set to "proxy" since any bubbled event is proxy-tier).
    const { id: _id, at: _at, ...rest } = event;
    void this.state.audit
      .write({
        ...rest,
        tier: "proxy",
        detail: { ...(rest.detail ?? {}), ...(workload ? { workload } : {}), mirror: true },
      })
      .catch(() => {
        /* mirror persistence is best-effort; never blocks/affects the ascent (Inv D) */
      });
  }

  /**
   * FALLBACK attribution for a bubbled audit when the tunnel did not thread a per-connection
   * workload (A3 supplies one for every authenticated socket, so this is now only a legacy
   * safety net). Prefers the sole authenticated socket's identity, else the sole ACTIVE
   * enrollment — derived from the authenticated ledger, never trusted from the wire. Undefined
   * when the mapping is ambiguous (0 or >1 active), since under fan-out it cannot be guessed.
   */
  private originatingWorkload(): WorkloadName | undefined {
    // Prefer the identity bound to the AUTHENTICATED socket — only unambiguous (exactly one
    // proxy attached) under fan-out; otherwise fall through to the ledger heuristic.
    const authed = this.server?.authenticatedWorkload;
    if (authed) return authed;
    const active = this.enrollmentReg?.list().filter((r) => r.status === "active") ?? [];
    return active.length === 1 ? active[0]!.workload : undefined;
  }

  // ── PRIMARY: the forward boundary (MeshInvokeForwarder) ────────────────────────

  isEnrolledDestination(workload: WorkloadName): boolean {
    // THE PIN: only an ACTIVE enrollment is a legal forward target. An un-enrolled /
    // withdrawn workload is unreachable (no SSRF via a mounted route).
    return this.enrollmentReg?.isActive(workload) === true;
  }

  async forwardInvoke(
    target: MeshForwardTarget,
    address: CapabilityAddress,
    input: Record<string, unknown>,
    correlationId: string,
  ): Promise<InvokeResponse> {
    const server = this.server;
    // The home's down-time (if known) rides every unavailable reply so the caller learns
    // HOW LONG it has been down, not merely THAT it is (Invariant E).
    const since = this.resolutionTable.healthOf(target.workload).unavailableSince;
    if (!server) {
      return unavailableResponse(address, "mesh: primary tunnel listener not started", since);
    }
    // The wire carries the FULL address (the audited URN, Invariant B), the BARE id the
    // proxy executes (workload-agnostic on the wire, Q4 — never the prefix), AND the
    // correlationId that threads the primary's edge-span audit to the proxy's workload-span
    // (mesh §3.5 / T9). `corr` is the tunnel mux key (per-frame, ephemeral); `correlationId`
    // is the cross-tier audit thread — distinct concerns, do not conflate.
    const frame: InvokeFrame = {
      t: "invoke",
      corr: newCorr(),
      payload: {
        address,
        id: target.bareId,
        ...(input !== undefined ? { input } : {}),
        correlationId,
      },
    };

    let reply: Frame;
    try {
      // L-2 — route DOWN exactly `target.workload`'s tunnel. `forward(workload, …)` looks the
      // socket up by workload, so an invoke for A can never reach B's socket (no cross-route),
      // and a workload whose proxy is down rejects with MeshDisconnectedError → unavailable.
      reply = await server.forward(target.workload, frame);
    } catch (err) {
      // MeshDisconnectedError / MeshTimeoutError → typed capability_unavailable
      // (Invariant E): the proxy's home is down, surface it accurately, never hang. A
      // forward that times out without a close event is itself a "down" signal — stamp the
      // table so this and subsequent reads agree (and re-read the since for this reply).
      this.resolutionTable.markUnavailable(target.workload);
      const detail = err instanceof Error ? err.message : String(err);
      const sinceNow = since ?? this.resolutionTable.healthOf(target.workload).unavailableSince;
      return unavailableResponse(address, `mesh: proxy '${target.workload}' unreachable (${detail})`, sinceNow);
    }

    if (!isFrame(reply, "invoke-result")) {
      return unavailableResponse(address, "mesh: malformed reply (expected invoke-result)");
    }
    // The proxy's outcome verbatim (its InvokeResponse). The primary's bridge re-audits
    // + re-normalizes under the mounted address when folding this into the agent reply.
    return reply.payload;
  }

  // ── PROXY: dial upstream + execute forwarded invokes ───────────────────────────

  private startProxy(): void {
    if (this.client) return;
    const upstream = this.state.config.upstream;
    const url = upstream?.url;
    if (!url) return; // loadConfig already fails fast on a proxy without an upstream
    // M1 — NO SILENT BARE-TOFU. A proxy with no pinned primary key must refuse to start:
    // without it the proxy cannot tell its real primary from a MITM. We fail-closed here
    // (the supervised boot wraps start() so this aborts the tunnel, not the HTTP plane).
    const pinnedPrimaryPubKey = upstream?.primaryPubKey ?? "";
    if (pinnedPrimaryPubKey.length === 0) {
      throw new Error(
        "[plexus] proxy mode requires a pinned upstream.primaryPubKey (M1 — no silent bare-TOFU). " +
          "Set PLEXUS_UPSTREAM_PUBKEY=<primary Ed25519 public key> so the tunnel can be mutually authenticated.",
      );
    }
    const identity = this.meshIdentity();
    const workload = this.state.config.workload ?? "";
    const healthAdvert = this.healthAdvert();
    // The T12 AUTH GATE on the dialer: every (re)connect runs the Ed25519 handshake
    // (enroll on first join + mutual challenge) BEFORE the socket is marked ready, so
    // `forwardInvoke`/`bubbleAudit` never send a frame on an unauthenticated tunnel.
    this.client = new MeshClient({
      url,
      // B7 — trust a `wss://` primary's (possibly self-signed) cert, per-connection (never global).
      ...(this.opts.upstreamTls ? { tls: this.opts.upstreamTls } : {}),
      // HEARTBEAT (networking-resilience §2): proactively detect a half-open tunnel and reconnect.
      heartbeatIntervalMs: MESH_PROXY_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: MESH_PROXY_HEARTBEAT_TIMEOUT_MS,
      onRequest: (f) => this.onProxyInbound(f),
      // HEALTH REPORTING (mesh-health-reporting.md §4): when negotiated, the liveness loop sends a
      // `health` frame built from THIS proxy's aggregated local source health, doubling as the
      // heartbeat (no second timer). Only used when the handshake advert below also activates it.
      ...(healthAdvert
        ? { buildHealthReport: () => this.buildLocalHealthReport(), healthReporter: workload }
        : {}),
      createHandshake: () =>
        createProxyHandshakeDriver({
          workload,
          identity,
          pinnedPrimaryPubKey,
          upstreamUrl: url,
          // The one-time join token is presented ONLY until the first enroll is accepted.
          ...(!this.enrolled && this.opts.joinToken ? { joinToken: this.opts.joinToken } : {}),
          onEnrolled: () => {
            this.enrolled = true;
          },
          // Advertise health reporting so a health-aware primary activates it (mesh-health §2).
          ...(healthAdvert ? { healthReporting: healthAdvert } : {}),
        }),
      // A2 — LIVE CATALOG ASCENT: on EVERY authenticated (re)connect, (re)advertise the
      // proxy's full local catalog so the primary mounts it under `tenant/workload/` with
      // NO in-process mount call. Fires on a challenge-only reconnect too (the directory is
      // rebuilt after any downtime), which `onEnrolled` would miss.
      onAuthenticated: () => this.pushCatalog(),
    });

    // A2 — CATALOG DELTAS: re-push as the proxy's LOCAL capability set changes (a source
    // coming online, an extension (un)registering). The registry's revision-bump fan-out
    // gives us the added/updated/removed ids; we forward them as `entries`/`withdrawn` so
    // the primary's mounted view tracks the proxy without a full re-push. Unhooked in stop().
    this.unsubscribeCatalog = this.state.capabilities.subscribe((change) => {
      this.pushCatalogDelta(change);
      // ON-CHANGE health push (mesh-health-reporting.md §4): a source coming online / going away is
      // the dominant local health flip and bumps the revision — report it immediately (best-effort)
      // rather than waiting out the interval. A no-op when health reporting isn't negotiated.
      this.client?.reportHealthNow();
    });

    // AUDIT BUBBLE-UP (T9 / §3.5 / Invariant D): subscribe to the proxy's single audit
    // write path. Every appended (already-redacted) event gets a COPY bubbled up the tunnel
    // so the primary can hold a full mirror (§7 Q7). The proxy's local log stays
    // authoritative; the bubble is BEST-EFFORT and must NEVER block/delay/fail the invoke
    // hot path (Invariant D) — `bubbleAudit` is fire-and-forget + fully swallowed.
    const audit = this.state.audit as JsonlAuditWriterLike;
    if (typeof audit.setOnAppend === "function") {
      this.unsubscribeAudit = audit.setOnAppend((event) => this.bubbleAudit(event));
    }
  }

  /**
   * PROXY: (re)advertise the FULL local catalog up the tunnel (A2). Fired on every
   * authenticated (re)connect. Pushes only BARE `source.capability` ids — a mounted `/`
   * address (something mounted ONTO this gateway) is NEVER re-advertised: the proxy is
   * workload-agnostic on the wire and the prefix is exclusively the primary's act
   * (Invariant F / §7 Q4). The primary mounts these under the SOCKET-bound workload.
   * BEST-EFFORT + fire-and-forget (mux-acked like `bubbleAudit`): a slow/absent primary
   * never blocks the proxy.
   */
  private pushCatalog(): void {
    const client = this.client;
    if (!client) return; // no tunnel ⇒ nothing to advertise
    const workload = this.state.config.workload ?? "";
    if (!workload) return; // a proxy with no workload claim cannot be mounted
    const entries = this.state.capabilities.all().filter((e) => isBareCapabilityId(e.id));
    const frame = buildCatalogPush(workload, entries, { revision: this.state.capabilities.revision() });
    void client.request(frame).catch(() => {
      /* catalog ascent is best-effort — a down/slow primary never affects the proxy */
    });
  }

  /**
   * PROXY: push a catalog DELTA when the local capability set changes (A2). The registry's
   * change event carries added/updated/removed ids; we resolve the added+updated BARE ids
   * to entries (the `entries` re-push) and forward the removed BARE ids as `withdrawn` so the
   * primary un-mounts them (the only legitimate un-mount path — Risk 1: a transient tunnel
   * drop must NOT unmount). A no-op when nothing bare changed. Same best-effort discipline.
   */
  private pushCatalogDelta(change: EntrySetChange): void {
    const client = this.client;
    if (!client) return;
    const workload = this.state.config.workload ?? "";
    if (!workload) return;
    const entries: CapabilityEntry[] = [];
    for (const id of [...change.added, ...change.updated]) {
      if (!isBareCapabilityId(id)) continue; // never re-advertise a mounted address
      const entry = this.state.capabilities.get(id);
      if (entry) entries.push(entry);
    }
    const withdrawn = change.removed.filter((id) => isBareCapabilityId(id));
    if (entries.length === 0 && withdrawn.length === 0) return;
    const frame = buildCatalogPush(workload, entries, { revision: change.revision, withdrawn });
    void client.request(frame).catch(() => {
      /* best-effort — a down/slow primary never affects the proxy's data plane */
    });
  }

  /**
   * PROXY: bubble ONE audit event up the tunnel (T9). BEST-EFFORT, fire-and-forget: the
   * frame is sent and its reply awaited only to satisfy the mux, then ANY failure (tunnel
   * down, primary slow/absent, reconnect timeout) is swallowed. This runs inside the audit
   * write's append fan-out (itself guarded), and kicks the send off without awaiting — so a
   * bubble can NEVER block, delay, or fail the invoke that produced the event (Invariant D).
   */
  private bubbleAudit(event: AuditEvent): void {
    const client = this.client;
    if (!client) return; // no tunnel ⇒ nothing to bubble (a never-started/stopped proxy)
    const frame: AuditFrame = { t: "audit", corr: newCorr(), payload: event };
    // `void` + `.catch`: detached from the hot path; the reply is the primary's benign ack.
    void client.request(frame).catch(() => {
      /* bubble is best-effort — a down/slow primary never affects the proxy's data plane */
    });
  }

  /**
   * The proxy's tunnel INGRESS (T8). Handles the forwarded `invoke` (the hot path);
   * everything else gets a benign typed result so the mux never hangs.
   *
   * TUNNEL-TRUST (Invariant E): an invoke arriving on the tunnel is treated as
   * ALREADY-AUTHORIZED — the primary is the authority. We run it through the hardened
   * `executeForwardedInvoke` (exposure veto + audit kept; grant/scope/session skipped via
   * the unforgeable tunnel-trust brand).
   */
  private async onProxyInbound(frame: Frame): Promise<Frame> {
    if (isFrame(frame, "health")) {
      // PRIMARY→PROXY health report (mesh-health-reporting.md §4 — bidirectional / cascade). The
      // inbound frame is itself a downward liveness signal (the socket is alive). Record it (a
      // proxy that is itself an upstream can propagate downward) and ack ping-style.
      const validated = validateHealthPayload(frame.payload);
      if (validated) this.primaryHealthReport = validated;
      return { t: "ping", corr: frame.corr, payload: {} };
    }
    if (!isFrame(frame, "invoke")) {
      return {
        t: "invoke-result",
        corr: frame.corr,
        payload: unavailableResponse("", "proxy: only invoke frames are handled"),
      };
    }
    this.lastInvoke = frame.payload; // test/diagnostics seam: the BARE id that arrived.
    const response = await this.executeForwardedInvoke(frame.payload);
    const result: InvokeResultFrame = { t: "invoke-result", corr: frame.corr, payload: response };
    return result;
  }

  /**
   * TUNNEL-TRUST execution of a forwarded invoke (T8). Runs the BARE-id call through the
   * proxy's OWN `InvokePipeline` under a SYNTHETIC TRUSTED context — so the call gets the
   * proxy's real exposure veto (Inv C), schema/health gates, transport routing AND its
   * authoritative local audit event (the same record T9 bubbles upstream), WITHOUT the
   * grant/scope/session gates (Inv E: the primary already authorized). The auth-skip rides
   * the pipeline's module-private brand minted by `mintTunnelTrustContext`; it is reachable
   * ONLY here (the agent HTTP surface cannot forge it). Workflow member fan-out re-enters
   * the SAME pipeline with the SAME branded context, so members are equally tunnel-trusted
   * AND equally exposure-vetoed — uniformly, with no second auth-skip seam.
   *
   * A pre-dispatch DENIAL (unknown capability, source unavailable, or — crucially — a
   * locally-disabled `capability_unexposed`) surfaces from the pipeline as a `PipelineError`;
   * we fold it into an `InvokeResponse`-shaped error so the primary sees the denial as a
   * normal `invoke-result` (never a hang — Inv E), preserving the audited denial's id.
   */
  private async executeForwardedInvoke(payload: InvokeFramePayload): Promise<InvokeResponse> {
    const bareId = payload.id;
    // Gateway-lived (NOT session-scoped) pipeline: built once, reused across forwarded
    // invokes so the tunnel's bridge cache persists and is independent of agent sessions.
    const pipeline = (this.tunnelPipeline ??= new InvokePipeline(this.state));

    // The synthetic trusted context: the brand it carries is the ONLY thing the pipeline
    // honors to skip grant/scope/session. No JWT is minted or verified; the HS256 secret is
    // never touched. Synthetic jti/session/agent are for audit attribution only.
    const ctx = mintTunnelTrustContext({
      jti: MESH_TUNNEL_JTI,
      sessionId: MESH_TUNNEL_SESSION,
      agentId: MESH_TUNNEL_AGENT,
      // Thread the primary's correlationId so the proxy-local audit this execution records
      // (and bubbles up — T9) shares ONE id with the primary's edge-span (mesh §3.5). The
      // mint also stamps `tier:"proxy"` so the record is self-identifying as proxy-tier.
      ...(payload.correlationId ? { correlationId: payload.correlationId } : {}),
    });
    const req: InvokeRequest = {
      id: bareId,
      ...(payload.input !== undefined ? { input: payload.input as Record<string, unknown> } : {}),
    };

    try {
      return await pipeline.invokeById(req, ctx);
    } catch (err) {
      if (err instanceof PipelineError) {
        // Audited pre-dispatch denial (e.g. local exposure veto → capability_unexposed):
        // hand it back as the proxy's verbatim outcome so the primary records the denial.
        return {
          id: err.capabilityId ?? bareId,
          ok: false,
          error: err.body,
          auditId: err.auditId ?? "",
        };
      }
      // Defensive: the pipeline normalizes dispatch failures to InvokeResponse internally,
      // so a throw here is unexpected — surface it typed rather than letting it reject the
      // tunnel request promise (which would read as a hang / disconnect on the primary).
      const detail = err instanceof Error ? err.message : String(err);
      return unavailableResponse(bareId, `proxy: tunnel-trust execution failed (${detail})`);
    }
  }
}

/** Build the mesh runtime for a gateway state (object only — `start()` binds the tunnel). */
export function createMeshRuntime(state: GatewayState, opts: MeshRuntimeOptions = {}): MeshRuntime {
  return new MeshRuntimeImpl(state, opts);
}
