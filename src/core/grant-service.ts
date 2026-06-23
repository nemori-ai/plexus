/**
 * Grant service (§4, §4a, §4b, §4c) — the grant→authorizer→token pipeline and the
 * pending-grant tracker, sitting between the endpoint handlers and the stores.
 *
 * Responsibilities:
 *  - run each requested grant through the pluggable `Authorizer` (ADR-007),
 *  - on allow: persist the grant + synthesize workflow transitive scopes (ADR-012),
 *  - mint a scoped-token covering the approved scopes (signToken),
 *  - on pending: track it for `GET /grants/status` resolution (ADR-014),
 *  - refresh: re-mint from the persisted grant, bounded by grant validity (ADR-011),
 *  - revoke: by jti or by (agentId, capabilityId) (ADR-010),
 *  - audit every grant change + token lifecycle event.
 */

import type {
  Authorizer,
  CapabilityEntry,
  CapabilityId,
  GrantRequest,
  GrantResponse,
  GrantPendingResponse,
  GrantStatusResponse,
  ScopedToken,
  TokenScope,
  TransitiveGrant,
  RefreshResponse,
  RevokeResponse,
  GrantVerb,
} from "../protocol/index.ts";
import { randomUUID } from "node:crypto";
import type { GatewayState } from "./state.ts";
import type { Session } from "./sessions.ts";
import { signToken, getInstanceId } from "../auth/index.ts";
import { TOKEN_LIFETIME_MS } from "../auth/index.ts";
import {
  normalizeDecision,
  resolveVerbs,
  synthesizeTransitive,
  GRANT_VALIDITY_MS,
  type PersistedGrant,
} from "./grants.ts";
import { authAdvertisement } from "./well-known.ts";

/** A tracked pending-grant decision (ADR-014 — the `GET /grants/status` channel). */
interface PendingRecord {
  pendingId: string;
  state: "pending" | "approved" | "denied" | "expired";
  sessionId: string;
  agentId: string;
  capabilities: CapabilityId[];
  token?: ScopedToken;
}

export class GrantService {
  private readonly pending = new Map<string, PendingRecord>();

  constructor(
    private readonly state: GatewayState,
    private readonly authorizer: Authorizer,
  ) {}

  /** Resolve the agent identity for a session (audit + grant keying). */
  private agentIdFor(session: Session): string {
    return session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
  }

  /**
   * `PUT /grants`: run each requested grant through the authorizer; mint a token
   * for the approved scopes; track any pending decisions. Returns a `ScopedToken`
   * (possibly with a partial set) or a `GrantPendingResponse`.
   */
  async grant(req: GrantRequest, session: Session): Promise<GrantResponse> {
    const agentId = this.agentIdFor(session);
    const approvedScopes: TokenScope[] = [];
    const transitive: TransitiveGrant[] = [];
    const pendingIds: CapabilityId[] = [];
    const now = Date.now();
    const grantExpiresAt = new Date(now + GRANT_VALIDITY_MS).toISOString();

    for (const [id, rawDecision] of Object.entries(req.grants)) {
      const entry = this.state.capabilities.get(id);
      if (!entry) continue; // unknown id — skip (manifest likely stale)
      const decision = normalizeDecision(rawDecision);

      if (decision.decision === "deny") {
        await this.state.audit.write({
          type: "grant.deny",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          detail: { reason: "explicit deny in grant request" },
        });
        continue;
      }

      const requestedVerbs = resolveVerbs(entry, decision);
      const outcome = await this.authorizer.authorize({
        sessionId: session.id,
        ...(agentId ? { agentId } : {}),
        entry,
        requestedVerbs,
        hasPriorApproval: !!this.state.grants.get(agentId, id),
      });

      if (outcome.outcome === "deny") {
        await this.state.audit.write({
          type: "grant.deny",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          verbs: requestedVerbs,
          detail: { reason: outcome.reason ?? "authorizer denied", policy: this.authorizer.policy },
        });
        continue;
      }

      if (outcome.outcome === "pending") {
        pendingIds.push(id);
        await this.state.audit.write({
          type: "grant.pending",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          verbs: requestedVerbs,
          detail: { reason: outcome.reason ?? "awaiting user decision", policy: this.authorizer.policy },
        });
        continue;
      }

      // allow → the authorizer may narrow the verbs.
      const verbs = (outcome.verbs ?? requestedVerbs) as GrantVerb[];
      this.persistGrant(agentId, entry, verbs, grantExpiresAt);
      approvedScopes.push({ id: entry.id, verbs });
      await this.state.audit.write({
        type: "grant.allow",
        agentId,
        sessionId: session.id,
        capabilityId: entry.id,
        verbs,
        detail: { policy: this.authorizer.policy },
      });

      // Workflow transitive member scopes (ADR-012).
      if (entry.kind === "workflow" && entry.members?.length) {
        const { memberScopes, transitive: tg } = synthesizeTransitive(entry, (mid) =>
          this.state.capabilities.get(mid),
        );
        for (const ms of memberScopes) {
          approvedScopes.push(ms);
          this.persistGrant(agentId, this.state.capabilities.get(ms.id)!, ms.verbs, grantExpiresAt, entry.id);
        }
        if (tg.memberScopes.length) transitive.push(tg);
      }
    }

    // If nothing was approved but something is pending → a pure pending response.
    if (approvedScopes.length === 0 && pendingIds.length > 0) {
      return this.makePending(session, agentId, pendingIds);
    }

    const token = this.mintToken(session, agentId, approvedScopes, grantExpiresAt, transitive);

    if (pendingIds.length > 0) {
      // Partial: some approved (token), some pending.
      const pending = this.makePending(session, agentId, pendingIds);
      pending.partialToken = token;
      return pending;
    }
    return token;
  }

  private persistGrant(
    agentId: string,
    entry: CapabilityEntry,
    verbs: GrantVerb[],
    expiresAt: string,
    synthesizedFor?: CapabilityId,
  ): void {
    const grant: PersistedGrant = {
      agentId,
      capabilityId: entry.id,
      verbs,
      grantedAt: new Date().toISOString(),
      expiresAt,
      ...(synthesizedFor ? { synthesizedFor } : {}),
    };
    this.state.grants.put(grant);
  }

  private mintToken(
    session: Session,
    agentId: string,
    scopes: TokenScope[],
    grantExpiresAt: string,
    transitive: TransitiveGrant[],
  ): ScopedToken {
    const { token, claims } = signToken({
      sub: agentId,
      iss: getInstanceId(),
      sessionId: session.id,
      scopes,
    });
    this.state.sessions.trackJti(session.id, claims.jti);
    void this.state.audit.write({
      type: "token.issue",
      agentId,
      jti: claims.jti,
      sessionId: session.id,
      detail: { scopeCount: scopes.length, grantExpiresAt },
    });
    return {
      token,
      scopes,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      ...(transitive.length ? { transitive } : {}),
    };
  }

  private makePending(session: Session, agentId: string, ids: CapabilityId[]): GrantPendingResponse {
    const pendingId = `pend_${randomUUID()}`;
    this.pending.set(pendingId, {
      pendingId,
      state: "pending",
      sessionId: session.id,
      agentId,
      capabilities: ids,
    });
    const adv = authAdvertisement(this.state.config);
    return {
      status: "grant_pending_user",
      pendingId,
      pending: ids,
      statusUrl: `${adv.grantStatusUrl}?pendingId=${pendingId}`,
    };
  }

  /** `GET /grants/status?pendingId=…`. */
  status(pendingId: string): GrantStatusResponse | undefined {
    const record = this.pending.get(pendingId);
    if (!record) return undefined;
    return {
      pendingId,
      state: record.state,
      capabilities: record.capabilities,
      ...(record.token ? { token: record.token } : {}),
    };
  }

  /**
   * `POST /grants/refresh`: re-mint a fresh token with the SAME scopes from the
   * persisted grant(s), bounded by grant validity (ADR-011). Caller has already
   * verified the presented (possibly just-expired) token's signature + session
   * liveness. The old jti is revoked.
   */
  refresh(
    session: Session,
    agentId: string,
    oldJti: string,
    scopes: TokenScope[],
  ): RefreshResponse | { error: "grant_required" | "token_revoked" } {
    // Re-derive the live scopes from persisted grants; any scope whose grant was
    // removed/expired is dropped. If none survive → refresh fails (re-grant).
    const now = Date.now();
    const liveScopes: TokenScope[] = [];
    let minGrantExpiry = Number.POSITIVE_INFINITY;
    for (const scope of scopes) {
      const grant = this.state.grants.get(agentId, scope.id);
      if (!grant) continue;
      if (Date.parse(grant.expiresAt) <= now) continue;
      minGrantExpiry = Math.min(minGrantExpiry, Date.parse(grant.expiresAt));
      liveScopes.push({
        id: scope.id,
        verbs: grant.verbs,
        ...(grant.synthesizedFor ? { synthesizedFor: grant.synthesizedFor } : {}),
      });
    }
    if (liveScopes.length === 0) {
      return { error: "grant_required" };
    }

    // Revoke the old jti, mint a fresh one.
    this.state.revocation.revoke(oldJti, "refreshed");
    const grantExpiresAt = new Date(minGrantExpiry).toISOString();
    const { token, claims } = signToken({
      sub: agentId,
      iss: getInstanceId(),
      sessionId: session.id,
      scopes: liveScopes,
    });
    this.state.sessions.trackJti(session.id, claims.jti);
    void this.state.audit.write({
      type: "token.refresh",
      agentId,
      jti: claims.jti,
      sessionId: session.id,
      detail: { previousJti: oldJti, scopeCount: liveScopes.length },
    });
    return {
      token,
      scopes: liveScopes,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      grantExpiresAt,
    };
  }

  /**
   * `POST /grants/revoke`: by jti (one token) or by (agentId, capabilityId) (all
   * tokens carrying that scope + remove the persisted grant). Returns the audited
   * result (ADR-010). Since tokens are stateless JWTs we cannot enumerate every
   * outstanding jti for a scope; we revoke the jtis tracked per session for the
   * agent AND remove the grant so refresh can't re-mint.
   */
  async revoke(opts: {
    jti?: string;
    agentId?: string;
    capabilityId?: CapabilityId;
    reason?: string;
  }): Promise<RevokeResponse> {
    const revokedJtis: string[] = [];
    let grantRemoved = false;

    if (opts.jti) {
      this.state.revocation.revoke(opts.jti, opts.reason);
      revokedJtis.push(opts.jti);
      this.state.events.publish({ type: "token_revoked", jti: opts.jti, ...(opts.reason ? { reason: opts.reason } : {}) });
    }

    if (opts.agentId && opts.capabilityId) {
      grantRemoved = this.state.grants.remove(opts.agentId, opts.capabilityId);
      // Revoke every tracked jti issued under the agent's sessions (best-effort
      // enumeration of outstanding tokens — stateless JWTs aren't otherwise listable).
      for (const session of this.state.sessions.all()) {
        const sAgent = session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
        if (sAgent !== opts.agentId) continue;
        for (const jti of session.issuedJtis) {
          if (this.state.revocation.isRevoked(jti)) continue;
          this.state.revocation.revoke(jti, opts.reason ?? "scope revoked");
          revokedJtis.push(jti);
          this.state.events.publish({ type: "token_revoked", jti, ...(opts.reason ? { reason: opts.reason } : {}) });
        }
      }
    }

    const audit = await this.state.audit.write({
      type: "grant.revoke",
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.capabilityId ? { capabilityId: opts.capabilityId } : {}),
      detail: {
        revokedCount: revokedJtis.length,
        grantRemoved,
        ...(opts.jti ? { byJti: true } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    });

    return { ok: revokedJtis.length > 0 || grantRemoved, revokedJtis, grantRemoved, auditId: audit.id };
  }

  /** Lifetime constant (exposed for tests/diagnostics). */
  readonly tokenLifetimeMs = TOKEN_LIFETIME_MS;
}
