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
  GrantsListResponse,
} from "../protocol/index.ts";
import type { GatewayState } from "./state.ts";
import { GrantService } from "./grant-service.ts";
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
    case "session_expired":
    case "token_expired":
    case "token_revoked":
    case "grant_required":
    case "grant_pending_user":
      return 401;
    case "unknown_capability":
      return 404;
    case "schema_validation_failed":
      return 422;
    case "rate_limited":
      return 429;
    case "source_unavailable":
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

  constructor(
    private readonly state: GatewayState,
    authorizer: Authorizer,
  ) {
    this.grants = new GrantService(state, authorizer);
    this.pipeline = new InvokePipeline(state);
  }

  /** POST /link/handshake — connection-key → session + full Manifest. */
  handshake = async (c: Context) => {
    let body: HandshakeRequest;
    try {
      body = (await c.req.json()) as HandshakeRequest;
    } catch {
      return fail(c, "internal_error", "invalid JSON body");
    }
    if (!body?.connectionKey || !this.state.connectionKey.verify(body.connectionKey)) {
      // Auth failure on the bootstrap secret — not a closed-union recovery code;
      // surface as session_expired so the agent re-acquires the key.
      return fail(c, "session_expired", "invalid or missing connection-key");
    }
    const session = this.state.sessions.open(body.connectionKey, body.client);
    await this.state.audit.write({
      type: "handshake",
      ...(session.agentId ? { agentId: session.agentId } : {}),
      sessionId: session.id,
      detail: { client: body.client?.name, version: body.client?.version },
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

  /** PUT /grants — authorizer → scoped-token or grant_pending_user. */
  putGrants = async (c: Context) => {
    let body: GrantRequest;
    try {
      body = (await c.req.json()) as GrantRequest;
    } catch {
      return fail(c, "internal_error", "invalid JSON body");
    }
    const session = this.state.sessions.get(body.sessionId);
    const liveness = this.state.sessions.liveness(body.sessionId);
    if (!session || !liveness.live) {
      return fail(c, "session_expired", liveness.reason ?? "unknown session");
    }
    const result = await this.grants.grant(body, session);
    // grant_pending_user → 401-ish? It's a normal (non-error) protocol response.
    return c.json(result);
  };

  /** GET /grants/status?pendingId=… */
  grantStatus = (c: Context) => {
    const pendingId = c.req.query("pendingId");
    if (!pendingId) return fail(c, "internal_error", "missing pendingId");
    const status = this.grants.status(pendingId);
    if (!status) return fail(c, "unknown_capability", `No pending grant '${pendingId}'.`);
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
    if (!body.jti && !(body.agentId && body.capabilityId)) {
      return fail(c, "internal_error", "revoke requires `jti` or both `agentId`+`capabilityId`");
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
    if (!token) return invokeFail(c, id, "grant_required", "missing Authorization bearer token");

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
        // the audited denial's id + auditId (tp2 / ADR-017).
        return invokeFail(
          c,
          e.capabilityId ?? body.id ?? id,
          e.body.code,
          e.body.message,
          e.auditId,
        );
      }
      return invokeFail(c, body.id ?? id, "internal_error", e instanceof Error ? e.message : String(e));
    }
    return c.json(response, 200);
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

  /** GET /events — SSE stream of PlexusEvents. */
  events = (c: Context) => {
    const stream = new ReadableStream({
      start: (controller) => {
        const enc = new TextEncoder();
        const send = (event: { type: string }) => {
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
