/**
 * Builder for the `GET /.well-known/plexus` `WellKnownDocument` (§2, ADR-008).
 *
 * The pre-session, unauthenticated advertisement MCP lacks. SUMMARY tier only:
 * gateway identity + capability summaries + the auth advertisement (endpoint URLs
 * read by the agent, never hard-coded — ADR-016). This is REAL (not a stub): with
 * an empty capability registry it returns a structurally-valid document with an
 * empty `capabilities` array, which is what the bootable M0 server serves.
 */

import type {
  WellKnownDocument,
  GatewayInfo,
  AuthAdvertisement,
  CapabilitySummary,
} from "@plexus/protocol";
import { type GatewayConfig, baseUrl, PLEXUS_VERSION, PLEXUS_PROTOCOL } from "../config.ts";
import { TOKEN_SCHEME } from "../auth/index.ts";

/**
 * The effective advertised base URL.
 *
 * A configured PUBLIC hostname (FEAT public-hostname) wins: the FIRST entry is
 * the gateway's ONE canonical public address (`https://<hostname>` — TLS lives at
 * the fronting edge), so `.well-known`, the auth advertisement, and the
 * integration install command all hand a REMOTE agent endpoint URLs it can
 * actually reach. Loopback callers still work — the URLs round-trip through the
 * edge — and a no-public-hostname config is byte-for-byte unchanged.
 *
 * Otherwise: the loopback base, using the ACTUAL bound port when known
 * (REDESIGN-ARCHITECTURE §3.4 / the P0 ephemeral-port gotcha). For a `port:0`
 * ephemeral bind, `config.port` is `0` (wrong); the supervised entrypoint threads
 * the real bound port here so `.well-known`/`/v1/status` advertise the REAL port.
 */
function effectiveBaseUrl(config: GatewayConfig, boundPort?: number): string {
  const publicHost = config.publicHostnames?.[0];
  if (publicHost) return `https://${publicHost}`;
  if (typeof boundPort === "number" && boundPort > 0 && boundPort !== config.port) {
    return `http://${config.host}:${boundPort}`;
  }
  return baseUrl(config);
}

/** Gateway identity block. `boundPort` (when known) reconciles the advertised port. */
export function gatewayInfo(config: GatewayConfig, boundPort?: number): GatewayInfo {
  return {
    name: "plexus",
    version: PLEXUS_VERSION,
    protocol: PLEXUS_PROTOCOL,
    baseUrl: effectiveBaseUrl(config, boundPort),
    ...(config.instance ? { instance: config.instance } : {}),
  };
}

/**
 * The auth advertisement — WHERE every session-scoped endpoint lives (flat
 * top-level namespace per ADR-016). The agent reads these URLs rather than
 * hard-coding paths.
 */
export function authAdvertisement(config: GatewayConfig, boundPort?: number): AuthAdvertisement {
  const base = effectiveBaseUrl(config, boundPort);
  return {
    handshakeUrl: `${base}/link/handshake`,
    grantsUrl: `${base}/grants`,
    // The sanctioned grant-request affordance, named explicitly so a cold agent never has to
    // guess the verb (integration-legibility fix #1). Same endpoint as `grantsUrl`.
    grantRequestUrl: `${base}/grants`,
    grantRequestMethod: "PUT",
    sessionHeader: "X-Plexus-Session",
    consoleUrl: `${base}/admin`,
    refreshUrl: `${base}/grants/refresh`,
    revokeUrl: `${base}/grants/revoke`,
    grantStatusUrl: `${base}/grants/status`,
    invokeUrl: `${base}/invoke`,
    manifestUrl: `${base}/manifest`,
    eventsUrl: `${base}/events`,
    grantsListUrl: `${base}/grants`,
    // ADMIN/owner path only — how the OWNER receives the connection-key out of band. NOT an agent
    // affordance: an agent authenticates with its own PAT (see `enrollment` / `requestShapes.handshake`).
    connectionKeyDelivery: "user-paste",
    tokenScheme: TOKEN_SCHEME,
    // Machine-readable request-shape hints so a cold agent sends correct requests with zero
    // guessing (integration-legibility P6-SCHEMA). Body field names AND the handshake Bearer header
    // are load-bearing.
    requestShapes: {
      handshake: {
        // The AGENT path (ADR-4/ADR-5): enroll first (see `enrollment`), then present your durable
        // per-agent PAT as a Bearer header — NO body. The connectionKey-in-body shape is the
        // ADMIN/owner path only, and a skill-less cold agent must never take it (Inv II/III).
        url: `${base}/link/handshake`,
        method: "POST",
        auth: "bearer(pat)",
        headers: { Authorization: "Bearer <your PAT from enrollment (plx_agent_…)>" },
        body: {},
      },
      grantRequest: {
        // Session is accepted EITHER as the `X-Plexus-Session` header OR as `sessionId`
        // in the body (handlers.ts: `header ?? body.sessionId`). A cold HTTP agent that
        // holds the session from handshake can just put it in the body.
        url: `${base}/grants`,
        method: "PUT",
        auth: "session: X-Plexus-Session header — or sessionId in the body",
        body: { sessionId: "<your session from handshake>", grants: { "<capabilityId>": "allow" } },
      },
      invoke: {
        // The standard path: present the scoped-jwt minted by grantRequest as a Bearer
        // token — that alone authorizes the call. (An in-band low-sensitivity path also
        // exists via X-Plexus-Session, but the Bearer scoped-token is the canonical one.)
        url: `${base}/invoke`,
        method: "POST",
        auth: "bearer(scoped-jwt) — the token minted by grantRequest",
        body: { id: "<capabilityId>", input: {} },
      },
    },
    // The enrollment bootstrap, self-described so a skill-LESS cold agent reading ONLY this document
    // can turn its out-of-band one-time code into its own durable PAT and then authenticate (ADR-9,
    // Inv II). `enrollmentUrl` is the address; `enrollment` carries the full request/success/error
    // shape + what to do with the minted PAT. The BODY field name `code` is load-bearing.
    enrollmentUrl: `${base}/agents/enroll`,
    enrollment: {
      url: `${base}/agents/enroll`,
      method: "POST",
      auth: "body.code",
      body: { code: "<one-time enrollment code (plx_enroll_…, delivered out of band)>" },
      success: { pat: "<durable bearer PAT (plx_agent_…) — store it yourself>", agentId: "<your agentId>" },
      errorCodes: ["malformed", "unknown_code", "code_expired", "code_consumed", "persist_failed"],
      patStorage:
        "Store the returned PAT yourself, in your own paradigm (e.g. an .env file) — it is returned only ONCE — then present the PAT as your agent credential at handshake (see handshakeUrl / requestShapes.handshake). Enrollment happens once; the stored PAT authenticates every subsequent session.",
    },
  };
}

/**
 * Assemble a `.well-known`-shaped document that CARRIES the capability catalog. This is
 * NOT the public discovery doc anymore (see `buildPublicWellKnown`) — it is the internal
 * "Floor" the integration/plugin compiler builds server-side (management-gated) from the
 * agent's exposed cap summaries, which it needs to compile an install. `boundPort` (when
 * known post-listen) reconciles the advertised baseUrl + auth endpoint URLs to the ACTUAL
 * bound port (REDESIGN-ARCHITECTURE §3.4).
 */
export function buildWellKnown(
  config: GatewayConfig,
  capabilities: CapabilitySummary[],
  boundPort?: number,
): WellKnownDocument {
  return {
    gateway: gatewayInfo(config, boundPort),
    capabilities,
    auth: authAdvertisement(config, boundPort),
  };
}

/**
 * The one-line pointer the public discovery doc carries in place of a catalog — states
 * what IS: enroll + handshake and you receive your authorized list (positive framing;
 * never "we don't advertise X"). Authorized-subset model, `docs/design/…` §3.3/§5.
 */
export const CAPABILITIES_VIA =
  "Enroll and handshake to receive the list of capabilities Plexus has authorized you to access.";

/**
 * Assemble the PUBLIC `GET /.well-known/plexus` document (authorized-subset model §3.3).
 * It advertises the gateway identity + the lifecycle/auth endpoints ONLY — NO capability
 * catalog. A cold caller enrolls + handshakes to receive the capabilities Plexus
 * authorized IT to access (the manifest), which closes pre-identity enumeration and means
 * an agent never learns Plexus has more than its authorized subset.
 */
export function buildPublicWellKnown(
  config: GatewayConfig,
  boundPort?: number,
): WellKnownDocument {
  return {
    gateway: gatewayInfo(config, boundPort),
    capabilitiesVia: CAPABILITIES_VIA,
    auth: authAdvertisement(config, boundPort),
  };
}
