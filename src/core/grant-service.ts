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
  SourceId,
  ExtensionRegisterResponse,
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

/** The two kinds of thing a human approves: a deferred grant, or an extension register. */
export type PendingKind = "grant" | "register";

/**
 * A pending GRANT request awaiting a human decision (ADR-014 — the `GET /grants/status`
 * channel). On approval the recorded scopes are persisted + a token minted into the
 * record; the polling agent collects it.
 */
interface PendingGrantRecord {
  pendingId: string;
  kind: "grant";
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  sessionId: string;
  agentId: string;
  capabilities: CapabilityId[];
  /** The scopes the user is approving, captured at request time (id → verbs). */
  scopes: TokenScope[];
  /** Workflow ids among `scopes` whose transitive members must be synthesized on approve. */
  workflowIds: CapabilityId[];
  /** Human-facing risk reasons surfaced in the approval UI. */
  reasons: string[];
  token?: ScopedToken;
}

/**
 * A pending EXTENSION REGISTRATION awaiting a human decision (m4sec-auth register-confirm).
 * An UNAPPROVED register does NOT activate the extension; commit (`registerExtension`)
 * runs ONLY after a human approves. Carries the SECURITY-SENSITIVE surface (cli bins /
 * rest hosts / cross-source attaches / verbs) the user is approving.
 */
interface PendingRegisterRecord {
  pendingId: string;
  kind: "register";
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  sessionId: string;
  source: SourceId;
  /** The full register surface the user is approving (security-sensitive details). */
  surface: RegisterApprovalSurface;
  /** Run on approval: actually commit the registration. Returns the register response. */
  commit: () => Promise<ExtensionRegisterResponse>;
  result?: ExtensionRegisterResponse;
}

type PendingRecord = PendingGrantRecord | PendingRegisterRecord;

/** The security-sensitive detail of a pending registration, for the approval UI. */
export interface RegisterApprovalSurface {
  source: SourceId;
  label: string;
  /** Each capability the extension contributes + the verbs it would require. */
  capabilities: { id: string; label: string; kind: string; transport: string; verbs: GrantVerb[] }[];
  /** cli binaries the extension wants to spawn (security-sensitive). */
  cliBins: string[];
  /** non-loopback rest hosts the extension wants to reach (security-sensitive). */
  restHosts: string[];
  /** Cross-source skill attaches (workflow/skill → foreign source). */
  crossSource: { id: string; sources: SourceId[] }[];
  /** Whether the extension uses a transport-backed (cli/local-rest/stdio/ipc) capability. */
  transportBacked: boolean;
}

/** A pending item projected for the admin approval panel (union of both kinds). */
export interface PendingView {
  pendingId: string;
  kind: PendingKind;
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  /** For grants: the agent requesting. */
  agentId?: string;
  /** For grants: the capability ids + their requested scopes + risk reasons. */
  capabilities?: CapabilityId[];
  scopes?: TokenScope[];
  reasons?: string[];
  /** For registers: the security-sensitive surface. */
  register?: RegisterApprovalSurface;
}

export class GrantService {
  /**
   * The pending store is PROCESS-WIDE (static) so the protocol-endpoint GrantService
   * and the admin GrantService — distinct instances over the same GatewayState — share
   * ONE source of truth for what awaits a human. The agent PUTs a grant through the
   * protocol instance (pending), and the user approves it through the admin instance;
   * both must see the same record. Keyed by GatewayState so parallel test gateways
   * don't cross-talk.
   */
  private get pending(): Map<string, PendingRecord> {
    let map = GrantService.pendingByState.get(this.state);
    if (!map) {
      map = new Map<string, PendingRecord>();
      GrantService.pendingByState.set(this.state, map);
    }
    return map;
  }
  private static readonly pendingByState = new WeakMap<GatewayState, Map<string, PendingRecord>>();

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
    const pendingScopes: TokenScope[] = [];
    const pendingReasons: string[] = [];
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
        // Capture the EXACT scope the user is approving so approval mints precisely
        // what was requested (no re-derivation drift). The authorizer never widens.
        pendingScopes.push({ id: entry.id, verbs: requestedVerbs });
        if (outcome.reason) pendingReasons.push(outcome.reason);
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
      return this.makePending(session, agentId, pendingIds, pendingScopes, pendingReasons);
    }

    const token = this.mintToken(session, agentId, approvedScopes, grantExpiresAt, transitive);

    if (pendingIds.length > 0) {
      // Partial: some approved (token), some pending.
      const pending = this.makePending(session, agentId, pendingIds, pendingScopes, pendingReasons);
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

  private makePending(
    session: Session,
    agentId: string,
    ids: CapabilityId[],
    scopes: TokenScope[],
    reasons: string[],
  ): GrantPendingResponse {
    const pendingId = `pend_${randomUUID()}`;
    const record: PendingGrantRecord = {
      pendingId,
      kind: "grant",
      state: "pending",
      createdAt: new Date().toISOString(),
      sessionId: session.id,
      agentId,
      capabilities: ids,
      scopes,
      workflowIds: scopes
        .map((s) => this.state.capabilities.get(s.id))
        .filter((e): e is CapabilityEntry => !!e && e.kind === "workflow" && !!e.members?.length)
        .map((e) => e.id),
      reasons,
    };
    this.pending.set(pendingId, record);
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
    if (!record || record.kind !== "grant") return undefined;
    return {
      pendingId,
      state: record.state,
      capabilities: record.capabilities,
      ...(record.token ? { token: record.token } : {}),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PENDING LIFECYCLE — the human approve/deny channel (m4sec-auth). Driven by the
  // management session (connection-key authenticated). Agents poll GET /grants/status.
  // ──────────────────────────────────────────────────────────────────────────────

  /** List every pending item (grants + registrations) for the admin approval panel. */
  listPending(): PendingView[] {
    const out: PendingView[] = [];
    for (const rec of this.pending.values()) {
      if (rec.state !== "pending") continue;
      if (rec.kind === "grant") {
        out.push({
          pendingId: rec.pendingId,
          kind: "grant",
          state: rec.state,
          createdAt: rec.createdAt,
          agentId: rec.agentId,
          capabilities: rec.capabilities,
          scopes: rec.scopes,
          reasons: rec.reasons,
        });
      } else {
        out.push({
          pendingId: rec.pendingId,
          kind: "register",
          state: rec.state,
          createdAt: rec.createdAt,
          register: rec.surface,
        });
      }
    }
    // Newest first.
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Track a pending EXTENSION REGISTRATION awaiting a human decision. The commit
   * (`registerExtension`) runs ONLY on approve. Returns the pendingId + statusUrl so
   * the agent can poll the SAME `GET /grants/status` channel for the outcome.
   */
  makeRegisterPending(
    sessionId: string,
    source: SourceId,
    surface: RegisterApprovalSurface,
    commit: () => Promise<ExtensionRegisterResponse>,
  ): GrantPendingResponse {
    const pendingId = `pend_${randomUUID()}`;
    const record: PendingRegisterRecord = {
      pendingId,
      kind: "register",
      state: "pending",
      createdAt: new Date().toISOString(),
      sessionId,
      source,
      surface,
      commit,
    };
    this.pending.set(pendingId, record);
    const adv = authAdvertisement(this.state.config);
    return {
      status: "grant_pending_user",
      pendingId,
      pending: [source],
      statusUrl: `${adv.grantStatusUrl}?pendingId=${pendingId}`,
    };
  }

  /** A pending register's terminal result (for the `POST /extensions` poll, if needed). */
  registerResult(pendingId: string):
    | { state: "pending" | "denied" | "expired" }
    | { state: "approved"; result: ExtensionRegisterResponse }
    | undefined {
    const rec = this.pending.get(pendingId);
    if (!rec || rec.kind !== "register") return undefined;
    if (rec.state === "approved" && rec.result) return { state: "approved", result: rec.result };
    return { state: rec.state === "approved" ? "pending" : rec.state };
  }

  /**
   * APPROVE a pending item (the user's "approve" action in the management client).
   *  - grant: persist the captured scopes (+ synthesize workflow transitive scopes),
   *    mint the token INTO the record, publish a `grant_resolved` event, audit allow.
   *  - register: run the deferred commit (`registerExtension`); audit the activation.
   * Returns the resolved view (or undefined if no such pending item / already terminal).
   */
  async approve(pendingId: string): Promise<{ ok: boolean; kind?: PendingKind; reason?: string }> {
    const rec = this.pending.get(pendingId);
    if (!rec || rec.state !== "pending") return { ok: false, reason: "no such pending item (or already resolved)" };

    if (rec.kind === "grant") {
      const grantExpiresAt = new Date(Date.now() + GRANT_VALIDITY_MS).toISOString();
      const approvedScopes: TokenScope[] = [];
      const transitive: TransitiveGrant[] = [];
      for (const scope of rec.scopes) {
        const entry = this.state.capabilities.get(scope.id);
        if (!entry) continue; // unregistered between request + approve — skip.
        this.persistGrant(rec.agentId, entry, scope.verbs, grantExpiresAt);
        approvedScopes.push({ id: entry.id, verbs: scope.verbs });
        await this.state.audit.write({
          type: "grant.allow",
          agentId: rec.agentId,
          sessionId: rec.sessionId,
          capabilityId: entry.id,
          verbs: scope.verbs,
          detail: { policy: this.authorizer.policy, viaApproval: pendingId },
        });
        if (entry.kind === "workflow" && entry.members?.length) {
          const { memberScopes, transitive: tg } = synthesizeTransitive(entry, (mid) =>
            this.state.capabilities.get(mid),
          );
          for (const ms of memberScopes) {
            approvedScopes.push(ms);
            this.persistGrant(rec.agentId, this.state.capabilities.get(ms.id)!, ms.verbs, grantExpiresAt, entry.id);
          }
          if (tg.memberScopes.length) transitive.push(tg);
        }
      }
      const session = this.state.sessions.get(rec.sessionId);
      // Mint the token even if the session has since expired? No — token is bound to a
      // live session for invoke. If the session died, the grant is persisted; the agent
      // re-handshakes + the prior-approval short-circuits re-prompt.
      if (session && this.state.sessions.liveness(rec.sessionId).live && approvedScopes.length > 0) {
        const token = this.mintToken(session, rec.agentId, approvedScopes, grantExpiresAt, transitive);
        rec.token = token;
        this.state.events.publish({ type: "grant_resolved", pendingId, decision: "approved", token });
      } else {
        this.state.events.publish({ type: "grant_resolved", pendingId, decision: "approved" });
      }
      rec.state = "approved";
      return { ok: true, kind: "grant" };
    }

    // register
    const result = await rec.commit();
    rec.result = result;
    rec.state = "approved";
    await this.state.audit.write({
      type: "source.install",
      sessionId: rec.sessionId,
      detail: {
        source: rec.source,
        kind: "extension",
        outcome: result.ok ? "approved+committed" : "approved-but-failed",
        viaApproval: pendingId,
        registered: result.registered.length,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });
    this.state.events.publish({
      type: "manifest_changed",
      revision: this.state.capabilities.revision(),
    });
    return { ok: result.ok, kind: "register", ...(result.reason ? { reason: result.reason } : {}) };
  }

  /** DENY a pending item (the user's "deny" action). Nothing is persisted/activated. */
  async deny(pendingId: string, reason?: string): Promise<{ ok: boolean; kind?: PendingKind; reason?: string }> {
    const rec = this.pending.get(pendingId);
    if (!rec || rec.state !== "pending") return { ok: false };
    rec.state = "denied";
    if (rec.kind === "grant") {
      for (const id of rec.capabilities) {
        await this.state.audit.write({
          type: "grant.deny",
          agentId: rec.agentId,
          sessionId: rec.sessionId,
          capabilityId: id,
          detail: { reason: reason ?? "denied by user", policy: this.authorizer.policy, viaApproval: pendingId },
        });
      }
      this.state.events.publish({ type: "grant_resolved", pendingId, decision: "denied" });
    } else {
      await this.state.audit.write({
        type: "source.install",
        sessionId: rec.sessionId,
        detail: { source: rec.source, kind: "extension", outcome: "denied", viaApproval: pendingId, reason: reason ?? "denied by user" },
      });
    }
    return { ok: true, kind: rec.kind };
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
