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
 * The effective loopback base URL — uses the ACTUAL bound port when known
 * (REDESIGN-ARCHITECTURE §3.4 / the P0 ephemeral-port gotcha). For a `port:0`
 * ephemeral bind, `config.port` is `0` (wrong); the supervised entrypoint threads
 * the real bound port here so `.well-known`/`/v1/status` advertise the REAL port.
 */
function effectiveBaseUrl(config: GatewayConfig, boundPort?: number): string {
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
    refreshUrl: `${base}/grants/refresh`,
    revokeUrl: `${base}/grants/revoke`,
    grantStatusUrl: `${base}/grants/status`,
    invokeUrl: `${base}/invoke`,
    manifestUrl: `${base}/manifest`,
    eventsUrl: `${base}/events`,
    grantsListUrl: `${base}/grants`,
    connectionKeyDelivery: "user-paste",
    tokenScheme: TOKEN_SCHEME,
  };
}

/**
 * Assemble the full `.well-known` document from the current capability summaries.
 * `boundPort` (when known post-listen) reconciles the advertised baseUrl + the auth
 * endpoint URLs to the ACTUAL bound port (REDESIGN-ARCHITECTURE §3.4).
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
