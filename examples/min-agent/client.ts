/**
 * ============================================================================
 * Plexus minimal AI-agent protocol client (t12 harness).
 * ============================================================================
 *
 * A small, dependency-light TypeScript client implementing the AGENT SIDE of the
 * Plexus M0 protocol (v0.1.1) — the full
 *
 *     DISCOVER → handshake (UNDERSTAND) → requestGrants (GRANTED) → invoke (CALL)
 *
 * loop. This is the proof that "any AI agent can self-discover and call a local
 * capability" by speaking ONLY the published wire contract. It imports the FROZEN
 * protocol types from `src/protocol` and uses them verbatim — it does not depend
 * on any gateway-internal module.
 *
 * Transport injection (so this client works BOTH ways):
 *   - against a REAL booted gateway:  pass `{ baseUrl: "http://127.0.0.1:7077" }`
 *     (uses the global `fetch`).
 *   - in-process for tests:           pass `{ baseUrl, fetch: app.request }` where
 *     `app` is the gateway's Hono app — `app.request` is fetch-shaped.
 *
 * Security contract this client honors (see PLEXUS-PROTOCOL.md §5):
 *   - It ALWAYS sends `Host: 127.0.0.1:<port>` (the loopback authority) — the
 *     gateway's host/origin guard rejects anything else with `host_forbidden`.
 *   - It reads every endpoint URL from the `.well-known` `auth` advertisement
 *     rather than hard-coding paths (ADR-016).
 *   - It presents the connection-key ONLY at handshake; thereafter it holds a
 *     short-lived scoped-token and presents it as `Authorization: Bearer <token>`
 *     on invoke (NEVER the connection-key again).
 */

import type {
  WellKnownDocument,
  HandshakeRequest,
  HandshakeResponse,
  Manifest,
  CapabilityEntry,
  CapabilitySummary,
  GrantRequest,
  GrantDecision,
  GrantResponse,
  GrantPendingResponse,
  GrantStatusResponse,
  ScopedToken,
  GrantVerb,
  TrustWindow,
  CapabilityId,
  InvokeRequest,
  InvokeResponse,
  RefreshRequest,
  RefreshResponse,
  ManifestRefreshResponse,
  ErrorResponse,
  ErrorBody,
  ErrorCode,
} from "@plexus/protocol";

// ── Transport injection ───────────────────────────────────────────────────────

/** A fetch-shaped function. The global `fetch` and Hono's `app.request` both fit. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface PlexusClientOptions {
  /** The loopback base URL the gateway is bound to, e.g. "http://127.0.0.1:7077". */
  baseUrl: string;
  /**
   * The fetch implementation. Defaults to the global `fetch` (real network).
   * Tests inject a Hono app's `app.request` to drive the gateway in-process.
   */
  fetch?: FetchLike;
  /** Agent identity stamped into the handshake audit trail. */
  client?: HandshakeRequest["client"];
}

// ── A typed protocol error the agent can branch on ─────────────────────────────

/**
 * Thrown when the gateway returns a uniform `ErrorResponse` envelope (i.e. an
 * endpoint-level failure, not an in-band `InvokeResponse{ok:false}`). Carries the
 * closed-union `ErrorCode` so the agent branches its recovery deterministically.
 */
export class PlexusProtocolError extends Error {
  readonly code: ErrorCode;
  readonly capabilityId?: CapabilityId;
  readonly status: number;
  readonly body: ErrorBody;
  constructor(status: number, body: ErrorBody) {
    super(`[${body.code}] ${body.message}`);
    this.name = "PlexusProtocolError";
    this.code = body.code;
    this.status = status;
    this.body = body;
    if (body.capabilityId) this.capabilityId = body.capabilityId;
  }
}

/** Narrow an unknown JSON body to the uniform `ErrorResponse` envelope. */
function isErrorResponse(x: unknown): x is ErrorResponse {
  return (
    typeof x === "object" &&
    x !== null &&
    "error" in x &&
    typeof (x as ErrorResponse).error?.code === "string"
  );
}

/** Discriminate a `PUT /grants` response: pending vs. a minted scoped-token. */
export function isGrantPending(r: GrantResponse): r is GrantPendingResponse {
  return (r as GrantPendingResponse).status === "grant_pending_user";
}

// ── The client ─────────────────────────────────────────────────────────────────

/**
 * The agent-side Plexus protocol client. Construct it with a base URL (and,
 * optionally, an injected fetch + agent identity), then drive the loop:
 *
 *     const wk   = await client.discover();
 *     const hs   = await client.handshake(connectionKey);
 *     const tok  = await client.requestGrants(["obsidian.vault.read"]); // read by default
 *     const out  = await client.invoke("obsidian.vault.read", { path: "Index.md" });
 */
export class PlexusClient {
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly clientIdentity?: HandshakeRequest["client"];

  /** The loopback authority sent as the `Host` header on every request. */
  private readonly hostAuthority: string;

  /** Populated by `discover()` — the endpoint advertisement the agent reads URLs from. */
  private wellKnown?: WellKnownDocument;
  /** Populated by `handshake()` — the live session + last-known full manifest. */
  private sessionId?: string;
  private manifest?: Manifest;
  /** Populated by `requestGrants()` — the current short-lived scoped-token. */
  private token?: ScopedToken;

  constructor(opts: PlexusClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.doFetch = opts.fetch ?? ((globalThis as { fetch: FetchLike }).fetch);
    if (opts.client) this.clientIdentity = opts.client;
    // The Host header MUST equal the bound loopback authority (host/origin guard).
    this.hostAuthority = new URL(this.baseUrl).host;
  }

  // ── low-level request helper ────────────────────────────────────────────────

  /**
   * Issue one request, ALWAYS attaching the correct `Host` header. Parses the JSON
   * body; on a uniform `ErrorResponse` envelope throws a typed `PlexusProtocolError`
   * (unless `tolerateError` is set, e.g. for `/invoke` whose `ok:false` arrives with
   * a 200 + in-band error body the caller wants to inspect).
   */
  private async request<T>(
    url: string,
    init: RequestInit & { tolerateError?: boolean } = {},
  ): Promise<T> {
    const { tolerateError, ...rest } = init;
    const res = await this.doFetch(url, {
      ...rest,
      headers: {
        host: this.hostAuthority,
        "content-type": "application/json",
        ...(rest.headers ?? {}),
      },
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new PlexusProtocolError(res.status, {
        code: "internal_error",
        message: `non-JSON response (${res.status}): ${text.slice(0, 200)}`,
      });
    }
    if (!tolerateError && isErrorResponse(parsed)) {
      throw new PlexusProtocolError(res.status, parsed.error);
    }
    return parsed as T;
  }

  /** Resolve an endpoint URL: prefer the `.well-known` advertisement, else derive it. */
  private endpoint(
    key: keyof WellKnownDocument["auth"],
    fallbackPath: string,
  ): string {
    const advertised = this.wellKnown?.auth?.[key];
    if (typeof advertised === "string" && advertised.length > 0) return advertised;
    return this.baseUrl + fallbackPath;
  }

  // ── 1. DISCOVER ─────────────────────────────────────────────────────────────

  /**
   * `GET /.well-known/plexus` — the pre-session, unauthenticated advertisement.
   * Returns the gateway identity + a SUMMARY capability list (enough to window-shop,
   * not enough to call) + the auth/endpoint advertisement. Caches the doc so later
   * calls can read endpoint URLs from it.
   */
  async discover(): Promise<WellKnownDocument> {
    const doc = await this.request<WellKnownDocument>(
      this.baseUrl + "/.well-known/plexus",
      { method: "GET" },
    );
    this.wellKnown = doc;
    return doc;
  }

  /** The cached discovery summaries (call `discover()` first). */
  summaries(): CapabilitySummary[] {
    return this.wellKnown?.capabilities ?? [];
  }

  // ── 2. UNDERSTAND (handshake → full manifest) ────────────────────────────────

  /**
   * `POST /link/handshake` — exchange the user-pasted connection-key for a session
   * and the FULL manifest (every entry with full describe / io / grants / transport
   * / attached skill bodies). After this the agent holds session knowledge but ZERO
   * call authority (default-deny) until it requests a grant.
   */
  async handshake(connectionKey: string): Promise<HandshakeResponse> {
    const body: HandshakeRequest = {
      connectionKey,
      ...(this.clientIdentity ? { client: this.clientIdentity } : {}),
    };
    const res = await this.request<HandshakeResponse>(
      this.endpoint("handshakeUrl", "/link/handshake"),
      { method: "POST", body: JSON.stringify(body) },
    );
    this.sessionId = res.sessionId;
    this.manifest = res.manifest;
    return res;
  }

  /** The full entries from the last handshake / manifest refresh. */
  entries(): CapabilityEntry[] {
    return this.manifest?.entries ?? [];
  }

  /** Look up a full entry by id from the held manifest (to read its `describe` / `io` / `grants`). */
  entry(id: CapabilityId): CapabilityEntry | undefined {
    return this.manifest?.entries.find((e) => e.id === id);
  }

  /** The live session id (after handshake). */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** The current scoped-token (after a successful grant). */
  getToken(): ScopedToken | undefined {
    return this.token;
  }

  // ── 3. GRANTED (requestGrants → scoped-token) ────────────────────────────────

  /**
   * `PUT /grants` — request grants for the given capability ids. By default each id
   * is requested with the entry's REQUIRED verbs (read by default for a read-only
   * entry); pass an explicit `verbs` array to override (e.g. ["write"] / ["execute"]).
   *
   * Returns the minted `ScopedToken` on approval. If the configured Authorizer
   * defers any grant, this transparently handles the `grant_pending_user` path by
   * polling `GET /grants/status` until the decision is terminal (or throws if denied
   * / expired). The minted token is cached and presented on subsequent `invoke()`s.
   */
  async requestGrants(
    ids: CapabilityId[],
    opts?: {
      verbs?: GrantVerb[];
      pollTimeoutMs?: number;
      pollIntervalMs?: number;
      /**
       * Advisory trust-window proposed on each grant (ADR-018). On the agent path
       * it is advisory only — the authorizer/human may SHORTEN it, never lengthen it
       * past the per-class ceiling.
       */
      trustWindow?: TrustWindow;
      /**
       * Free-text "why now" the agent declares to the human (AUTHZ-UX §2.N1). Shown
       * labeled "the agent says:" in the approval UI, kept SEPARATE from the gateway
       * narration. TRANSPARENCY ONLY — it influences no authorization decision; the
       * gateway sanitizes + truncates it server-side. Applied to each requested id.
       */
      purpose?: string;
      /**
       * Invoked once if the gateway DEFERS the grant (`grant_pending_user`), BEFORE
       * polling begins. Receives the gateway-authored narration so a caller (e.g. the
       * `plexus` CLI) can relay the truthful one-liner to the human before the poll.
       */
      onPending?: (pending: GrantPendingResponse) => void,
    },
  ): Promise<ScopedToken> {
    if (!this.sessionId) {
      throw new PlexusProtocolError(400, {
        code: "session_expired",
        message: "requestGrants() called before handshake()",
      });
    }
    const grants: Record<CapabilityId, GrantDecision | "allow"> = {};
    const purpose = opts?.purpose && opts.purpose.trim() ? opts.purpose : undefined;
    for (const id of ids) {
      if (opts?.verbs && opts.verbs.length > 0) {
        grants[id] = {
          decision: "allow",
          verbs: opts.verbs,
          ...(opts?.trustWindow ? { trustWindow: opts.trustWindow } : {}),
          ...(purpose ? { purpose } : {}),
        };
      } else if (opts?.trustWindow || purpose) {
        // Carry the advisory trust-window / declared purpose even on the read-only path.
        grants[id] = {
          decision: "allow",
          ...(opts?.trustWindow ? { trustWindow: opts.trustWindow } : {}),
          ...(purpose ? { purpose } : {}),
        };
      } else {
        // Bare "allow" → the gateway normalizes to the entry's required verbs
        // (read-only default).
        grants[id] = "allow";
      }
    }
    const body: GrantRequest = { sessionId: this.sessionId, grants };
    const res = await this.request<GrantResponse>(
      this.endpoint("grantsUrl", "/grants"),
      { method: "PUT", body: JSON.stringify(body) },
    );

    if (isGrantPending(res)) {
      opts?.onPending?.(res);
      const token = await this.awaitPending(res, opts);
      this.token = token;
      return token;
    }
    this.token = res;
    return res;
  }

  /**
   * Poll `GET /grants/status?pendingId=…` until the pending decision is terminal.
   * Returns the minted token on approval; throws `grant_required` on deny/expired.
   */
  private async awaitPending(
    pending: GrantPendingResponse,
    opts?: { pollTimeoutMs?: number; pollIntervalMs?: number },
  ): Promise<ScopedToken> {
    const timeoutMs = opts?.pollTimeoutMs ?? 10_000;
    const intervalMs = opts?.pollIntervalMs ?? 200;
    const statusBase = this.endpoint("grantStatusUrl", "/grants/status");
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const url = `${statusBase}?pendingId=${encodeURIComponent(pending.pendingId)}`;
      const status = await this.request<GrantStatusResponse>(url, { method: "GET" });
      if (status.state === "approved" && status.token) return status.token;
      if (status.state === "denied" || status.state === "expired") {
        throw new PlexusProtocolError(401, {
          code: "grant_required",
          message: `grant ${status.state} for ${status.capabilities.join(", ")}`,
        });
      }
      if (Date.now() > deadline) {
        throw new PlexusProtocolError(408, {
          code: "grant_pending_user",
          message: `grant still pending after ${timeoutMs}ms for ${pending.pending.join(", ")}`,
        });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // ── 4. CALL (invoke) ─────────────────────────────────────────────────────────

  /**
   * `POST /invoke` — call a granted capability, presenting the scoped-token as
   * `Authorization: Bearer <token>`. Returns the normalized `InvokeResponse`.
   *
   * ONE result contract (protocol v0.1.1 / ADR-017): /invoke ALWAYS returns an
   * `InvokeResponse`-shaped body — `{ id, ok, … }` on success, and `{ id, ok:false,
   * error:{code,message,…}, auditId }` on EVERY denial (auth/pre-dispatch OR
   * transport). So this client reads `ok` directly with NO envelope→{ok,error}
   * normalization: a denial is just `ok:false` with `error.code` the closed-union
   * code, and the HTTP status (401/404/422/…) still distinguishes the failure class
   * for callers that branch on it. Pass an explicit token to override the cached one
   * (e.g. an un-granted token, to prove denial).
   */
  async invoke(
    id: CapabilityId,
    input?: Record<string, unknown>,
    opts?: { token?: ScopedToken; idempotencyKey?: string },
  ): Promise<InvokeResponse> {
    const token = opts?.token ?? this.token;
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token.token}`;
    const body: InvokeRequest = {
      id,
      ...(input ? { input } : {}),
      ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    };
    // `tolerateError` keeps `request()` from throwing on a 4xx denial: /invoke's
    // denial body is `InvokeResponse`-shaped (`ok:false` + `error`), not the uniform
    // `ErrorResponse` envelope, so the agent inspects `res.ok` / `res.error` itself.
    return this.request<InvokeResponse>(this.endpoint("invokeUrl", "/invoke"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      tolerateError: true,
    });
  }

  /**
   * Like `invoke()` but raises a `PlexusProtocolError` for BOTH the uniform
   * `ErrorResponse` envelope AND an in-band `{ ok:false, error }` — convenient when
   * the agent wants a single throw-on-failure call path.
   */
  async invokeOrThrow(
    id: CapabilityId,
    input?: Record<string, unknown>,
    opts?: { token?: ScopedToken; idempotencyKey?: string },
  ): Promise<InvokeResponse> {
    const res = await this.invoke(id, input, opts);
    if (!res.ok && res.error) {
      throw new PlexusProtocolError(200, res.error);
    }
    return res;
  }

  // ── lifecycle: refresh + manifest re-fetch ───────────────────────────────────

  /**
   * `POST /grants/refresh` — re-mint a fresh short-lived token from the persisted
   * grant, presenting the (possibly just-expired) token as Bearer. No connection-key,
   * no re-prompt. Updates the cached token.
   */
  async refresh(): Promise<RefreshResponse> {
    if (!this.sessionId || !this.token) {
      throw new PlexusProtocolError(400, {
        code: "token_expired",
        message: "refresh() called before a grant was held",
      });
    }
    const body: RefreshRequest = { sessionId: this.sessionId, jti: this.token.jti };
    const res = await this.request<RefreshResponse>(
      this.endpoint("refreshUrl", "/grants/refresh"),
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.token.token}` },
        body: JSON.stringify(body),
      },
    );
    // Fold the re-mint back into the cached scoped-token (same scopes, new jti/exp).
    this.token = {
      token: res.token,
      scopes: res.scopes,
      jti: res.jti,
      expiresAt: res.expiresAt,
    };
    return res;
  }

  /**
   * `GET /manifest` — refresh the full manifest snapshot WITHOUT re-handshaking
   * (session-authenticated via the `X-Plexus-Session` header). Use after a
   * `manifest_changed` event or when staleness is suspected. Updates the held manifest.
   */
  async refreshManifest(): Promise<Manifest> {
    if (!this.sessionId) {
      throw new PlexusProtocolError(400, {
        code: "session_expired",
        message: "refreshManifest() called before handshake()",
      });
    }
    const res = await this.request<ManifestRefreshResponse>(
      this.endpoint("manifestUrl", "/manifest"),
      { method: "GET", headers: { "x-plexus-session": this.sessionId } },
    );
    this.manifest = res.manifest;
    return res.manifest;
  }
}
