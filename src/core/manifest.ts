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
    // Project entries with trust posture STAMPED (provenance/sensitivity/
    // recommendedTrustWindow) so the manifest carries the same facts as `.well-known`
    // and the Grants view (ADR-018). Falls back to raw `all()` if the registry
    // predates the projection (defensive — keeps any injected fake registry working).
    entries:
      typeof state.capabilities.projectedEntries === "function"
        ? state.capabilities.projectedEntries()
        : state.capabilities.all(),
    sessionId: session.id,
    expiresAt: session.expiresAt,
    revision: state.capabilities.revision(),
  };
}
