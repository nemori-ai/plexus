/**
 * Manifest builder (§3, §3b). Projects the current capability registry + a session
 * into the full self-describe `Manifest` the agent receives at handshake and via
 * `GET /manifest`. Full entries (every field), the session handle, expiry, and the
 * monotonic `revision`.
 */

import type { Manifest } from "@plexus/protocol";
import type { GatewayState } from "./state.ts";
import type { Session } from "./sessions.ts";
import { gatewayInfo } from "./well-known.ts";

export function buildManifest(state: GatewayState, session: Session): Manifest {
  // Project entries with trust posture STAMPED (provenance/sensitivity/
  // recommendedTrustWindow) so the manifest carries the same facts as `.well-known`
  // and the Grants view (ADR-018). Falls back to raw `all()` if the registry
  // predates the projection (defensive — keeps any injected fake registry working).
  const projected =
    typeof state.capabilities.projectedEntries === "function"
      ? state.capabilities.projectedEntries()
      : state.capabilities.all();
  // EXPOSURE filter (the outermost gate): a top-level-disabled capability is EXCLUDED
  // from the manifest entry set too — an agent never sees it at handshake / GET /manifest
  // (matching `.well-known`). The `revision` bumps on toggle so agents re-fetch.
  const entries = projected.filter((e) => !state.exposure?.isDisabled(e.id));
  return {
    // Thread the bound port so a `port:0` ephemeral bind advertises the REAL port
    // here too (matching `.well-known`), not the stale `config.port` of 0.
    gateway: gatewayInfo(state.config, state.boundPort),
    entries,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    revision: state.capabilities.revision(),
  };
}
