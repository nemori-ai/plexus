/**
 * The uniform invoke pipeline (§5 invocation, ADR-012/013, review #3/#6/#8).
 *
 * ONE path for every call — top-level invoke AND workflow member fan-out. The
 * gateway core NEVER branches on `kind:"workflow"`: a workflow entry routes to the
 * `workflow` transport via its bridge, which re-enters THIS pipeline per member
 * through `invokeById` (handed in via `BridgeDeps`). Each member dispatch is
 * therefore scope-checked + liveness-checked + revocation-checked + audited
 * through the same code, with no silent escalation.
 *
 * Pre-dispatch checks (in order), per the protocol §5 invoke contract:
 *   1. entry exists (unknown_capability)
 *   2. session live (session_expired) — review #8
 *   3. jti not revoked (token_revoked) — re-checked before EACH member, review #3
 *   4. scope covers id + every required verb (grant_required)
 *   5. route to the owning CapabilityBridge → Transport (registry-driven)
 *   6. audit (redacted) + normalized InvokeResponse
 *
 * Schema validation (step 4 in the doc) honors the entry's published `io.input`
 * contract: every `required` key must be present, each PROVIDED property whose
 * schema declares a primitive `type` must match it, and — only when the schema
 * explicitly sets `additionalProperties:false` — unknown top-level keys are
 * rejected. Deliberately minimal (no nested recursion, formats, or $ref); this is
 * contract-honoring hygiene, not a JSON-Schema engine. See `validateInput`.
 */

import type {
  InvokeRequest,
  InvokeResponse,
  InvokeContext,
  CapabilityEntry,
  CapabilityId,
  CapabilityBridge,
  BridgeDeps,
  ErrorBody,
  ErrorCode,
  TokenScope,
  JsonSchema,
  GatewayMode,
} from "@plexus/protocol";
import type { GatewayState } from "./state.ts";
import { deriveSource } from "./registry-helpers.ts";
import { scopesCover } from "./scope.ts";
import { constraintSatisfied } from "./constraint.ts";

function err(code: ErrorCode, message: string, capabilityId?: CapabilityId): ErrorBody {
  return { code, message, ...(capabilityId ? { capabilityId } : {}) };
}

/**
 * The cross-tier audit-linkage fields carried by an `InvokeContext` (mesh §3.5): the
 * shared `correlationId` (threads the primary edge-span to the proxy workload-span) and
 * the recording `tier` (`"proxy"` on a tunnel-trusted forward). Both are absent on a
 * single-gateway/agent-facing invoke, so this spreads to nothing there — no behavior
 * change off the mesh. Applied to EVERY audit write so denials and errors bubble + thread
 * exactly like the success record.
 */
function auditLinkage(ctx: InvokeContext): { correlationId?: string; tier?: GatewayMode } {
  return {
    ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...(ctx.tier ? { tier: ctx.tier } : {}),
  };
}

// ── TUNNEL-TRUST INGRESS (T8 — federated-mesh §3.4, Invariant E) ────────────────────
//
// THE TRUST BOUNDARY. There are exactly two proofs that satisfy this pipeline's "every
// invoke is authorized" invariant:
//   ① agent ↔ primary — an HS256 scoped-token (verified in the /invoke HTTP handler),
//      which yields a context carrying real `scopes`. This is the DEFAULT path.
//   ② primary ↔ proxy — the Ed25519 mutually-authenticated mesh tunnel. An `invoke`
//      frame arriving on that tunnel is ALREADY authorized (authority terminated at the
//      primary — Inv E); the proxy must NOT re-decide the grant. This is the tunnel path.
//
// The tunnel path is the ONE guarded auth-skip in the pipeline. It is gated on a
// MODULE-PRIVATE symbol brand (`TUNNEL_TRUST`) that is NEVER exported: the only way to
// obtain a branded context is `mintTunnelTrustContext`, whose sole caller is the proxy's
// tunnel ingress (`mesh/runtime.ts`). The agent-facing HTTP /invoke handler builds its
// context from JWT claims (a plain object — no symbol key), so it can NEVER forge the
// brand. Even code that imports `mintTunnelTrustContext` cannot fabricate the brand by
// hand (the symbol is unreachable), and a JSON `invoke` frame off the wire cannot carry a
// JS symbol at all. ⇒ the skip is provably reachable ONLY for calls that entered over the
// authenticated tunnel.
//
// What the skip does NOT do: it does NOT mint/verify a JWT, does NOT read the HS256 secret,
// and does NOT widen past grant/scope/session. The LOCAL exposure veto (Inv C) and the
// schema/health contract gates STILL run on the tunnel path — join/forward ≠ access.
const TUNNEL_TRUST: unique symbol = Symbol("plexus.mesh.tunnel-trust");

/** An InvokeContext provably minted by the proxy's tunnel ingress (carries the brand). */
export interface TunnelTrustContext extends InvokeContext {
  readonly [TUNNEL_TRUST]: true;
}

/**
 * Mint the synthetic trusted context for an invoke that arrived over the authenticated
 * mesh tunnel (T8). The returned context carries the module-private `TUNNEL_TRUST` brand —
 * the ONLY signal `invokeById` honors to skip the grant/scope/session gates (Inv E:
 * authority already terminated at the primary). `scopes` is empty by construction: a
 * tunnel-trusted call is authorized by the tunnel, not by token scopes, and the scope gate
 * is skipped for it — so there is no scope to carry. Synthetic `jti`/`sessionId`/`agentId`
 * exist ONLY for audit attribution (they are never re-verified). Callable only by holders of
 * a reference to this function; the proxy tunnel ingress is the sole caller.
 */
export function mintTunnelTrustContext(fields: {
  jti: string;
  sessionId: string;
  agentId?: string;
  /** Threads the primary's edge-span to this proxy workload-span (mesh §3.5 CorrelationId). */
  correlationId?: string;
}): TunnelTrustContext {
  return {
    jti: fields.jti,
    sessionId: fields.sessionId,
    ...(fields.agentId ? { agentId: fields.agentId } : {}),
    scopes: [],
    // A tunnel-trusted execution is, by construction, recorded at the PROXY tier (the
    // resource-owning gateway). Every audit event it emits is stamped `tier:"proxy"` +
    // (when threaded) the shared `correlationId`, so the proxy's authoritative local log
    // is self-identifying when T9 bubbles a copy up to the primary's mirror (mesh §3.5).
    tier: "proxy",
    ...(fields.correlationId ? { correlationId: fields.correlationId } : {}),
    [TUNNEL_TRUST]: true,
  };
}

/**
 * True iff `ctx` provably entered over the authenticated mesh tunnel — i.e. it carries the
 * module-private brand placed ONLY by `mintTunnelTrustContext`. Any other context (notably
 * one built from JWT claims on the agent HTTP surface) is false ⇒ fully authorized as usual.
 */
function isTunnelTrusted(ctx: InvokeContext): boolean {
  return (ctx as Partial<TunnelTrustContext>)[TUNNEL_TRUST] === true;
}

/**
 * A pipeline error carrying a closed ErrorCode the handler maps to a status.
 *
 * Carries the `capabilityId` the denial concerns and, when the denial was AUDITED
 * (every pre-dispatch denial is — see `denyAudit`), the `auditId` of that audit
 * event. The /invoke handler folds both into the uniform `InvokeResponse`-shaped
 * denial body (tp2 / ADR-017) so an agent has ONE result contract on /invoke.
 */
export class PipelineError extends Error {
  /** The capability id this denial concerns (mirrors `body.capabilityId` when present). */
  readonly capabilityId?: CapabilityId;
  /** The audit event id recording this denial, when it was audited. */
  readonly auditId?: string;
  constructor(readonly body: ErrorBody, opts?: { capabilityId?: CapabilityId; auditId?: string }) {
    super(body.message);
    this.name = "PipelineError";
    if (opts?.capabilityId ?? body.capabilityId) {
      this.capabilityId = opts?.capabilityId ?? body.capabilityId;
    }
    if (opts?.auditId) this.auditId = opts.auditId;
  }
}

/**
 * The invoke pipeline. Owns a per-(session × source) bridge cache so a source's
 * bridge is built once per session and reused across that session's invokes.
 */
export class InvokePipeline {
  /** sessionId → (sourceId → bridge). */
  private readonly bridges = new Map<string, Map<string, CapabilityBridge>>();

  constructor(private readonly state: GatewayState) {}

  /**
   * Build (or reuse) the bridge for a (session × source). The `BridgeDeps` close
   * over THIS pipeline's `invokeById` so the workflow transport re-enters uniformly.
   */
  private bridgeFor(sourceId: string, sessionId: string): CapabilityBridge | undefined {
    const module = this.state.sources.get(sourceId);
    if (!module) return undefined;

    let perSession = this.bridges.get(sessionId);
    if (!perSession) {
      perSession = new Map();
      this.bridges.set(sessionId, perSession);
    }
    const existing = perSession.get(sourceId);
    if (existing) return existing;

    const deps: BridgeDeps = {
      audit: (event) => this.state.audit.write(event),
      getTransport: (kind) => this.state.sources.getTransport(kind),
      getEntry: (id) => this.state.capabilities.get(id),
      invokeById: (req, ctx) => this.invokeById(req, ctx),
    };
    const bridge = module.createBridge(deps, sessionId);
    perSession.set(sourceId, bridge);
    return bridge;
  }

  /** Drop a session's cached bridges (disconnect on session invalidation/expiry). */
  async disposeSession(sessionId: string): Promise<void> {
    const perSession = this.bridges.get(sessionId);
    if (!perSession) return;
    for (const bridge of perSession.values()) {
      try {
        await bridge.disconnect();
      } catch {
        /* idempotent teardown */
      }
    }
    this.bridges.delete(sessionId);
  }

  /**
   * Audit a pre-dispatch DENIAL (outcome="denied") then throw the PipelineError.
   * Every invoke attempt — including failed authorization, revoked-token reuse,
   * and default-deny denials — MUST leave an audit trail (§7, ADR-009): an
   * attacker probing for access cannot do so silently. Fired for both top-level
   * invokes AND per-member workflow dispatches (so a mid-fan-out denial is logged).
   */
  private async denyAudit(
    body: ErrorBody,
    ctx: InvokeContext,
    capabilityId: CapabilityId,
    verbs: readonly string[] = [],
    extraDetail?: Record<string, unknown>,
    input?: unknown,
  ): Promise<PipelineError> {
    const audit = await this.state.audit.write({
      type: "invoke",
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      // Cross-tier audit linkage (mesh §3.5): a tunnel-trusted (proxy-tier) denial carries
      // the shared correlationId + tier so its mirror threads to the primary's edge-span.
      ...auditLinkage(ctx),
      capabilityId,
      verbs: [...verbs] as never,
      outcome: "denied",
      detail: { code: body.code, reason: body.message, ...(extraDetail ?? {}) },
      // Capture the REQUEST args (redacted+truncated by the writer) so the Activity
      // view can show what was attempted; the denial's "result" is the error the
      // agent receives. Both surface through GET /admin/api/audit.
      ...(input !== undefined ? { input } : {}),
      output: { error: { code: body.code, message: body.message } },
    });
    // Carry the audited denial's id + capabilityId so the /invoke handler can fold
    // them into the uniform InvokeResponse-shaped denial body (tp2 / ADR-017).
    return new PipelineError(body, { capabilityId, auditId: audit.id });
  }

  /**
   * THE re-entrant uniform invoke. Called for the top-level invoke AND by the
   * workflow transport per member. Enforces all pre-dispatch checks, routes to the
   * bridge, audits, and normalizes the result. Throws `PipelineError` (closed code)
   * on a pre-dispatch failure; resolves to an `InvokeResponse` (possibly ok:false)
   * for a dispatch-level failure.
   */
  async invokeById(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse> {
    const entry = this.state.capabilities.get(req.id);
    if (!entry) {
      throw await this.denyAudit(
        err("unknown_capability", `No such capability '${req.id}'.`, req.id),
        ctx,
        req.id,
        [],
        undefined,
        req.input,
      );
    }

    // TUNNEL-TRUST (T8 — federated-mesh §3.4, Inv E): an invoke that provably arrived over
    // the authenticated Ed25519 tunnel is ALREADY authorized — the primary terminated
    // authority and the proxy must NOT re-decide the grant. For such a call we SKIP the
    // grant/scope/session gates (steps 2/3/4 below) — and ONLY those. The exposure veto
    // (1b), schema (4b), routing/health (5/5b) and audit all still run: exposure is
    // evaluated at the resource-owning gateway (Inv C — a locally-disabled cap is denied
    // even via the tunnel), and the contract gates are not authorization decisions. The
    // brand is unforgeable from the agent HTTP surface (see `isTunnelTrusted` / the
    // TUNNEL_TRUST note above), so this skip is reachable ONLY for tunnel-origin calls.
    const tunnelTrusted = isTunnelTrusted(ctx);

    // 1b. EXPOSURE intersection (the security crux): a top-level-DISABLED capability is
    //     DENIED here even when the agent ALREADY HOLDS a valid standing token for it —
    //     effective access = granted ∧ exposed. Checked BEFORE scope/grant so it gates
    //     regardless of token validity, and BEFORE dispatch so the source is never
    //     reached. The standing grant RECORD is untouched (re-enabling restores access);
    //     this is an intersection, not a revocation. Applies to workflow MEMBERS too (a
    //     disabled member denies even when the workflow is exposed). Audited via denyAudit.
    //     ALSO enforced on the tunnel path (deliberately NOT skipped): join/forward ≠ access.
    if (this.state.exposure?.isDisabled(entry.id)) {
      throw await this.denyAudit(
        err(
          "capability_unexposed",
          `Capability '${entry.id}' is disabled at the top level (not exposed).`,
          entry.id,
        ),
        ctx,
        entry.id,
        entry.grants,
        { exposure: "disabled" },
        req.input,
      );
    }

    // ── GRANT/SCOPE/SESSION GATES (steps 2–4) — SKIPPED on the tunnel path (Inv E) ──
    // These are the agent↔primary authorization gates. A tunnel-trusted call already
    // cleared them at the primary; re-running them on the proxy would be the proxy
    // re-deciding a grant (forbidden). They run for EVERY non-tunnel (agent-facing) call.
    if (!tunnelTrusted) {
      // 2. session liveness (review #8) — re-checked on every (member) dispatch.
      const liveness = this.state.sessions.liveness(ctx.sessionId);
      if (!liveness.live) {
        throw await this.denyAudit(
          err("session_expired", liveness.reason ?? "session is not live", req.id),
          ctx,
          entry.id,
          entry.grants,
          undefined,
          req.input,
        );
      }

      // 3. jti revocation — re-checked before EACH dispatch (review #3) so a
      //    mid-fan-out revoke halts remaining workflow members.
      if (this.state.revocation.isRevoked(ctx.jti)) {
        throw await this.denyAudit(
          err("token_revoked", "token has been revoked", req.id),
          ctx,
          entry.id,
          entry.grants,
          undefined,
          req.input,
        );
      }

      // 4. scope coverage — every required verb must be granted (default-deny).
      //    A scope CONSTRAINT (AUTHZ-UX §3.2) is enforced here: pass the call `input` so a
      //    constrained scope is INERT for an out-of-constraint call. On a miss the existing
      //    `grant_required` denial fires; when the miss was caused by a constraint (the
      //    scope matched id+verbs but its constraint failed) the audit detail records
      //    `constraintMiss:true` so out-of-scope probes are visible in the trail.
      if (!scopesCover(ctx.scopes, entry, req.input)) {
        const constraintMiss = scopeConstraintMissed(ctx.scopes, entry, req.input);
        throw await this.denyAudit(
          err(
            "grant_required",
            `No grant for ${entry.id} (${entry.grants.join(", ") || "none"}).`,
            entry.id,
          ),
          ctx,
          entry.id,
          entry.grants,
          constraintMiss ? { constraintMiss: true } : undefined,
          req.input,
        );
      }
    }

    // 4b. minimal schema gate — honor the entry's published `io.input` contract
    //     (required keys present + primitive-type match + opt-in additionalProperties).
    const schemaError = validateInput(entry.io?.input, req.input);
    if (schemaError) {
      throw await this.denyAudit(
        err("schema_validation_failed", schemaError, entry.id),
        ctx,
        entry.id,
        entry.grants,
        undefined,
        req.input,
      );
    }

    // 5. route to the owning bridge (registry-driven — NO `if (id===…)`).
    const sourceId = entry.source || deriveSource(entry.id);
    const bridge = this.bridgeFor(sourceId, ctx.sessionId);
    if (!bridge) {
      throw await this.denyAudit(
        err("source_unavailable", `No source registered for '${sourceId}'.`, entry.id),
        ctx,
        entry.id,
        entry.grants,
        undefined,
        req.input,
      );
    }

    // 5b. HEALTH reconciliation: fail FAST on a KNOWN-down home rather than dispatching
    //     into a hang. MESH (T10 / Invariant E) and LOCAL sources are distinct homes:
    //
    //   • MESH-mounted cap — its home is a remote workload reached over its dialed tunnel.
    //     Consult the ResolutionTable (the primary's health-aware resolution) so a cap whose
    //     proxy socket is DOWN surfaces a typed `capability_unavailable` + `unavailableSince`
    //     UP FRONT — the SAME signal the forward boundary returns on a mid-flight drop, made
    //     consistent so the agent sees the cap unavailable before any forward is attempted
    //     (no replica/failover; one home, accurate signal, never a hang).
    //
    //   • LOCAL source — the SEMANTIC `source_unavailable` code carrying the precise health
    //     detail (e.g. "`claude` not on PATH"). Cached + advisory: a stale "ok" still
    //     dispatches; this only short-circuits when the gateway already KNOWS it is down.
    if (entry.transport === "mesh") {
      const route = this.state.capabilities.forwardAddress?.(entry.id);
      const mountHealth = route ? this.state.mesh?.resolution.healthOf(route.workload) : undefined;
      if (mountHealth?.status === "unavailable") {
        const body: ErrorBody = {
          code: "capability_unavailable",
          message: `Capability '${entry.id}' is unavailable: its home (workload '${route!.workload}') is unreachable.`,
          capabilityId: entry.id,
          ...(mountHealth.unavailableSince ? { unavailableSince: mountHealth.unavailableSince } : {}),
        };
        throw await this.denyAudit(
          body,
          ctx,
          entry.id,
          entry.grants,
          { workload: route!.workload, ...(mountHealth.unavailableSince ? { unavailableSince: mountHealth.unavailableSince } : {}) },
          req.input,
        );
      }
    } else {
      const health =
        typeof this.state.capabilities.healthOf === "function"
          ? this.state.capabilities.healthOf(sourceId)
          : undefined;
      if (health?.status === "unavailable") {
        throw await this.denyAudit(
          err(
            "source_unavailable",
            `Source '${sourceId}' is unavailable${health.detail ? `: ${health.detail}` : ""}.`,
            entry.id,
          ),
          ctx,
          entry.id,
          entry.grants,
          { source: sourceId, ...(health.detail ? { healthDetail: health.detail } : {}) },
          req.input,
        );
      }
    }

    // The bridge MUST audit the invocation itself (per the contract). The pipeline
    // does not double-audit dispatch; it audits denials/pre-checks at the edge.
    try {
      const response = await bridge.invoke(req, ctx);
      return response;
    } catch (e) {
      // A transport-level throw → normalized error response + audit.
      const message = e instanceof Error ? e.message : String(e);
      const audit = await this.state.audit.write({
        type: "invoke",
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        jti: ctx.jti,
        sessionId: ctx.sessionId,
        ...auditLinkage(ctx),
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { transport: entry.transport, error: message },
        input: req.input,
        output: { error: { code: "transport_error", message } },
      });
      return {
        id: entry.id,
        ok: false,
        error: err("transport_error", message, entry.id),
        auditId: audit.id,
      };
    }
  }
}

/** The closed set of primitive JSON-Schema `type`s we enforce. */
type PrimitiveType = "string" | "number" | "integer" | "boolean" | "object" | "array";

/**
 * Lightweight, central `io.input` gate. Given an entry's published `io.input`
 * JSON-Schema-ish object + the request input, this honors the contract WITHOUT
 * pulling in a full JSON-Schema engine. Strictly minimal by design:
 *
 *   1. every `required` key must be PRESENT in the input;
 *   2. each PROVIDED property whose schema declares a recognised primitive `type`
 *      must match it (basic typeof / Array.isArray; integer = number &&
 *      Number.isInteger). Lenient on an absent or unrecognised `type`.
 *   3. ONLY when the schema explicitly sets `additionalProperties:false` are
 *      unknown top-level keys rejected. By default extras are allowed (rejecting
 *      unknown keys by default would break existing callers).
 *
 * Entries with no `io.input`, or with neither `properties` nor `required`, pass
 * through unchanged. NO nested-schema recursion, NO formats, NO $ref. Returns a
 * human-readable error string naming the offending key, or `undefined` if valid.
 */
export function validateInput(
  schema: JsonSchema | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  // Boolean schemas (`true`/`false`) and absent schemas: nothing to enforce here.
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as {
    properties?: Record<string, unknown>;
    required?: unknown;
    additionalProperties?: unknown;
  };
  const properties =
    s.properties && typeof s.properties === "object" ? s.properties : undefined;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  // Nothing declared to enforce ⇒ pass through unchanged.
  if (!properties && required.length === 0) return undefined;

  const provided = input ?? {};

  // (1) required keys present.
  const missing = required.filter((k) => !(k in provided));
  if (missing.length > 0) {
    return `Missing required input field(s): ${missing.join(", ")}.`;
  }

  // (2) primitive type of each PROVIDED, schema-described property.
  if (properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!(key in provided)) continue; // only validate provided props
      if (!propSchema || typeof propSchema !== "object") continue; // boolean/absent prop schema
      const declared = (propSchema as { type?: unknown }).type;
      if (typeof declared !== "string") continue; // lenient on absent/union type
      const mismatch = primitiveMismatch(declared as PrimitiveType, provided[key]);
      if (mismatch) {
        return `Input field '${key}' must be a ${declared} (${mismatch}).`;
      }
    }
  }

  // (3) opt-in additionalProperties:false ⇒ reject unknown top-level keys.
  if (s.additionalProperties === false && properties) {
    const known = new Set(Object.keys(properties));
    const unknownKey = Object.keys(provided).find((k) => !known.has(k));
    if (unknownKey !== undefined) {
      return `Unknown input field '${unknownKey}' (additionalProperties:false).`;
    }
  }

  return undefined;
}

/**
 * Returns a short reason string iff `value` does NOT satisfy the declared
 * primitive `type`, else `undefined`. Unrecognised types are lenient (pass).
 */
function primitiveMismatch(type: PrimitiveType, value: unknown): string | undefined {
  switch (type) {
    case "string":
      return typeof value === "string" ? undefined : `got ${typeName(value)}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `got ${typeName(value)}`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? undefined
        : `got ${typeName(value)}`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `got ${typeName(value)}`;
    case "array":
      return Array.isArray(value) ? undefined : `got ${typeName(value)}`;
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? undefined
        : `got ${typeName(value)}`;
    default:
      return undefined; // unrecognised type ⇒ lenient
  }
}

/** Friendly runtime type name for an error message (array/null distinguished). */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Diagnostic (AUTHZ-UX §3.2): true iff coverage failed BECAUSE a constraint made an
 * otherwise-matching scope inert — i.e. some scope matches the entry id AND carries a
 * constraint the call `input` fails. Used only to flag `constraintMiss:true` in the
 * denial audit; it never changes the decision (`scopesCover` already denied).
 */
function scopeConstraintMissed(
  scopes: TokenScope[],
  entry: CapabilityEntry,
  input: Record<string, unknown> | undefined,
): boolean {
  return scopes.some(
    (s) => s.id === entry.id && !!s.constraint && !constraintSatisfied(s.constraint, input ?? {}),
  );
}
