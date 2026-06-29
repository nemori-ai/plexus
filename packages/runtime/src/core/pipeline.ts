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
} from "@plexus/protocol";
import type { GatewayState } from "./state.ts";
import { deriveSource } from "./registry-helpers.ts";
import { scopesCover } from "./scope.ts";
import { constraintSatisfied } from "./constraint.ts";

function err(code: ErrorCode, message: string, capabilityId?: CapabilityId): ErrorBody {
  return { code, message, ...(capabilityId ? { capabilityId } : {}) };
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
  ): Promise<PipelineError> {
    const audit = await this.state.audit.write({
      type: "invoke",
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      jti: ctx.jti,
      sessionId: ctx.sessionId,
      capabilityId,
      verbs: [...verbs] as never,
      outcome: "denied",
      detail: { code: body.code, reason: body.message, ...(extraDetail ?? {}) },
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
      );
    }

    // 2. session liveness (review #8) — re-checked on every (member) dispatch.
    const liveness = this.state.sessions.liveness(ctx.sessionId);
    if (!liveness.live) {
      throw await this.denyAudit(
        err("session_expired", liveness.reason ?? "session is not live", req.id),
        ctx,
        entry.id,
        entry.grants,
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
      );
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
      );
    }

    // 5b. HEALTH reconciliation: if the source's cached health is "unavailable",
    //     fail FAST with the SEMANTIC `source_unavailable` code carrying the precise
    //     health detail (e.g. "`claude` not on PATH") — so the agent gets a precise,
    //     semantic reason rather than an opaque transport 500. Cached + advisory: a
    //     stale "ok" still dispatches (and a real transport failure maps as before);
    //     this only short-circuits when the gateway already KNOWS the source is down.
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
      );
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
        capabilityId: entry.id,
        verbs: entry.grants,
        outcome: "error",
        detail: { transport: entry.transport, error: message },
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
