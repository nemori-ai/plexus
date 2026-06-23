/**
 * Scoped-token sign/verify (§4, ADR-006).
 *
 * WIRE FORMAT = signed JWT (HS256, gateway-held per-install secret) + a
 * server-side `jti` revocation registry so grants can be revoked before `exp`.
 * Default lifetime 15 min (ADR-006, locked); kept long-lived via grant-backed
 * refresh (ADR-011).
 *
 * The JWT is implemented directly over Node `crypto` (HMAC-SHA256) — no external
 * dependency. Self-contained to verify (stateless signature + exp), BUT every jti
 * is tracked in the revocation registry so the invoke pipeline can refuse a
 * revoked token before `exp`.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ScopedTokenClaims, TokenScope } from "../protocol/index.ts";
import { getSigningSecret } from "./secret.ts";
import { homePath, readFileBestEffort, atomicWrite } from "../core/paths.ts";

/** Default scoped-token lifetime — 15 minutes (ADR-006). The config-backed FALLBACK. */
export const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

/**
 * The configured (clamped) token lifetime, set once at boot from
 * `config.auth.tokenLifetimeMs` (ADR-018). Until set, `signToken` falls back to
 * `TOKEN_LIFETIME_MS`. Config-overridable but CLAMPED at load to [1m, 60m] — a
 * short token is a security invariant, so this is never agent-choosable nor
 * per-approval.
 */
let configuredTokenLifetimeMs: number | undefined;

/** Install the boot-resolved (already-clamped) token lifetime for `signToken`'s default. */
export function setConfiguredTokenLifetimeMs(ms: number): void {
  if (typeof ms === "number" && Number.isFinite(ms)) configuredTokenLifetimeMs = ms;
}

/** The token lifetime `signToken` defaults to: the configured value, else the constant. */
export function effectiveTokenLifetimeMs(): number {
  return configuredTokenLifetimeMs ?? TOKEN_LIFETIME_MS;
}

/** JWT signing scheme advertised in `.well-known` auth (`tokenScheme`). */
export const TOKEN_SCHEME = "plexus-scoped-jwt" as const;

/**
 * Bounded grace (seconds) past `exp` for which `verifyTokenForRefresh` still
 * accepts a signature-valid token (refresh ONLY — never for invoke). Lets a
 * just-expired token be re-minted from its persisted grant without re-handshake.
 */
export const REFRESH_GRACE_SECONDS = 5 * 60;

/** Inputs needed to mint a scoped-token (the gateway fills jti/iat/exp). */
export interface MintTokenInput {
  /** Agent identity (becomes JWT `sub`). */
  sub: string;
  /** Issuer — this gateway instance id. */
  iss: string;
  sessionId: string;
  scopes: TokenScope[];
  /** Override lifetime (ms); defaults to TOKEN_LIFETIME_MS. */
  lifetimeMs?: number;
  /** Override jti (else a fresh uuid). */
  jti?: string;
  /**
   * The backing grant/trust-window expiry (epoch ms) — the standing-trust ceiling
   * the token refreshes up to (ADR-018). When supplied, emitted as the `gexp`
   * diagnostic claim (epoch SECONDS). Omitted for a "once" grant that does not stand.
   */
  grantExpiresAtMs?: number;
}

// ── base64url helpers ───────────────────────────────────────────────────────

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function hmacSign(signingInput: string): string {
  return createHmac("sha256", getSigningSecret()).update(signingInput).digest("base64url");
}

// ── sign / verify ───────────────────────────────────────────────────────────

/**
 * Sign a scoped-token (HS256). Returns the compact JWT string + decoded claims.
 */
export function signToken(input: MintTokenInput): { token: string; claims: ScopedTokenClaims } {
  const nowSec = Math.floor(Date.now() / 1000);
  const lifetime = input.lifetimeMs ?? effectiveTokenLifetimeMs();
  const claims: ScopedTokenClaims = {
    sub: input.sub,
    iss: input.iss,
    sessionId: input.sessionId,
    jti: input.jti ?? `tok_${randomUUID()}`,
    scopes: input.scopes,
    iat: nowSec,
    exp: nowSec + Math.floor(lifetime / 1000),
    ...(typeof input.grantExpiresAtMs === "number" && Number.isFinite(input.grantExpiresAtMs)
      ? { gexp: Math.floor(input.grantExpiresAtMs / 1000) }
      : {}),
  };
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const token = `${signingInput}.${hmacSign(signingInput)}`;
  return { token, claims };
}

/** A token whose signature is valid but whose `exp` has passed. */
export class TokenExpiredError extends Error {
  readonly code = "token_expired" as const;
  constructor(message = "token expired") {
    super(message);
    this.name = "TokenExpiredError";
  }
}

/** A token that is malformed or whose signature does not verify. */
export class TokenInvalidError extends Error {
  readonly code = "token_invalid" as const;
  constructor(message = "token invalid") {
    super(message);
    this.name = "TokenInvalidError";
  }
}

/** Verify signature only (constant-time), return decoded claims; throws on failure. */
function verifySignature(token: string): ScopedTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenInvalidError("malformed JWT (expected 3 segments)");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = hmacSign(signingInput);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TokenInvalidError("signature verification failed");
  }
  let claims: ScopedTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ScopedTokenClaims;
  } catch {
    throw new TokenInvalidError("payload is not valid JSON");
  }
  return claims;
}

/**
 * Verify a compact JWT: signature + expiry. Does NOT consult the revocation
 * registry — the invoke pipeline checks `jti` revocation + session liveness
 * separately (§4/§5b). Throws `TokenExpiredError` / `TokenInvalidError`.
 */
export function verifyToken(token: string): ScopedTokenClaims {
  const claims = verifySignature(token);
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
    throw new TokenExpiredError();
  }
  return claims;
}

/**
 * Refresh-only verification (ADR-011): accepts a signature-valid token even just
 * past `exp`, within `REFRESH_GRACE_SECONDS`. NEVER used for invoke. Throws
 * `TokenInvalidError` on bad signature, `TokenExpiredError` only past the grace.
 */
export function verifyTokenForRefresh(token: string): ScopedTokenClaims {
  const claims = verifySignature(token);
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + REFRESH_GRACE_SECONDS <= nowSec) {
    throw new TokenExpiredError("token past refresh grace window");
  }
  return claims;
}

// ── revocation registry ─────────────────────────────────────────────────────

const REVOCATION_FILE = "revoked-jtis.json";

interface RevocationRecord {
  jti: string;
  reason?: string;
  at: string;
}

/**
 * The server-side `jti` revocation registry (ADR-006/010). Self-contained JWTs
 * stay revocable before `exp`; the set is persisted to `~/.plexus/` (best-effort)
 * so a restart does not resurrect revoked tokens within their lifetime.
 */
export interface RevocationRegistry {
  isRevoked(jti: string): boolean;
  revoke(jti: string, reason?: string): void;
  /** All currently-revoked jtis (diagnostics/tests). */
  list(): string[];
}

class FileRevocationRegistry implements RevocationRegistry {
  private readonly revoked = new Map<string, RevocationRecord>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    const raw = readFileBestEffort(path);
    if (raw) {
      try {
        const records = JSON.parse(raw) as RevocationRecord[];
        for (const r of records) this.revoked.set(r.jti, r);
      } catch {
        /* corrupt/partial file — start empty, will be overwritten on next revoke */
      }
    }
  }

  isRevoked(jti: string): boolean {
    return this.revoked.has(jti);
  }

  revoke(jti: string, reason?: string): void {
    if (this.revoked.has(jti)) return;
    this.revoked.set(jti, { jti, ...(reason ? { reason } : {}), at: new Date().toISOString() });
    this.persist();
  }

  list(): string[] {
    return [...this.revoked.keys()];
  }

  private persist(): void {
    try {
      atomicWrite(this.path, JSON.stringify([...this.revoked.values()]));
    } catch {
      /* best-effort */
    }
  }
}

export function createRevocationRegistry(): RevocationRegistry {
  return new FileRevocationRegistry(homePath(REVOCATION_FILE));
}
