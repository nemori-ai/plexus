/**
 * Who is still ON THE ROSTER — the one definition of "this agent still exists", shared by
 * every surface that offers an agent chooser.
 *
 * WHY THIS EXISTS. The audit is append-only and keeps a deleted agent's history forever
 * (that is the point of an audit, and "Revoke & delete" says so explicitly: the roster row
 * goes, the trail stays). But a chooser built by folding over the audit therefore keeps
 * offering agents that no longer exist — the filter accumulates ghosts that can never
 * produce another event.
 *
 * The fix is a chooser change, NOT a data change: nothing is deleted, and every historical
 * event still renders in the Activity ledger. Only the pick-lists narrow to agents that are
 * still real.
 *
 * ON THE ROSTER = holds a standing grant, or an active token, or an enrollment row. Revoke
 * WITHOUT delete keeps the enrollment row (a tombstone), so a merely-revoked agent is still
 * on the roster and still choosable — which is right: the owner can re-issue it. Only
 * "Revoke & delete", which removes the row outright, takes an agent off the list.
 */

/** The minimum each source contributes: an agent id. */
interface HasAgentId {
  agentId?: string;
}

/**
 * The set of agent ids still on the roster. Sources are the SAME three the Agents tab
 * composes its rows from, so the chooser and the roster can never disagree.
 */
export function liveAgentIds(
  grants: readonly { agentId: string }[] | undefined,
  tokens: readonly HasAgentId[] | undefined,
  enrollments: readonly HasAgentId[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const g of grants ?? []) if (g.agentId) ids.add(g.agentId);
  for (const t of tokens ?? []) if (t.agentId) ids.add(t.agentId);
  for (const e of enrollments ?? []) if (e.agentId) ids.add(e.agentId);
  return ids;
}

/**
 * Narrow a chooser's options to agents still on the roster.
 *
 * TWO DELIBERATE ESCAPE HATCHES, both about not lying to the operator:
 *  - Until the roster has loaded (`live` is `undefined`), NOTHING is hidden. A chooser that
 *    silently empties itself mid-fetch would read as "there are no agents".
 *  - A `keep` id is always retained even when off-roster, so a filter already pointing at a
 *    deleted agent (a deep link, or a selection made before the delete) keeps working and
 *    keeps showing its own value instead of snapping to a different agent's rows.
 */
export function rosterOnly(
  candidates: readonly string[],
  live: Set<string> | undefined,
  keep?: string,
): string[] {
  if (!live) return [...candidates];
  return candidates.filter((id) => live.has(id) || (keep !== undefined && id === keep));
}
