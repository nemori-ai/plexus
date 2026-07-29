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
import { isStandingAndUnexpired } from "./grants.ts";

/**
 * The AUTHORIZED-VIEW predicate for a subset-scoped agent — the single authority
 * every surface answers "can this agent see/request this id?" from: the explicit
 * owner-declared subset, OR a live owner-created standing grant (the inline
 * "grant additional capability" picker / an approved+re-targeted pending — never
 * self-acquired, so this leaks nothing). Callers compose the exposure gate and
 * entry existence on top. Shared by the manifest filter, the grant service, and
 * grant-assist invoke so their views can never drift apart (a drift would be an
 * existence oracle — ADR-023).
 */
export function inAuthorizedView(state: GatewayState, agentId: string, id: string): boolean {
  if (state.agentSubsets.isAuthorized(agentId, id)) return true;
  const g = state.grants?.get(agentId, id);
  return !!g && isStandingAndUnexpired(g, Date.now(), state.connectionKey?.epoch?.());
}

/**
 * Freshness hint stamped on every manifest (`Manifest.ttlMs`) for PULL-ONLY
 * consumers (in-context agents with no events stream): re-fetch after this long.
 * Advisory only — authorization is enforced live, so staleness is safe (Inv V);
 * push consumers keep using `manifest_changed` + `revision`.
 */
export const MANIFEST_TTL_MS = 5 * 60 * 1000;

export function buildManifest(state: GatewayState, session: Session): Manifest {
  // Project entries with trust posture STAMPED (provenance/sensitivity/
  // recommendedTrustWindow) so the manifest carries the same facts as `.well-known`
  // and the Grants view (ADR-018). Falls back to raw `all()` if the registry
  // predates the projection (defensive — keeps any injected fake registry working).
  const projected =
    typeof state.capabilities.projectedEntries === "function"
      ? state.capabilities.projectedEntries()
      : state.capabilities.all();
  // AUTHORIZED-SUBSET filter (`docs/design/agent-authorized-subset.md`): an agent discovers
  // ONLY the capabilities in its authorized subset — never the full catalog. The manifest it
  // receives IS "the capabilities Plexus authorized you to access." EVERY agent-bound session
  // is filtered; an agent with NO subset record is authorized NOTHING (fail closed — there is
  // no legacy un-scoped fallback; the owner re-connects it to authorize). Only a session with
  // no bound agentId at all (the connection-key-gated management/admin session) sees the whole
  // exposed set. Keyed on the session's TRUSTED bound `agentId` (PAT-verified), never the
  // free-form client value.
  const agentId = session.agentId;
  const scoped = !!agentId;
  // A capability is AUTHORIZED for a scoped agent if it is in the explicit subset OR the agent
  // holds a live owner-created STANDING grant for it (the inline "grant additional capability"
  // picker / an approved+re-targeted pending) — so an owner-issued grant is never an invisible,
  // dead grant. A scoped agent can never self-acquire a standing grant (out-of-subset requests
  // are denied before the auto-allow), so this leaks nothing.
  const authorized = (id: string): boolean => inAuthorizedView(state, agentId!, id);
  // A SKILL (kind:"skill") is read-as-context GUIDANCE attached to a capability (referenced
  // by that capability's `skills[]`) — it carries NO authority. So the subset gates it by
  // ATTACHMENT, not by its own membership: a skill rides along iff it is attached to an
  // authorized capability (or was itself explicitly authorized). This keeps the "how to use
  // what you have" docs while never leaking a skill for a capability the agent can't reach.
  const attachedSkillIds = new Set<string>();
  if (scoped) {
    for (const e of projected) {
      if (state.exposure?.isDisabled(e.id)) continue;
      if (!authorized(e.id)) continue;
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
      return attachedSkillIds.has(e.id) || authorized(e.id);
    }
    return authorized(e.id);
  });
  // PER-AGENT STANDING STAMP: an agent-bound manifest tells the agent, per entry, whether
  // it holds a LIVE standing grant (calls short-circuit approval — no pend). Static
  // `describe` prose can only state the default posture; without this flag an agent whose
  // owner opted a side-effecting cap into Standing keeps narrating "each call needs your
  // approval". Copied entries — registry objects are shared and never mutated.
  const now = Date.now();
  const keyEpoch = state.connectionKey?.epoch?.();
  const stamped = !scoped
    ? entries
    : entries.map((e) => {
        if (e.kind === "skill") return e;
        const g = state.grants?.get(agentId!, e.id);
        return g && isStandingAndUnexpired(g, now, keyEpoch) ? { ...e, standing: true } : e;
      });
  // DETERMINISTIC ORDER: entries sort by id, always. The manifest is part of the
  // agent's cognitive context (and the compile input — SKILL.md renders from it),
  // so its serialization must be byte-stable across restarts, rescans, and source
  // start-order — registry insertion order is none of those. Stability also keeps
  // an agent-side prompt cache valid across re-fetches that changed nothing.
  const ordered = [...stamped].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    // Thread the bound port so a `port:0` ephemeral bind advertises the REAL port
    // here too (matching `.well-known`), not the stale `config.port` of 0.
    gateway: gatewayInfo(state.config, state.boundPort),
    entries: ordered,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    revision: state.capabilities.revision(),
    ttlMs: MANIFEST_TTL_MS,
  };
}
