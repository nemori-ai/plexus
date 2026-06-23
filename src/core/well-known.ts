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
} from "../protocol/index.ts";
import { type GatewayConfig, baseUrl, PLEXUS_VERSION, PLEXUS_PROTOCOL } from "../config.ts";
import { TOKEN_SCHEME } from "../auth/index.ts";

/** Gateway identity block. */
export function gatewayInfo(config: GatewayConfig): GatewayInfo {
  return {
    name: "plexus",
    version: PLEXUS_VERSION,
    protocol: PLEXUS_PROTOCOL,
    baseUrl: baseUrl(config),
    ...(config.instance ? { instance: config.instance } : {}),
  };
}

/**
 * The auth advertisement — WHERE every session-scoped endpoint lives (flat
 * top-level namespace per ADR-016). The agent reads these URLs rather than
 * hard-coding paths.
 */
export function authAdvertisement(config: GatewayConfig): AuthAdvertisement {
  const base = baseUrl(config);
  return {
    handshakeUrl: `${base}/link/handshake`,
    grantsUrl: `${base}/grants`,
    refreshUrl: `${base}/grants/refresh`,
    revokeUrl: `${base}/grants/revoke`,
    grantStatusUrl: `${base}/grants/status`,
    invokeUrl: `${base}/invoke`,
    manifestUrl: `${base}/manifest`,
    eventsUrl: `${base}/events`,
    connectionKeyDelivery: "user-paste",
    tokenScheme: TOKEN_SCHEME,
  };
}

/** Assemble the full `.well-known` document from the current capability summaries. */
export function buildWellKnown(
  config: GatewayConfig,
  capabilities: CapabilitySummary[],
): WellKnownDocument {
  return {
    gateway: gatewayInfo(config),
    capabilities,
    auth: authAdvertisement(config),
  };
}
