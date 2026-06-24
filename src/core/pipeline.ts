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
 * Schema validation (step 4 in the doc) is a best-effort required-keys check here;
 * full JSON-Schema validation is deferred (the entry's `io.input` is verbatim MCP
 * schema and a full validator is out of t6 scope — noted in the report).
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
} from "../protocol/index.ts";
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

    // 4b. minimal schema gate — required input keys present (best-effort).
    const schemaError = checkRequiredInput(entry, req.input);
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
      throw new PipelineError(
        err("source_unavailable", `No source registered for '${sourceId}'.`, entry.id),
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

/**
 * Best-effort required-input gate. Full JSON-Schema (Draft 2020-12) validation is
 * out of t6 scope (MCP `io.input` is verbatim and a complete validator is a
 * separate concern); this checks the top-level `required` keys are present, which
 * covers the common "missing argument" case deterministically.
 */
function checkRequiredInput(
  entry: CapabilityEntry,
  input: Record<string, unknown> | undefined,
): string | undefined {
  const schema = entry.io?.input;
  if (!schema || typeof schema === "boolean") return undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length === 0) return undefined;
  const provided = input ?? {};
  const missing = required.filter((k) => !(k in provided));
  if (missing.length > 0) {
    return `Missing required input field(s): ${missing.join(", ")}.`;
  }
  return undefined;
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
