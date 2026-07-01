/**
 * T12 — Connection-auth handshake (Ed25519 MUTUAL AUTH that binds the tunnel socket)
 * — federated-mesh §7 Q2 ("mutually authenticated tunnel", pubkeys pinned at
 * enrollment), Invariant E. SECURITY-CRITICAL.
 *
 * THE HOLE THIS CLOSES. The raw tunnel mux (`tunnel.ts`) is identity-agnostic: before
 * this layer, ANY ws connection could open a socket and the proxy's tunnel-trust
 * ingress would execute ANY `invoke` arriving on it (authority already terminated at
 * the primary — Inv E). That made the socket itself the trust boundary while NOTHING
 * authenticated the socket. This module is the gate: at connection OPEN, before a
 * single `invoke`/`audit`/`catalog` frame is honored, both ends prove their pinned
 * Ed25519 identity to each other. Only an authenticated socket is promoted to carry
 * data frames; an unauthenticated/unenrolled socket is dropped (fail-closed).
 *
 * TWO LEGS, run lock-step by the dialing PROXY (NAT-forced — the proxy speaks first):
 *
 *   1. ENROLL (only on first join, when a one-time join token is in hand). The proxy
 *      sends its signed `EnrollRequest`; the primary runs the LIVE `admit()` (H1),
 *      pinning the proxy's pubkey + consuming the token, and signs the mutual reply.
 *      The proxy enforces the MANDATORY primary-key pin (M1) via `verifyEnrollAccepted`.
 *      Enrolling alone does NOT authenticate the socket — leg 2 still runs.
 *
 *   2. CHALLENGE/RESPONSE (every connect). A fresh mutual challenge binds THIS socket:
 *        proxy → `auth-init`     { workload, cnonce }
 *        primary → `auth-challenge` { snonce, sig_primary }   sig over (workload,cnonce,snonce)
 *        proxy → `auth-response` { sig_proxy }                sig over (workload,cnonce,snonce)
 *        primary → `auth-ok`
 *      • The PRIMARY verifies sig_proxy against the `pinnedProxyPubKey` from the
 *        enrollment ledger — an unenrolled/unknown workload has NO pin ⇒ rejected.
 *      • The PROXY verifies sig_primary against its pinned `upstream.primaryPubKey`
 *        (M1, mandatory) — a substituted primary key (MITM) ⇒ rejected.
 *      • BOTH nonces are fresh per connection, so neither side's signature can be
 *        replayed onto a different socket. The authenticated `workload` is bound to
 *        the socket for its lifetime.
 *
 * The handshake messages are a module-local discriminated union keyed by `h` (NOT the
 * `Frame` union keyed by `t`) — they ride the raw socket in a distinct pre-mux phase,
 * keeping the tunnel mux identity-agnostic. The tunnel drives an opaque
 * `HandshakeDriver` (below) and never sees the crypto; ALL auth logic lives here.
 *
 * This is the SECOND trust boundary (Ed25519). The agent↔primary HS256 JWT wire is a
 * SEPARATE boundary this module never touches.
 */

import { randomBytes } from "node:crypto";

import type {
  EnrollFramePayload,
  HealthReportingCapability,
  NegotiatedHealthReporting,
} from "@plexus/protocol";

import { verify, type MeshIdentity } from "./keys.ts";
import {
  buildEnrollRequest,
  verifyEnrollAccepted,
  type EnrollOutcome,
  type SignedEnrollRequest,
} from "./enrollment.ts";

// ── Tunnel-facing driver contract (identity-agnostic) ──────────────────────────

/**
 * Directives the tunnel acts on after feeding one inbound handshake message:
 *   • `send`     — a raw message to write back to the peer.
 *   • `done`     — the handshake succeeded; promote the socket to carry data frames.
 *   • `workload` — the authenticated peer workload (the primary learns this on `done`).
 *   • `fail`     — fail-closed; the tunnel MUST drop the socket (no data frames ever).
 */
export interface HandshakeStep {
  send?: string;
  done?: boolean;
  workload?: string;
  fail?: string;
  /**
   * The negotiated health-reporting parameters (mesh-health-reporting.md §2), reported on the
   * `done` step when BOTH peers advertised the capability. `undefined` ⇒ health reporting is not
   * active on this connection (bare-heartbeat fallback). Both ends derive the SAME value.
   */
  healthReporting?: NegotiatedHealthReporting;
}

/**
 * The hard ceiling on the negotiated reporting interval (ms). The stale detector uses
 * `interval × 3`, so an unbounded `intervalMs = max(a,b)` would let a peer push the stale window
 * arbitrarily high — suppressing `stale` while withholding real reports but keeping `lastSeen`
 * fresh with bare pings. Clamping here bounds the report-staleness path (the ~45s idle sweep
 * still bounds a fully-silent proxy). mesh-health-reporting.md §4/§5.
 */
export const MAX_NEGOTIATED_INTERVAL_MS = 60_000;

/**
 * A health-reporting advertisement is only honored when it is STRUCTURALLY VALID: a finite,
 * positive `version` AND `intervalMs`. Fail-closed — a peer advertising `healthReporting:{}` /
 * `{version:1}` (interval omitted), or any non-finite/≤0 field (a buggy or hostile client), is
 * treated as NO advert. Without this a `NaN`/partial advert would flow through negotiation into
 * `setInterval(send, NaN)` (NaN → 0 delay → a health-frame flood / CPU spin) — an
 * accidentally-triggerable DoS armed by one field in `auth-init`.
 */
function isValidHealthAdvert(a: HealthReportingCapability | undefined): a is HealthReportingCapability {
  return (
    !!a &&
    typeof a.version === "number" &&
    Number.isFinite(a.version) &&
    a.version > 0 &&
    typeof a.intervalMs === "number" &&
    Number.isFinite(a.intervalMs) &&
    a.intervalMs > 0
  );
}

/**
 * Derive the negotiated health-reporting parameters from the two advertisements. Enabled ONLY
 * when BOTH peers advertise a STRUCTURALLY-VALID capability (mutual + fail-closed shape check):
 * `version = min` (speak the lower common version), `intervalMs = max` (neither peer is forced to
 * report faster than it asked), then CLAMPED to `MAX_NEGOTIATED_INTERVAL_MS` so the stale detector
 * can't be defeated. Either side absent/malformed ⇒ `undefined` (bare-heartbeat fallback, backward
 * compatible — a bad advert can never arm a 0-delay loop downstream).
 */
export function negotiateHealthReporting(
  a: HealthReportingCapability | undefined,
  b: HealthReportingCapability | undefined,
): NegotiatedHealthReporting | undefined {
  if (!isValidHealthAdvert(a) || !isValidHealthAdvert(b)) return undefined;
  const intervalMs = Math.min(Math.max(a.intervalMs, b.intervalMs), MAX_NEGOTIATED_INTERVAL_MS);
  return { version: Math.min(a.version, b.version), intervalMs };
}

/**
 * An opaque, per-connection handshake state machine the tunnel drives. The tunnel
 * calls `open()` once on socket open (the proxy returns its first message; the primary
 * returns `undefined` and waits), then feeds every inbound raw message to `next()`
 * until a step reports `done` or `fail`. The driver owns all encoding + crypto.
 */
export interface HandshakeDriver {
  /** First message to send on open, or `undefined` to wait for the peer to speak. */
  open(): string | undefined;
  /** Feed one inbound raw socket message; returns directives for the tunnel. */
  next(raw: string): HandshakeStep;
}

// ── Wire messages (module-local; NOT the protocol `Frame` union) ───────────────

type HandshakeMessage =
  | { h: "enroll"; req: SignedEnrollRequest }
  | { h: "enroll-result"; outcome: EnrollOutcome }
  | { h: "auth-init"; workload: string; cnonce: string; healthReporting?: HealthReportingCapability }
  | { h: "auth-challenge"; snonce: string; sig: string; healthReporting?: HealthReportingCapability }
  | { h: "auth-response"; sig: string }
  | { h: "auth-ok" }
  | { h: "auth-fail"; reason: string };

function encode(m: HandshakeMessage): string {
  return JSON.stringify(m);
}

function decode(raw: string): HandshakeMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { h?: unknown }).h !== "string") {
    throw new Error("mesh/handshake: malformed handshake message (missing `h`)");
  }
  return parsed as HandshakeMessage;
}

// ── Challenge transcript (byte-identical on both ends) ──────────────────────────

/** Domain-separation tags so a primary signature can never be read as a proxy one. */
export const AUTH_PRIMARY_DOMAIN = "plexus-mesh-conn-auth-primary\n";
export const AUTH_PROXY_DOMAIN = "plexus-mesh-conn-auth-proxy\n";

/**
 * The role-tagged bytes both ends sign for the connection challenge. Binds the
 * `workload` (who) + BOTH fresh nonces (anti-replay: each connection's transcript is
 * unique, so a captured signature cannot authenticate a different socket). Exported so
 * security tests can forge/verify a challenge deterministically.
 */
export function authSignedBytes(domain: string, workload: string, cnonce: string, snonce: string): Buffer {
  return Buffer.from(domain + JSON.stringify({ v: 1, workload, cnonce, snonce }), "utf8");
}

function freshNonce(): string {
  return randomBytes(32).toString("base64url");
}

function b64ToBuf(b64: string): Buffer {
  return Buffer.from(typeof b64 === "string" ? b64 : "", "base64");
}

// ── Proxy (client) side ─────────────────────────────────────────────────────────

/** Inputs the proxy needs to authenticate a connection (provided by the runtime). */
export interface ProxyHandshakeDeps {
  /** The workload this proxy claims (the enrollment identity). */
  workload: string;
  /** This proxy's Ed25519 identity (signs the enroll transcript + the auth response). */
  identity: MeshIdentity;
  /** MANDATORY pinned primary key (M1) — the proxy verifies every primary signature against it. */
  pinnedPrimaryPubKey: string;
  /** The proxy's dialed upstream URL (echoed into the enroll transcript). */
  upstreamUrl: string;
  /** A one-time join token, present ONLY on the first join (drives the enroll leg). */
  joinToken?: string;
  /** Called when an enroll is accepted (lets the runtime mark itself enrolled). */
  onEnrolled?: (primaryPubKey: string) => void;
  /**
   * This proxy's health-reporting advertisement (mesh-health-reporting.md §2). Present ⇒ the
   * proxy advertises it in `auth-init`; health reporting activates iff the primary also advertises
   * (the `done` step carries the negotiated result). Absent ⇒ bare-heartbeat fallback.
   */
  healthReporting?: HealthReportingCapability;
}

/**
 * Build the proxy-side handshake driver. Fail-closed: it refuses to even start without
 * a pinned primary key (M1), and aborts on any signature/pin mismatch.
 */
export function createProxyHandshakeDriver(deps: ProxyHandshakeDeps): HandshakeDriver {
  if (!deps.pinnedPrimaryPubKey || deps.pinnedPrimaryPubKey.length === 0) {
    // M1 — a proxy with no pinned primary key must never trust a tunnel (no bare TOFU).
    throw new Error(
      "mesh/handshake: proxy requires a pinned upstream.primaryPubKey (M1 — no silent bare-TOFU)",
    );
  }

  // The enroll claim (when joining) — kept so we can verify the mutual reply transcript.
  const enrollPayload: EnrollFramePayload | undefined = deps.joinToken
    ? {
        workload: deps.workload,
        mode: "proxy",
        proxyPubKey: deps.identity.publicKeyPem,
        joinToken: deps.joinToken,
        upstream: { url: deps.upstreamUrl, primaryPubKey: deps.pinnedPrimaryPubKey },
      }
    : undefined;

  let phase: "enroll" | "auth-init" | "challenged" | "done" | "failed" = enrollPayload
    ? "enroll"
    : "auth-init";
  let cnonce = "";
  // The negotiated health-reporting result, learned from the primary's `auth-challenge`
  // advertisement and surfaced on the `done` step (mesh-health-reporting.md §2).
  let negotiatedHealth: NegotiatedHealthReporting | undefined;

  /** Begin the challenge leg: emit a fresh client nonce (+ the health-reporting advert). */
  const startAuth = (): string => {
    cnonce = freshNonce();
    phase = "auth-init";
    return encode({
      h: "auth-init",
      workload: deps.workload,
      cnonce,
      ...(deps.healthReporting ? { healthReporting: deps.healthReporting } : {}),
    });
  };

  return {
    open(): string | undefined {
      return enrollPayload ? encode({ h: "enroll", req: buildEnrollRequest(enrollPayload, deps.identity) }) : startAuth();
    },
    next(raw: string): HandshakeStep {
      let m: HandshakeMessage;
      try {
        m = decode(raw);
      } catch {
        phase = "failed";
        return { fail: "malformed handshake message" };
      }

      if (m.h === "auth-fail") {
        phase = "failed";
        return { fail: `primary rejected auth: ${m.reason}` };
      }

      if (phase === "enroll" && m.h === "enroll-result") {
        if (!m.outcome.ok) {
          // L-1 — a LOST enroll-result is not fatal. If a prior join already consumed
          // this one-time token (the primary's earlier accept reply never reached us),
          // re-presenting it now yields `token_consumed`. A genuinely-enrolled proxy must
          // NOT be bricked: fall through to the challenge leg, which re-proves identity
          // against the LEDGER-pinned key. The pin still gates correctness — an imposter
          // that never enrolled has NO pin at the primary, so its challenge yields
          // `auth-fail not_enrolled` (still fail-closed). All OTHER reject reasons remain
          // fatal (genuine bad-token / signature / shape failures must not authenticate).
          if (m.outcome.reason === "token_consumed") {
            deps.onEnrolled?.(deps.pinnedPrimaryPubKey);
            return { send: startAuth() };
          }
          phase = "failed";
          return { fail: `enroll rejected: ${m.outcome.reason}` };
        }
        // M1 — verifyEnrollAccepted ALWAYS enforces the pin (the configured primary key
        // is passed explicitly), so a MITM that substitutes its own primary identity is
        // rejected here even though its signature is internally valid.
        if (!verifyEnrollAccepted(enrollPayload!, m.outcome, { pinnedPrimaryPubKey: deps.pinnedPrimaryPubKey })) {
          phase = "failed";
          return { fail: "enroll reply failed mutual auth / pin check (MITM?)" };
        }
        deps.onEnrolled?.(m.outcome.primaryPubKey);
        return { send: startAuth() };
      }

      if (phase === "auth-init" && m.h === "auth-challenge") {
        // Verify the primary's challenge against the MANDATORY pinned key (M1).
        const ok = verify(
          deps.pinnedPrimaryPubKey,
          authSignedBytes(AUTH_PRIMARY_DOMAIN, deps.workload, cnonce, m.snonce),
          b64ToBuf(m.sig),
        );
        if (!ok) {
          phase = "failed";
          return { fail: "primary challenge failed pinned-key verification (MITM?)" };
        }
        // NEGOTIATE health reporting: active iff the primary ALSO advertised (mutual). The extra
        // field is ignored by a pre-health primary (undefined ⇒ fallback), so this is additive.
        negotiatedHealth = negotiateHealthReporting(deps.healthReporting, m.healthReporting);
        const sig = deps.identity
          .sign(authSignedBytes(AUTH_PROXY_DOMAIN, deps.workload, cnonce, m.snonce))
          .toString("base64");
        phase = "challenged";
        return { send: encode({ h: "auth-response", sig }) };
      }

      if (phase === "challenged" && m.h === "auth-ok") {
        phase = "done";
        return { done: true, ...(negotiatedHealth ? { healthReporting: negotiatedHealth } : {}) };
      }

      phase = "failed";
      return { fail: `unexpected handshake message '${m.h}'` };
    },
  };
}

// ── Primary (server) side ─────────────────────────────────────────────────────────

/** Inputs the primary needs to authenticate an incoming connection. */
export interface PrimaryHandshakeDeps {
  /** This primary's Ed25519 identity (signs the challenge). */
  identity: MeshIdentity;
  /** LIVE enroll admission (H1) — wired to `EnrollmentRegistry.admit(req, primaryIdentity)`. */
  admit: (req: SignedEnrollRequest) => EnrollOutcome;
  /** The pinned proxy pubkey for an ACTIVE enrollment, or `undefined` if not enrolled. */
  pinnedProxyPubKeyFor: (workload: string) => string | undefined;
  /**
   * MANDATORY-ENCRYPTION POLICY (B7 hardening). When `true`, this primary REFUSES a connection
   * whose CHANNEL is not encrypted (`encrypted:false` — a plain-`ws` listener): the driver emits
   * `auth-fail` reason `encryption_required` at the first inbound message, BEFORE any admit/pin.
   * Identity ⟂ encryption (mesh §7 Q2) — this gates the channel, never the Ed25519 identity.
   * Default `false` ⇒ plain ws accepted (back-compat).
   */
  requireEncryption?: boolean;
  /**
   * Whether THIS connection arrived on the encrypted (`wss`) listener. Threaded per-connection
   * by the tunnel (true on the TLS acceptor, false on the plain `ws` one). Only consulted when
   * `requireEncryption` is set. Defaults to `false` (treat as plain) when unspecified.
   */
  encrypted?: boolean;
  /**
   * This primary's health-reporting advertisement (mesh-health-reporting.md §2). Present ⇒ the
   * primary advertises it in `auth-challenge`; health reporting activates iff the proxy also
   * advertised it (the `done` step carries the negotiated result). Absent ⇒ bare-heartbeat fallback.
   */
  healthReporting?: HealthReportingCapability;
}

/**
 * Build the primary-side handshake driver. The primary waits for the proxy to speak,
 * optionally admits an enroll (live), then runs the mutual challenge. It authenticates
 * the socket ONLY after verifying the proxy's response against the LEDGER-pinned key —
 * an unenrolled workload (no pin) is rejected.
 */
export function createPrimaryHandshakeDriver(deps: PrimaryHandshakeDeps): HandshakeDriver {
  let phase: "await" | "challenged" | "done" | "failed" = "await";
  let workload = "";
  let cnonce = "";
  let snonce = "";
  // Negotiated health-reporting result, derived from the proxy's `auth-init` advert + this
  // primary's own, surfaced on the `done` step (mesh-health-reporting.md §2).
  let negotiatedHealth: NegotiatedHealthReporting | undefined;

  return {
    open(): string | undefined {
      return undefined; // the proxy dials + speaks first (NAT-forced).
    },
    next(raw: string): HandshakeStep {
      let m: HandshakeMessage;
      try {
        m = decode(raw);
      } catch {
        phase = "failed";
        return { fail: "malformed handshake message" };
      }

      // MANDATORY-ENCRYPTION POLICY (B7) — refuse a non-encrypted channel BEFORE any admit/pin,
      // at the first inbound message (enroll OR auth-init). Fail-closed with a typed reason so a
      // plain-ws proxy learns WHY (vs a bare socket close) and the one-time join token is NOT
      // consumed (the operator can retry the same token over wss). Identity ⟂ encryption: this
      // is purely a channel check — a valid pinned key over plain ws is still refused.
      if (phase === "await" && deps.requireEncryption && !deps.encrypted) {
        phase = "failed";
        return {
          send: encode({ h: "auth-fail", reason: "encryption_required" }),
          fail: "channel encryption required (plain ws refused — wss only)",
        };
      }

      // ENROLL (H1) — run the LIVE admit. This pins the proxy key + consumes the token
      // but does NOT authenticate the socket; the challenge below still must pass.
      if (phase === "await" && m.h === "enroll") {
        const outcome = deps.admit(m.req);
        return { send: encode({ h: "enroll-result", outcome }) };
      }

      if (phase === "await" && m.h === "auth-init") {
        workload = typeof m.workload === "string" ? m.workload : "";
        cnonce = typeof m.cnonce === "string" ? m.cnonce : "";
        if (workload.length === 0 || cnonce.length === 0) {
          phase = "failed";
          return { fail: "malformed auth-init" };
        }
        // NEGOTIATE health reporting: active iff BOTH advertised (this primary + the proxy's
        // `auth-init`). Additive — a pre-health proxy omits the field ⇒ undefined ⇒ fallback.
        negotiatedHealth = negotiateHealthReporting(deps.healthReporting, m.healthReporting);
        snonce = freshNonce();
        const sig = deps.identity
          .sign(authSignedBytes(AUTH_PRIMARY_DOMAIN, workload, cnonce, snonce))
          .toString("base64");
        phase = "challenged";
        return {
          send: encode({
            h: "auth-challenge",
            snonce,
            sig,
            ...(deps.healthReporting ? { healthReporting: deps.healthReporting } : {}),
          }),
        };
      }

      if (phase === "challenged" && m.h === "auth-response") {
        // THE PIN: verify against the proxy key pinned at enrollment. An unenrolled /
        // withdrawn workload has no pin ⇒ rejected (fail-closed).
        const pinned = deps.pinnedProxyPubKeyFor(workload);
        if (!pinned) {
          phase = "failed";
          return { send: encode({ h: "auth-fail", reason: "not_enrolled" }), fail: "workload not enrolled (no pinned key)" };
        }
        const ok = verify(
          pinned,
          authSignedBytes(AUTH_PROXY_DOMAIN, workload, cnonce, snonce),
          b64ToBuf(m.sig),
        );
        if (!ok) {
          phase = "failed";
          return { send: encode({ h: "auth-fail", reason: "bad_signature" }), fail: "proxy signature failed pinned-key verification" };
        }
        phase = "done";
        return {
          send: encode({ h: "auth-ok" }),
          done: true,
          workload,
          ...(negotiatedHealth ? { healthReporting: negotiatedHealth } : {}),
        };
      }

      phase = "failed";
      return { fail: `unexpected handshake message '${m.h}'` };
    },
  };
}
