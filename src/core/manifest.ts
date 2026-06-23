/**
 * Manifest builder (§3, §3b). Projects the current capability registry + a session
 * into the full self-describe `Manifest` the agent receives at handshake and via
 * `GET /manifest`. Full entries (every field), the session handle, expiry, and the
 * monotonic `revision`.
 */

import type { Manifest } from "../protocol/index.ts";
import type { GatewayState } from "./state.ts";
import type { Session } from "./sessions.ts";
import { gatewayInfo } from "./well-known.ts";

export function buildManifest(state: GatewayState, session: Session): Manifest {
  return {
    gateway: gatewayInfo(state.config),
    entries: state.capabilities.all(),
    sessionId: session.id,
    expiresAt: session.expiresAt,
    revision: state.capabilities.revision(),
  };
}
