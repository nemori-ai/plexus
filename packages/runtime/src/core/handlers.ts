/**
 * Endpoint handlers (§2 endpoint contract). Each handler reads from the wired
 * `GatewayState`, runs the grant/invoke services, and returns a typed protocol
 * shape or a uniform `ErrorResponse`. The Host/Origin guard + routing live in
 * `server.ts`; this module is the business logic.
 */

import type { Context } from "hono";
import type {
  Authorizer,
  ErrorResponse,
  ErrorCode,
  HandshakeRequest,
  HandshakeResponse,
  GrantRequest,
  RefreshRequest,
  RevokeRequest,
  CapabilityId,
  InvokeRequest,
  InvokeResponse,
  InvokeContext,
  ManifestRefreshResponse,
  ExtensionRegisterRequest,
  ExtensionRegisterResponse,
  ScopedTokenClaims,
  ScopedToken,
  GrantsListResponse,
} from "@plexus/protocol";
import type { GatewayState } from "./state.ts";
import { GrantService, BundleValidationError } from "./grant-service.ts";
import { InvokePipeline, PipelineError } from "./pipeline.ts";
import { buildManifest } from "./manifest.ts";
import { authAdvertisement } from "./well-known.ts";
import { buildRegisterSurface } from "./register-surface.ts";
import {
  verifyToken,
  verifyTokenForRefresh,
  TokenExpiredError,
  TokenInvalidError,
} from "../auth/index.ts";

/** Map a closed ErrorCode to an HTTP status. */
function statusFor(code: ErrorCode): number {
  switch (code) {
    case "host_forbidden":
      return 403;
    case "capability_unexposed":
      // The owner disabled the capability at the top level — a policy forbiddance,
      // distinct from 401 (auth) / 404 (unknown). 403 Forbidden: the request is well-
      // formed and the token may be valid, but the resource is not exposed.
      return 403;
    case "session_expired":
    case "token_expired":
    case "token_revoked":
    case "grant_required":
    case "grant_pending_user":
    // The invoke-time analog of grant_pending_user: the request is well-formed and the
    // session is authenticated, but no grant exists yet and the owner must approve. Same
    // 401 family as grant_pending_user — "not authorized YET"; the body says how to proceed.
    case "approval_required":
      return 401;
    case "unknown_capability":
      return 404;
    case "schema_validation_failed":
      return 422;
    case "rate_limited":
      return 429;
    case "source_unavailable":
    // The mesh home (a remote workload) is down right now — a temporary, recoverable
    // service unavailability (Invariant E), NOT a client error. Same family as a local
    // source being down: 503, never 400.
    case "capability_unavailable":
      return 503;
    default:
      return 400;
  }
}

function errorBody(code: ErrorCode, message: string, capabilityId?: string): ErrorResponse {
  return { error: { code, message, ...(capabilityId ? { capabilityId } : {}) } };
}

function fail(c: Context, code: ErrorCode, message: string, capabilityId?: string) {
  return c.json(errorBody(code, message, capabilityId), statusFor(code) as never);
}

/**
 * A CLIENT-REQUEST validation failure → HTTP 400 with a validation-detail body
 * (integration-legibility fix #5). Distinct from `fail()`: a malformed/unresolvable request is a
 * 400 (fix your request) regardless of the closed code's usual status — never a 500 crash and
 * never a hollow 200. Carries an optional `detail` (e.g. the offending ids) for the agent.
 */
function validationFail(c: Context, message: string, detail?: unknown) {
  const body: ErrorResponse = {
    error: { code: "schema_validation_failed", message, ...(detail !== undefined ? { detail } : {}) },
  };
  return c.json(body, 400);
}

/**
 * /invoke ONLY (tp2 / ADR-017): emit a denial as an `InvokeResponse`-SHAPED body
 * `{ id, ok:false, error:{code,message,capabilityId}, auditId }` while KEEPING the
 * closed ErrorCode's HTTP status. Unlike `fail()` (the uniform `ErrorResponse`
 * envelope used by every OTHER endpoint), this gives /invoke ONE result contract:
 * a naive agent deserializing every /invoke reply as `InvokeResponse` reads
 * `ok:false` even on a pre-dispatch/auth denial, never `ok === undefined`. The HTTP
 * status still distinguishes auth (401) / not-found (404) / schema (422) for agents
 * that branch on it. `auditId` carries the audited-denial's event id when the
 * pipeline audited the denial, else the empty-string sentinel `""` (edge denials
 * — no token / bad token / unparseable body — happen before any audit).
 */
function invokeFail(
  c: Context,
  id: CapabilityId,
  code: ErrorCode,
  message: string,
  auditId = "",
) {
  const res: InvokeResponse = {
    id,
    ok: false,
    error: { code, message, ...(id ? { capabilityId: id } : {}) },
    auditId,
  };
  return c.json(res, statusFor(code) as never);
}

/** Extract a Bearer token from the Authorization header. */
function bearer(c: Context): string | undefined {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * The handler bundle — constructed once per app over the gateway state. Owns the
 * grant service + invoke pipeline (their per-session caches live for the process).
 */
export class Handlers {
  private readonly grants: GrantService;
  private readonly pipeline: InvokePipeline;
  /**
   * ORIGINATING-SESSION index for pending grants (P6-STATUS-AUTH). Maps a `pendingId` → the
   * `sessionId` that CREATED it (via `PUT /grants` or grant-assist `/invoke`). `GET /grants/status`
   * carries the minted token once approved, so it must only be readable by the requester that
   * initiated the grant (or the management connection-key) — this index is how we identify that
   * requester without reaching into the grant service's private pending store.
   */
  private readonly pendingOrigin = new Map<string, string>();

  constructor(
    private readonly state: GatewayState,
    authorizer: Authorizer,
  ) {
    this.grants = new GrantService(state, authorizer);
    this.pipeline = new InvokePipeline(state);
  }

  /**
   * POST /link/handshake — open a session + return the full Manifest.
   *
   * TWO credentials, one endpoint, DISJOINT trust roles (agent-skill-compile §3 / Inv III):
   *
   *  (a) AGENT — a per-agent PAT in the `Authorization: Bearer plx_agent_...` header. This is
   *      the canonical agent credential. A valid PAT resolves (via the enrollment ledger) to the
   *      REAL `agentId`, and the session binds to THAT id — never a client-supplied string, so an
   *      agent can no longer self-assert/spoof another agent's identity. If a Bearer token is
   *      present it is treated as a PAT auth attempt and MUST verify: a forged / revoked / expired
   *      / non-PAT bearer fails cleanly (401, no session) and does NOT fall through to the
   *      connection-key. `client.agentId` is IGNORED on this path.
   *
   *  (b) ADMIN / MANAGEMENT — the `connectionKey` in the JSON body (Inv III: admin-ONLY; agents
   *      never hold it). Preserved for the management surface + the existing ecosystem. Because
   *      possessing the connection-key IS proof of the admin authority, the admin may legitimately
   *      NAME the `agentId` it is acting on behalf of (the same trusted-management capability
   *      `admin.ts` exercises internally) — that is NOT a spoof, since an agent has no
   *      connection-key to reach this path with.
   *
   * Selection is by credential presence: a Bearer PAT ⇒ agent path; else a valid connectionKey ⇒
   * admin path; neither ⇒ 401. Replay/forge resistance comes from the PAT verifier (hash-at-rest,
   * revocable, per-agent) — a stolen `agentId` string buys nothing without the PAT that mints it.
   */
  handshake = async (c: Context) => {
    let body: HandshakeRequest | undefined;
    let jsonError = false;
    try {
      body = (await c.req.json()) as HandshakeRequest;
    } catch {
      // Tolerate an absent/empty body on the PAT path (a PAT-only agent carries no body);
      // only the connection-key path needs the JSON, so defer the error until we know.
      jsonError = true;
    }

    // ── (a) AGENT path: a per-agent PAT bearer is the canonical agent credential. ──
    const pat = bearer(c);
    if (pat !== undefined) {
      const agentId = this.state.agentEnrollment.verifyPat(pat);
      if (!agentId) {
        // Forged / revoked / expired / non-PAT bearer — fail closed, no session. Never fall
        // through to the connection-key (a Bearer present ⇒ this is an agent auth attempt).
        return fail(
          c,
          "session_expired",
          "invalid or revoked agent PAT — present your per-agent credential as an " +
            "`Authorization: Bearer plx_agent_...` header (redeem an enrollment code at " +
            "POST /agents/enroll to obtain one)",
        );
      }
      // Bind the session to the PAT's REAL agentId — the client-supplied `agentId` (if any) is
      // coerced to the verified one so it can never over-assert, while name/version stay as audit
      // metadata. The PAT is the session's bootstrap secret (mirrors the connection-key path):
      // agent sessions are thus decoupled from connection-key rotation, dying with their own PAT.
      const client = { ...(body?.client ?? {}), agentId };
      const session = this.state.sessions.open(pat, client, agentId);
      await this.state.audit.write({
        type: "handshake",
        agentId,
        sessionId: session.id,
        detail: { client: body?.client?.name, version: body?.client?.version, auth: "pat" },
      });
      const manifest = buildManifest(this.state, session);
      const adv = authAdvertisement(this.state.config);
      const res: HandshakeResponse = {
        sessionId: session.id,
        manifest,
        grantsUrl: adv.grantsUrl,
        expiresAt: session.expiresAt,
      };
      return c.json(res);
    }

    // ── (b) ADMIN / MANAGEMENT path: connection-key (admin-only) in the JSON body. ──
    if (jsonError) return fail(c, "internal_error", "invalid JSON body");
    if (!body?.connectionKey || !this.state.connectionKey.verify(body.connectionKey)) {
      // Auth failure on the bootstrap secret — not a closed-union recovery code;
      // surface as session_expired so the agent re-acquires the key. STATE WHERE THE CREDENTIAL
      // GOES (integration-legibility P6-SCHEMA): an AGENT presents a PAT as an `Authorization:
      // Bearer plx_agent_...` header; the admin connection-key belongs in the JSON BODY as
      // `connectionKey` (a body field, not a header/bearer) — so a cold caller fixes the request.
      return fail(
        c,
        "session_expired",
        'no valid credential — an agent presents its per-agent PAT as an "Authorization: Bearer ' +
          'plx_agent_..." header; an admin sends the connection-key in the JSON body as ' +
          '{"connectionKey": "<key>"}',
      );
    }
    const session = this.state.sessions.open(body.connectionKey, body.client);
    await this.state.audit.write({
      type: "handshake",
      ...(session.agentId ? { agentId: session.agentId } : {}),
      sessionId: session.id,
      detail: { client: body.client?.name, version: body.client?.version, auth: "connection-key" },
    });
    const manifest = buildManifest(this.state, session);
    const adv = authAdvertisement(this.state.config);
    const res: HandshakeResponse = {
      sessionId: session.id,
      manifest,
      grantsUrl: adv.grantsUrl,
      expiresAt: session.expiresAt,
    };
    return c.json(res);
  };

  /**
   * POST /agents/enroll — redeem a one-time enrollment code → durable per-agent PAT
   * (agent-skill-compile §3 / ADR-4). UNAUTHENTICATED BY DESIGN: the code IS the
   * credential (never the admin connection-key, which this path never accepts). The
   * PAT is returned in plaintext exactly ONCE, here. FAIL-CLOSED on a malformed body
   * (400); a bad/used/expired code is a 401 credential failure with a typed reason;
   * a durable-write failure is a 500 (the code stays unconsumed for a retry).
   *
   * This route owns its OWN small reason contract (`malformed` | `unknown_code` |
   * `code_expired` | `code_consumed` | `persist_failed`) rather than the gateway's
   * closed `ErrorCode` union — enrollment is a distinct, self-describing surface.
   */
  enrollAgent = async (c: Context) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "malformed", message: "invalid JSON body — send {\"code\": \"<enrollment-code>\"}" } },
        400,
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json(
        { error: { code: "malformed", message: "request body must be a JSON object with a `code` field" } },
        400,
      );
    }
    const code = (raw as { code?: unknown }).code;
    if (typeof code !== "string" || code.length === 0) {
      return c.json(
        { error: { code: "malformed", message: "`code` must be a non-empty string" } },
        400,
      );
    }

    const outcome = this.state.agentEnrollment.redeemEnrollmentCode(code);
    if (outcome.ok) {
      await this.state.audit.write({
        type: "handshake",
        agentId: outcome.agentId,
        detail: { event: "agent.enroll", outcome: "redeemed" },
      });
      return c.json({ pat: outcome.pat, agentId: outcome.agentId });
    }

    // Fail-closed. `malformed` is a client error (400); `persist_failed` a server
    // error (500); the rest are credential failures (401) — the code is invalid.
    const status = outcome.reason === "persist_failed" ? 500 : 401;
    await this.state.audit.write({
      type: "handshake",
      detail: { event: "agent.enroll", outcome: "rejected", reason: outcome.reason },
    });
    return c.json(
      { error: { code: outcome.reason, message: `enrollment code rejected: ${outcome.reason}` } },
      status as never,
    );
  };

  /**
   * PUT /grants — authorizer → scoped-token or grant_pending_user.
   *
   * The SANCTIONED grant-request affordance (integration-legibility fixes #3/#4/#5). Reads the
   * session the SAME way as `GET /grants` / `/manifest` — the `X-Plexus-Session` header — while
   * still honoring a legacy `sessionId` in the body (header wins). VALIDATES the request before
   * touching the grant service so a malformed body never 500s and an unknown/empty request never
   * returns a hollow empty-scope token:
   *   - non-object body / non-object `grants` / empty `grants` → 400 with a validation detail;
   *   - any capability id that does not resolve to a live entry → 400 naming the unknown id(s).
   * Only a well-formed request over known ids reaches `grants.grant()`, which auto-grants a
   * low-sensitivity first-party/managed READ (scoped token straight back) and pends the rest.
   */
  putGrants = async (c: Context) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return validationFail(c, "invalid JSON body");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return validationFail(c, "grant request must be a JSON object with a `grants` map");
    }
    const body = raw as Partial<GrantRequest> & Record<string, unknown>;
    const grants = body.grants;
    if (typeof grants !== "object" || grants === null || Array.isArray(grants)) {
      return validationFail(
        c,
        '`grants` must be an object mapping capabilityId → "allow" | "deny" | { decision }',
      );
    }
    const requestedIds = Object.keys(grants);
    if (requestedIds.length === 0) {
      return validationFail(c, "`grants` is empty — name at least one capability to request");
    }
    // Standardized session plumbing: the header is the canonical channel (matches GET /grants),
    // body.sessionId is accepted for back-compat. One or the other MUST identify a live session.
    const sessionId =
      c.req.header("x-plexus-session") ?? c.req.header("X-Plexus-Session") ?? body.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      return fail(
        c,
        "session_expired",
        "missing session — send the X-Plexus-Session header (or `sessionId` in the body)",
      );
    }
    const session = this.state.sessions.get(sessionId);
    const liveness = this.state.sessions.liveness(sessionId);
    if (!session || !liveness.live) {
      return fail(c, "session_expired", liveness.reason ?? "unknown session");
    }
    // Reject unknown capability ids up front (no silent skip → no hollow 200). A disabled-but-
    // known cap is NOT rejected here — the grant service audits + skips it (it is invisible, a
    // stale-manifest/probe path), which is distinct from "no such id".
    const unknown = requestedIds.filter((id) => !this.state.capabilities.get(id));
    if (unknown.length > 0) {
      return validationFail(
        c,
        `unknown capability id(s): ${unknown.join(", ")} — run GET /manifest for current ids`,
        { unknownCapabilities: unknown },
      );
    }
    let result;
    try {
      result = await this.grants.grant(
        {
          sessionId,
          grants,
          ...(body.bundle ? { bundle: body.bundle as GrantRequest["bundle"] } : {}),
        } as GrantRequest,
        session,
      );
    } catch (e) {
      // A request-level bundle validation failure (e.g. an execute member that can never
      // stand) → a clean 400, mirroring the admin createBundle's rejection.
      if (e instanceof BundleValidationError) return validationFail(c, e.message);
      throw e;
    }
    // Record the originating session for any pending this created, so ONLY this session (or the
    // management key) can later poll /grants/status for the minted token (P6-STATUS-AUTH).
    if (result && typeof result === "object" && "status" in result && result.status === "grant_pending_user") {
      this.pendingOrigin.set(result.pendingId, sessionId);
    }
    // grant_pending_user → 401-ish? It's a normal (non-error) protocol response.
    return c.json(result);
  };

  /**
   * GET /grants/status?pendingId=… — poll a pending grant's decision (P6-STATUS-AUTH).
   *
   * The response CARRIES THE MINTED TOKEN once the owner approves, and that token is usable by any
   * bearer holder. So this read is NO LONGER anonymous: bind it to the requester that INITIATED the
   * grant. Accept EITHER
   *   (a) the management connection-key (the owner's console/management session), OR
   *   (b) the `X-Plexus-Session` of the session that CREATED this pending (the originator).
   * Any other caller — a different session, or someone holding only the leaked pendingId — is
   * refused with 403 and NEVER sees the token. The originating-session round-trip (agent creates
   * pending → owner approves via admin → agent polls → gets token) is unchanged FOR THAT SESSION.
   */
  grantStatus = (c: Context) => {
    const pendingId = c.req.query("pendingId");
    if (!pendingId) return fail(c, "internal_error", "missing pendingId");
    const status = this.grants.status(pendingId);
    if (!status) return fail(c, "unknown_capability", `No pending grant '${pendingId}'.`);

    const connectionKey =
      c.req.header("x-plexus-connection-key") ?? c.req.header("X-Plexus-Connection-Key");
    const hasManagementAuth = !!connectionKey && this.state.connectionKey.verify(connectionKey);
    const sessionId = c.req.header("x-plexus-session") ?? c.req.header("X-Plexus-Session");
    const origin = this.pendingOrigin.get(pendingId);
    const isOriginator = !!sessionId && !!origin && sessionId === origin;
    if (!hasManagementAuth && !isOriginator) {
      // Contract-consistent credential-failure code (as in handshake/revoke), but a 403 — the
      // request is well-formed and may carry a valid-but-DIFFERENT session; it is simply not the
      // requester this pending belongs to. The token is withheld.
      const body: ErrorResponse = {
        error: {
          code: "session_expired",
          message:
            "This pending grant's status (and any minted token) is readable only by the originating " +
            "session (send its X-Plexus-Session header) or the management connection-key.",
        },
      };
      return c.json(body, 403 as never);
    }
    return c.json(status);
  };

  /** POST /grants/refresh — re-mint from persisted grant. */
  refresh = async (c: Context) => {
    let body: RefreshRequest;
    try {
      body = (await c.req.json()) as RefreshRequest;
    } catch {
      return fail(c, "internal_error", "invalid JSON body");
    }
    const token = bearer(c);
    if (!token) return fail(c, "token_expired", "missing Authorization bearer token");

    let claims: ScopedTokenClaims;
    try {
      claims = verifyTokenForRefresh(token); // accepts within the grace window
    } catch (e) {
      if (e instanceof TokenExpiredError) return fail(c, "token_expired", "token past refresh grace");
      return fail(c, "token_revoked", "token signature invalid");
    }
    if (claims.jti !== body.jti) {
      return fail(c, "token_revoked", "jti does not match presented token");
    }
    const liveness = this.state.sessions.liveness(body.sessionId);
    const session = this.state.sessions.get(body.sessionId);
    if (!session || !liveness.live) {
      return fail(c, "session_expired", liveness.reason ?? "unknown session");
    }
    if (this.state.revocation.isRevoked(claims.jti)) {
      return fail(c, "token_revoked", "token has been revoked");
    }
    const agentId = session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
    const result = this.grants.refresh(session, agentId, claims.jti, claims.scopes);
    if ("error" in result) {
      return fail(c, result.error, "no live grant backs this token; re-grant required");
    }
    return c.json(result);
  };

  /** POST /grants/revoke — by jti or by (agentId, capabilityId). */
  revoke = async (c: Context) => {
    let body: RevokeRequest;
    try {
      body = (await c.req.json()) as RevokeRequest;
    } catch {
      return fail(c, "internal_error", "invalid JSON body");
    }
    // AUTHZ-UX §2.N3: a `bundleId` selector revokes a whole task bundle (additive).
    const bundleId = (body as RevokeRequest & { bundleId?: string }).bundleId;
    if (!body.jti && !(body.agentId && body.capabilityId) && !bundleId) {
      return fail(c, "internal_error", "revoke requires `jti`, both `agentId`+`capabilityId`, or `bundleId`");
    }

    // AUTHORIZATION (§4c / ADR-006/010): the Host/Origin guard alone does NOT
    // authorize a revoke. Accept ONLY if EITHER
    //   (a) the request carries the management connection-key — a management
    //       session (the user's "revoke now" action in the management client), OR
    //   (b) it presents a valid `Authorization: Bearer <scoped-token>` whose jti
    //       matches the jti being revoked — an agent relinquishing its OWN token.
    // Otherwise reject. We surface a credential failure as `session_expired`,
    // matching how the handshake reports a bad/missing connection-key (the same
    // bootstrap secret); it is the contract-consistent closed-union code for "this
    // credential does not authorize you" and is NOT an invented code.
    const connectionKey =
      c.req.header("x-plexus-connection-key") ?? c.req.header("X-Plexus-Connection-Key");
    const hasManagementAuth =
      !!connectionKey && this.state.connectionKey.verify(connectionKey);

    if (!hasManagementAuth) {
      // Path (b): an agent may revoke ONLY its own jti, proven by presenting the
      // token whose jti it is revoking.
      const token = bearer(c);
      let ownsJti = false;
      if (token && body.jti) {
        try {
          // Refresh-grace verify so a just-expired token can still relinquish itself.
          const claims = verifyTokenForRefresh(token);
          ownsJti = claims.jti === body.jti;
        } catch {
          ownsJti = false;
        }
      }
      if (!ownsJti) {
        return fail(
          c,
          "session_expired",
          "revoke requires a valid connection-key (management session) or a Bearer token whose jti matches the jti being revoked",
        );
      }
    }

    // Revoke-by-bundle requires management auth (an agent can't drop a whole bundle by id).
    if (bundleId) {
      if (!hasManagementAuth) {
        return fail(c, "session_expired", "revoke-by-bundle requires a management connection-key");
      }
      const result = await this.grants.revokeBundle(bundleId, body.reason);
      return c.json(result);
    }

    const result = await this.grants.revoke(body);
    return c.json(result);
  };

  /**
   * POST /invoke — the uniform pipeline.
   *
   * ONE result contract (tp2 / ADR-017): EVERY response body is `InvokeResponse`-
   * shaped — success is `{id, ok:true, …}`, and a denial (auth/pre-dispatch OR
   * transport) is `{id, ok:false, error:{code,message,…}, auditId}` (auditId = the
   * audited-denial's id, or "" for an edge denial that fails before audit). The closed
   * `ErrorCode` still maps to the appropriate HTTP status (401 auth, 404 unknown,
   * 422 schema, …) so an agent can branch on the status; but a naive agent
   * deserializing every reply as `InvokeResponse` always reads `ok:false` on
   * denial, never `ok === undefined`. (Other endpoints keep the uniform
   * `ErrorResponse` envelope — this single-shape rule is /invoke-only.)
   */
  invoke = async (c: Context) => {
    let body: InvokeRequest;
    try {
      body = (await c.req.json()) as InvokeRequest;
    } catch {
      // No parseable body ⇒ no capability id; still emit the InvokeResponse shape.
      return invokeFail(c, "", "internal_error", "invalid JSON body");
    }
    const id = body?.id ?? "";
    const token = bearer(c);
    if (!token) {
      // GRANT-ASSIST (integration-legibility fixes #1/#2/#6): an invoke with NO Bearer token.
      // The connection-key is NOT a bearer (never accepted here). If the agent presents a live
      // handshake SESSION (X-Plexus-Session), route it through the SAME authorizer as PUT /grants:
      // a low-sensitivity first-party/managed READ auto-grants (mint + proceed, token attached);
      // anything needing owner approval CREATES a pending record and returns a structured
      // `approval_required` (pendingId + approvalUrl + grantStatusUrl). With no session at all, we
      // return actionable guidance toward the sanctioned grant-request path — NEVER phrasing that
      // implies a bad/forgeable token.
      const sessionId = c.req.header("x-plexus-session") ?? c.req.header("X-Plexus-Session");
      if (sessionId) return this.grantAssistInvoke(c, body, id, sessionId);
      return this.invokeGrantGuidance(c, id);
    }

    let claims: ScopedTokenClaims;
    try {
      claims = verifyToken(token);
    } catch (e) {
      if (e instanceof TokenExpiredError) return invokeFail(c, id, "token_expired", "token expired");
      if (e instanceof TokenInvalidError)
        return invokeFail(c, id, "token_revoked", "token signature invalid");
      return invokeFail(c, id, "token_revoked", "token verification failed");
    }
    // jti revocation + session liveness are enforced (and AUDITED as a denial)
    // inside the pipeline, re-checked per workflow member. We deliberately do NOT
    // short-circuit a revoked jti here: routing it through the pipeline ensures the
    // attempt is audited (outcome="denied") rather than silently rejected at the edge.
    const ctx: InvokeContext = {
      jti: claims.jti,
      sessionId: claims.sessionId,
      ...(claims.sub ? { agentId: claims.sub } : {}),
      scopes: claims.scopes,
    };
    let response: InvokeResponse;
    try {
      response = await this.pipeline.invokeById(body, ctx);
    } catch (e) {
      if (e instanceof PipelineError) {
        // Uniform /invoke shape for an audited pre-dispatch denial: the closed code
        // keeps its HTTP status, but the body is InvokeResponse-shaped and carries
        // the audited denial's id + auditId (tp2 / ADR-017). We fold the FULL error
        // body (not just code/message) so additive fields survive — notably
        // `unavailableSince` on a mesh `capability_unavailable` (Invariant E).
        const denialId = e.capabilityId ?? body.id ?? id;
        const res: InvokeResponse = {
          id: denialId,
          ok: false,
          error: { ...e.body, ...(denialId ? { capabilityId: denialId } : {}) },
          auditId: e.auditId ?? "",
        };
        return c.json(res, statusFor(e.body.code) as never);
      }
      return invokeFail(c, body.id ?? id, "internal_error", e instanceof Error ? e.message : String(e));
    }
    return c.json(response, 200);
  };

  /**
   * /invoke with NO Bearer token AND NO session — return actionable guidance (fix #1/#6). The
   * true state is "no grant exists yet", NOT "your token is bad": we keep the honest
   * `grant_required` code and point at the sanctioned grant-request path (handshake → PUT /grants,
   * reads auto-granted). InvokeResponse-shaped (tp2/ADR-017) at 401, edge denial ⇒ auditId "".
   */
  private invokeGrantGuidance(c: Context, id: CapabilityId) {
    const adv = authAdvertisement(this.state.config);
    const res: InvokeResponse = {
      id,
      ok: false,
      error: {
        code: "grant_required",
        message:
          "No grant for this capability yet. Handshake (POST /link/handshake) for a session, then " +
          "request a grant at grantRequestUrl with the X-Plexus-Session header — the capabilities the " +
          "owner authorized you at connect are usable (reads stand); anything else pends for the owner. " +
          "The agent cannot mint its own token.",
        ...(id ? { capabilityId: id } : {}),
        ...(adv.grantRequestUrl ? { grantRequestUrl: adv.grantRequestUrl } : {}),
        ...(adv.sessionHeader ? { sessionHeader: adv.sessionHeader } : {}),
      },
      auditId: "",
    };
    return c.json(res, statusFor("grant_required") as never);
  }

  /**
   * GRANT-ASSIST (fix #1/#2): an invoke that presents a live SESSION but no token, for a
   * capability the session lacks a grant for. Routes the (id → "allow") request through the SAME
   * authorizer as PUT /grants so the auto-grant-reads vs pend-for-approval decision is made in
   * ONE place:
   *   - AUTO-GRANT (low-sensitivity first-party/managed READ): the scoped token is minted, the
   *     invoke PROCEEDS, and the token is ATTACHED to the InvokeResponse (`grant`) so the agent
   *     keeps it. One round-trip, no human.
   *   - APPROVAL-NEEDED (write / elevated / high / extension): a pending record is CREATED and a
   *     structured `approval_required` (pendingId + approvalUrl + grantStatusUrl) is returned; the
   *     agent polls `/grants/status` and the owner approves in the console.
   */
  private grantAssistInvoke = async (
    c: Context,
    body: InvokeRequest,
    id: CapabilityId,
    sessionId: string,
  ) => {
    const session = this.state.sessions.get(sessionId);
    const liveness = this.state.sessions.liveness(sessionId);
    if (!session || !liveness.live) {
      return invokeFail(c, id, "session_expired", liveness.reason ?? "unknown session");
    }
    if (!id) return invokeFail(c, id, "unknown_capability", "missing capability id in invoke body");
    const entry = this.state.capabilities.get(id);
    if (!entry) return invokeFail(c, id, "unknown_capability", `No such capability '${id}'.`);
    if (this.state.exposure?.isDisabled(id)) {
      return invokeFail(
        c,
        id,
        "capability_unexposed",
        `Capability '${id}' is disabled at the top level (not exposed).`,
      );
    }

    const result = await this.grants.grant({ sessionId, grants: { [id]: "allow" } }, session);
    const adv = authAdvertisement(this.state.config);

    // APPROVAL-NEEDED: a pending record was created — return the structured, actionable body.
    if ("status" in result && result.status === "grant_pending_user") {
      // Bind the minted token to THIS session: only it (or the management key) may poll status.
      this.pendingOrigin.set(result.pendingId, session.id);
      const res: InvokeResponse = {
        id,
        ok: false,
        error: {
          code: "approval_required",
          message:
            "Owner must approve this grant in the Plexus console; the agent cannot mint its own token.",
          capabilityId: id,
          pendingId: result.pendingId,
          ...(result.approvalUrl ?? adv.consoleUrl
            ? { approvalUrl: result.approvalUrl ?? adv.consoleUrl }
            : {}),
          grantStatusUrl: result.statusUrl,
        },
        auditId: "",
      };
      return c.json(res, statusFor("approval_required") as never);
    }

    // AUTO-GRANTED: mint succeeded → proceed with the invoke on the fresh scope, attaching the
    // token so the agent can invoke directly (Bearer) from here on.
    const scoped = result as ScopedToken;
    const agentId = session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
    const ctx: InvokeContext = {
      jti: scoped.jti,
      sessionId: session.id,
      agentId,
      scopes: scoped.scopes,
    };
    try {
      const response = await this.pipeline.invokeById(body, ctx);
      return c.json({ ...response, grant: scoped }, 200);
    } catch (e) {
      if (e instanceof PipelineError) {
        const denialId = e.capabilityId ?? body.id ?? id;
        const res: InvokeResponse = {
          id: denialId,
          ok: false,
          error: { ...e.body, ...(denialId ? { capabilityId: denialId } : {}) },
          // Still hand over the token the agent now holds so a retry needs no re-grant.
          grant: scoped,
          auditId: e.auditId ?? "",
        };
        return c.json(res, statusFor(e.body.code) as never);
      }
      return invokeFail(c, body.id ?? id, "internal_error", e instanceof Error ? e.message : String(e));
    }
  };

  /** GET /manifest — refresh snapshot (session-authenticated). */
  manifest = (c: Context) => {
    const sessionId = c.req.header("x-plexus-session") ?? c.req.header("X-Plexus-Session");
    if (!sessionId) return fail(c, "session_expired", "missing X-Plexus-Session header");
    const session = this.state.sessions.get(sessionId);
    const liveness = this.state.sessions.liveness(sessionId);
    if (!session || !liveness.live) {
      return fail(c, "session_expired", liveness.reason ?? "unknown session");
    }
    const res: ManifestRefreshResponse = { manifest: buildManifest(this.state, session) };
    return c.json(res);
  };

  /**
   * GET /grants — the standing-grant ledger (ADR-018). Session-authenticated with
   * the SAME pattern as `/manifest` (the `X-Plexus-Session` header). Returns the
   * CALLER's standing grants (keyed to the session's agent id) so an agent can see
   * its own durable trust — symmetric with the user's admin Grants view.
   */
  grantsList = (c: Context) => {
    const sessionId = c.req.header("x-plexus-session") ?? c.req.header("X-Plexus-Session");
    if (!sessionId) return fail(c, "session_expired", "missing X-Plexus-Session header");
    const session = this.state.sessions.get(sessionId);
    const liveness = this.state.sessions.liveness(sessionId);
    if (!session || !liveness.live) {
      return fail(c, "session_expired", liveness.reason ?? "unknown session");
    }
    const agentId = session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
    const res: GrantsListResponse = { grants: this.grants.listGrants(agentId) };
    return c.json(res);
  };

  /**
   * GET /grants/context?bundle=<id> — resolve a task bundle's attached in-scope context to
   * skill bodies so the agent reads its whole task context in one call (AUTHZ-UX §2.N3 / D3).
   * Session-authenticated like `/grants` / `/manifest` (the `X-Plexus-Session` header).
   */
  grantsContext = (c: Context) => {
    const sessionId = c.req.header("x-plexus-session") ?? c.req.header("X-Plexus-Session");
    if (!sessionId) return fail(c, "session_expired", "missing X-Plexus-Session header");
    const liveness = this.state.sessions.liveness(sessionId);
    const session = this.state.sessions.get(sessionId);
    if (!session || !liveness.live) {
      return fail(c, "session_expired", liveness.reason ?? "unknown session");
    }
    const bundleId = c.req.query("bundle");
    if (!bundleId) return fail(c, "internal_error", "missing `bundle` query parameter");
    const res = this.grants.bundleContext(bundleId);
    if (!res) return fail(c, "unknown_capability", `no bundle '${bundleId}'`);
    return c.json(res);
  };

  /**
   * GET /events — the AGENT SSE stream of PlexusEvents (the frozen agent wire).
   *
   * Carries ONLY the agent-relevant variants. The management-plane variants
   * (`pending_added` / `pending_resolved` / `audit_appended`, REDESIGN-ARCHITECTURE
   * §2.3) share the same in-process EventBus but are filtered OUT here — they belong
   * to `GET /v1/events` (a management audience, management-key gated). This keeps the
   * agent wire unchanged (additive-only) while one bus fans out to both audiences.
   */
  events = (c: Context) => {
    const stream = new ReadableStream({
      start: (controller) => {
        const enc = new TextEncoder();
        const send = (event: { type: string }) => {
          // Agent audience: drop the management-only event variants.
          if (
            event.type === "pending_added" ||
            event.type === "pending_resolved" ||
            event.type === "audit_appended"
          ) {
            return;
          }
          try {
            controller.enqueue(enc.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            /* stream closed */
          }
        };
        // Initial comment to open the stream.
        controller.enqueue(enc.encode(`: plexus event stream\n\n`));
        const unsubscribe = this.state.events.subscribe(send);
        // Tear down when the client disconnects.
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };

  /**
   * POST /extensions — register a user extension THROUGH the human-confirm gate.
   *
   * LINCHPIN: an agent holding a connection-key can REQUEST a registration but cannot
   * ACTIVATE an extension on its own. The flow is:
   *   1. validate the manifest (m4sec-reg `validateRegistration`) — reject if unsafe;
   *   2. if the extension is transport-backed (cli / local-rest / stdio / ipc), route
   *      through the authorizer to PENDING (`grant_pending_user`), surfacing the cli
   *      bins / rest hosts / cross-source attaches / verbs the user is approving;
   *      the COMMIT (`registerExtension`) runs ONLY after a human approves;
   *   3. otherwise (a pure skill/workflow with no external transport) commit directly.
   * An unapproved register does NOT register or activate the extension.
   */
  extensions = async (c: Context) => {
    let body: ExtensionRegisterRequest;
    try {
      body = (await c.req.json()) as ExtensionRegisterRequest;
    } catch {
      return fail(c, "internal_error", "invalid JSON body");
    }
    const liveness = this.state.sessions.liveness(body.sessionId);
    if (!liveness.live) {
      return fail(c, "session_expired", liveness.reason ?? "unknown session");
    }
    const registry = this.state.capabilities;
    if (typeof registry.registerExtension !== "function") {
      return fail(c, "internal_error", "extension registration is not available in this build");
    }

    // (1) VALIDATE (no commit). A wire register supplies NO handlers → untrusted, so
    // first-party-id reservation + cross-source-attach-off + workflow walk all apply.
    const verdict = registry.validateRegistration(body.manifest);
    if (!verdict.ok) {
      await this.state.audit.write({
        type: "source.install",
        sessionId: body.sessionId,
        detail: { source: body.manifest?.source, kind: "extension", outcome: "rejected", reason: verdict.reasons.join("; ") },
      });
      const result: ExtensionRegisterResponse = {
        ok: false,
        source: body.manifest?.source ?? "",
        registered: [],
        revision: registry.revision(),
        reason: verdict.reasons.join("; "),
      };
      return c.json(result);
    }

    // Build the security-sensitive surface (cli bins / rest hosts / cross-source / verbs).
    const surface = buildRegisterSurface(body.manifest, verdict.crossSourceProvenance);

    // (2) Transport-backed extensions PEND for a human. The commit re-validates so a
    // commit can never slip past unconfirmed.
    if (surface.transportBacked) {
      await this.state.audit.write({
        type: "source.install",
        sessionId: body.sessionId,
        detail: { source: body.manifest.source, kind: "extension", outcome: "pending", cliBins: surface.cliBins, restHosts: surface.restHosts },
      });
      const pending = this.grants.makeRegisterPending(
        body.sessionId,
        body.manifest.source,
        surface,
        () => registry.registerExtension(body.manifest),
      );
      return c.json(pending);
    }

    // (3) Non-transport extension (pure skill/workflow) — commit directly + audit.
    await this.state.audit.write({
      type: "source.install",
      sessionId: body.sessionId,
      detail: { source: body.manifest.source, kind: "extension", outcome: "committed" },
    });
    const result = await registry.registerExtension(body.manifest);
    this.state.events.publish({
      type: "manifest_changed",
      revision: registry.revision(),
    });
    return c.json(result);
  };

  /**
   * DELETE /extensions/:source — unregister a runtime-registered extension (security
   * review fork #3). Calls m4sec-reg's `registry.unregister`, bumps the revision, and
   * audits. Authorization: the management connection-key (the user's removal action)
   * OR a live handshake session header — removing a malicious extension must not itself
   * require the agent that installed it.
   */
  deleteExtension = async (c: Context) => {
    const source = c.req.param("source");
    if (!source) return fail(c, "internal_error", "missing :source");

    // AUTH: a management connection-key, or a live session (X-Plexus-Session). The
    // unregister action removes capability surface; it is a custodial action.
    const connectionKey =
      c.req.header("x-plexus-connection-key") ?? c.req.header("X-Plexus-Connection-Key");
    const hasManagementAuth = !!connectionKey && this.state.connectionKey.verify(connectionKey);
    const sessionId = c.req.header("x-plexus-session") ?? c.req.header("X-Plexus-Session");
    const sessionLive = sessionId ? this.state.sessions.liveness(sessionId).live : false;
    if (!hasManagementAuth && !sessionLive) {
      return fail(
        c,
        "session_expired",
        "DELETE /extensions requires a management connection-key or a live session",
      );
    }

    const registry = this.state.capabilities;
    if (typeof registry.unregister !== "function") {
      return fail(c, "internal_error", "unregister is not available in this build");
    }
    const removed = await registry.unregister(source);

    // PURGE LINGERING GRANTS (security review must-fix #7). Removing the capability
    // surface is not enough: a persisted grant for a removed id would let a future
    // re-registration of the SAME id silently re-use the old human approval
    // (`hasPriorApproval`). Drop every grant (and synthesized member grant) for each
    // removed id so a re-registration must be re-confirmed from scratch.
    let purgedGrants = 0;
    for (const id of removed) {
      purgedGrants += this.state.grants.removeForCapability(id);
    }

    await this.state.audit.write({
      type: "source.install",
      ...(sessionId ? { sessionId } : {}),
      detail: { source, kind: "extension", outcome: "unregistered", removed: removed.length, purgedGrants },
    });
    if (removed.length > 0) {
      this.state.events.publish({
        type: "manifest_changed",
        revision: registry.revision(),
      });
    }
    return c.json({ ok: removed.length > 0, source, removed });
  };
}
