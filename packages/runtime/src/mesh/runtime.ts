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
  CapabilityId,
  Frame,
  GatewayMode,
  InvokeFrame,
  InvokeFramePayload,
  InvokeRequest,
  InvokeResponse,
  InvokeResultFrame,
  SourceModule,
  WorkloadName,
} from "@plexus/protocol";

import type { GatewayState } from "../core/state.ts";
import { BaseCapabilityBridge } from "../sources/base.ts";
import { InvokePipeline, PipelineError, mintTunnelTrustContext } from "../core/pipeline.ts";
import type { JsonlAuditWriterLike } from "../audit/index.ts";
import type { MeshForwardTarget, MeshInvokeForwarder } from "../transports/mesh.ts";
import { MeshServer, MeshClient } from "./tunnel.ts";
import { newCorr, isFrame } from "./frames.ts";
import { createEnrollmentRegistry, type EnrollmentRegistry } from "./enrollment.ts";
import { loadOrCreateMeshIdentity, type MeshIdentity } from "./keys.ts";
import { createPrimaryHandshakeDriver, createProxyHandshakeDriver } from "./handshake.ts";
import { ResolutionTable, type ResolutionView } from "./resolution.ts";

/** The synthetic source id every `mesh:<workload>` mounted entry routes its bridge through. */
export const MESH_BRIDGE_SOURCE_ID = "mesh";

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
  /** PRIMARY: the bound tunnel-acceptor port (after `start()`), else `0`. */
  readonly tunnelPort: number;
  /** PRIMARY: whether a proxy tunnel is currently attached. */
  readonly connected: boolean;
  /** PRIMARY: the durable enrollment ledger (the pinned-destination authority). */
  readonly enrollment: EnrollmentRegistry | undefined;
  /**
   * PRIMARY: health-aware resolution view (T10). Reports whether a mounted workload's
   * home (its dialed tunnel) is reachable — read by the health gate + forward boundary so
   * a cap whose proxy is down surfaces a typed `capability_unavailable` + `unavailableSince`
   * (Invariant E), never a hang. On a proxy gateway it stays empty (no mounted caps).
   */
  readonly resolution: ResolutionView;
  /**
   * PROXY: the most recent forwarded invoke payload this proxy received over the
   * tunnel. A diagnostics/test seam proving the BARE id (never the prefix) arrived
   * on the wire (Q4).
   */
  readonly lastForwardedInvoke: InvokeFramePayload | undefined;
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

  get connected(): boolean {
    return this.server?.connected ?? false;
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

  async start(): Promise<void> {
    if (this.mode === "primary") this.startPrimary();
    else this.startProxy();
  }

  stop(): void {
    this.server?.stop();
    this.server = undefined;
    this.unsubscribeAudit?.();
    this.unsubscribeAudit = undefined;
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
    // The second routable listener (ephemeral port). The proxy DIALS this; the primary
    // FORWARDS down it. The T12 AUTH GATE (`createHandshake`) fronts every accepted
    // socket: it runs the LIVE enroll `admit()` (H1) + the Ed25519 mutual challenge, and
    // ONLY a socket that proves the LEDGER-pinned proxy key is promoted to carry frames.
    // Until then no `invoke`/`audit`/`catalog` frame reaches `onPrimaryInbound` (an
    // unauthenticated/unenrolled socket can neither invoke nor push — fail-closed).
    this.server = new MeshServer({
      onRequest: (f) => this.onPrimaryInbound(f),
      createHandshake: () =>
        createPrimaryHandshakeDriver({
          identity,
          // H1 — wire the enrollment admission into the LIVE connect path.
          admit: (req) => reg.admit(req, identity),
          pinnedProxyPubKeyFor: (workload) => this.pinnedProxyPubKeyFor(workload),
        }),
      // T10 — RESOLUTION HEALTH: a workload's mounted caps become reachable on
      // authenticated-socket promotion and unreachable (stamped) on drop/close/teardown.
      // (Invariant B: this changes the RESOLUTION, never the address or its grants.)
      onConnect: (workload) => this.resolutionTable.markAvailable(workload),
      onDisconnect: (workload) => this.resolutionTable.markUnavailable(workload),
    });
    this.server.start();
  }

  /** The proxy pubkey pinned for an ACTIVE enrollment of `workload`, else undefined (T12). */
  private pinnedProxyPubKeyFor(workload: WorkloadName): string | undefined {
    const rec = this.enrollmentReg?.get(workload);
    return rec && rec.status === "active" ? rec.pinnedProxyPubKey : undefined;
  }

  /**
   * Frames a proxy sends UP the tunnel. The primary keeps liveness sane (echo a `ping`)
   * and MIRRORS audit bubbles (T9): an `audit` frame carries the proxy's authoritative,
   * already-redacted local event; we re-write it through the primary's OWN audit writer
   * (same redactor — the mirror never reveals more than the proxy's local log, §7 Q7),
   * stamping `tier:"proxy"` + the originating workload, then ACK so the proxy's bubble
   * resolves. Anything else gets a typed no-op result so a stray frame can never wedge the
   * mux. (Catalog ascent is T10.)
   *
   * NOTE (T12): a frame only reaches here on an ALREADY-AUTHENTICATED socket — the
   * connection-auth gate promotes a socket to the mux only after the Ed25519 handshake.
   * `enroll` is consumed by that gate's LIVE `admit()` (H1), not here; an `enroll` frame
   * arriving post-auth is therefore unexpected and gets the benign default below.
   */
  private onPrimaryInbound(frame: Frame): Frame {
    if (isFrame(frame, "ping")) return { t: "ping", corr: frame.corr, payload: {} };
    if (isFrame(frame, "audit")) {
      // BEST-EFFORT mirror (Invariant D): fire-and-forget the write, then ACK immediately.
      // A mirror-write failure must never delay the ack or wedge the proxy's ascent.
      this.mirrorProxyAudit(frame.payload);
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
  private mirrorProxyAudit(event: AuditEvent): void {
    const workload = this.originatingWorkload();
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
   * The workload identity to attribute a bubbled audit to. T9 is single-proxy (one attached
   * tunnel): the originating workload is the sole ACTIVE enrollment, derived from the
   * authenticated ledger rather than trusted from the wire (a proxy cannot claim another
   * workload's events). T10 generalizes this to per-connection identity once the primary
   * fans out to many proxies. Undefined when the mapping is ambiguous (0 or >1 active).
   */
  private originatingWorkload(): WorkloadName | undefined {
    // Prefer the identity bound to the AUTHENTICATED socket (T12) — the bubble provably
    // came from that mutually-authenticated proxy, not merely "the sole active record".
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
      reply = await server.forward(frame);
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
    // The T12 AUTH GATE on the dialer: every (re)connect runs the Ed25519 handshake
    // (enroll on first join + mutual challenge) BEFORE the socket is marked ready, so
    // `forwardInvoke`/`bubbleAudit` never send a frame on an unauthenticated tunnel.
    this.client = new MeshClient({
      url,
      onRequest: (f) => this.onProxyInbound(f),
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
        }),
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
