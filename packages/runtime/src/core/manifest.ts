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
  // AUTHORIZED-SUBSET filter (`docs/design/agent-authorized-subset.md`): a SCOPED agent
  // (one the owner connected under the subset model) discovers ONLY the capabilities in its
  // authorized subset — never the full catalog. The manifest it receives IS "the capabilities
  // Plexus authorized you to access." An UN-SCOPED session (no subset record — a legacy agent,
  // or the management/admin session) is unaffected: it still sees the whole exposed set. Keyed
  // on the session's TRUSTED bound `agentId` (PAT-verified), never the free-form client value.
  const agentId = session.agentId;
  const scoped = !!agentId && state.agentSubsets?.isScoped(agentId) === true;
  // A SKILL (kind:"skill") is read-as-context GUIDANCE attached to a capability (referenced
  // by that capability's `skills[]`) — it carries NO authority. So the subset gates it by
  // ATTACHMENT, not by its own membership: a skill rides along iff it is attached to an
  // authorized capability (or was itself explicitly selected). This keeps the "how to use
  // what you have" docs while never leaking a skill for a capability the agent can't reach.
  const attachedSkillIds = new Set<string>();
  if (scoped) {
    for (const e of projected) {
      if (state.exposure?.isDisabled(e.id)) continue;
      if (!state.agentSubsets.isAuthorized(agentId, e.id)) continue;
      for (const s of e.skills ?? []) attachedSkillIds.add(s.id);
    }
  }
  // EXPOSURE filter (the outermost gate): a top-level-disabled capability is EXCLUDED
  // from the manifest entry set too — an agent never sees it at handshake / GET /manifest
  // (matching `.well-known`). The `revision` bumps on toggle so agents re-fetch.
  const entries = projected.filter((e) => {
    if (state.exposure?.isDisabled(e.id)) return false;
    if (!scoped) return true;
    if (e.kind === "skill") {
      return attachedSkillIds.has(e.id) || state.agentSubsets.isAuthorized(agentId, e.id);
    }
    return state.agentSubsets.isAuthorized(agentId, e.id);
  });
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
