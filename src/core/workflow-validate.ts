/**
 * Workflow registration-time validation (m4sec-reg, security review must-fix #4).
 *
 * Three teeth, all DEFAULT-DENY / REJECT-don't-skip:
 *
 *  1. GLOBAL TRANSITIVE ANTI-CYCLE. A `kind:"workflow"` entry fans out to its
 *     `members[]` by re-entering the invoke pipeline (the workflow transport). If
 *     the member graph contains a cycle (A→B→A, or self-reference A→A) that fan-out
 *     recurses unbounded → stack overflow at INVOKE time. The cycle can be closed
 *     incrementally: workflow A registers referencing B before B exists, then B
 *     registers referencing A — the cycle only becomes real on the SECOND register.
 *     So the anti-cycle walk is GLOBAL (across every workflow entry currently in the
 *     registry) and re-run on EVERY registry mutation (each `registerExtension`).
 *
 *  2. UNRESOLVED MEMBERS. A member id that does not resolve to a present registry
 *     entry has no transitive-grant target and no dispatch target — REJECT the
 *     workflow (the old behavior silently skipped it, which let a workflow advertise
 *     authority it could never honestly account for).
 *
 *  3. CROSS-SOURCE MEMBERS = authority laundering. A workflow whose member belongs
 *     to a DIFFERENT source than the workflow itself lets source A's workflow
 *     borrow source B's capability under A's grant surface. DEFAULT: DISALLOW unless
 *     the member is explicitly opted-in (see `CROSS_SOURCE_MEMBER_FLAG`). Provenance
 *     (which foreign sources a workflow reaches into) is surfaced for the m4sec-auth
 *     confirm step via `describeWorkflowProvenance`.
 *
 * VALIDATE-vs-COMMIT SEAM (for m4sec-auth): `validateWorkflowGraph` is a PURE
 * predicate over a candidate entry set — it never mutates the registry. The registry
 * calls it BEFORE committing a new extension's entries; m4sec-auth can call the same
 * function to compute reasons to show the user, then only commit post-confirm.
 */

import type { CapabilityEntry, CapabilityId, SourceId } from "../protocol/index.ts";

/**
 * Opt-in flag a workflow member declaration may carry to permit a cross-source
 * member. Lives on the wire member object's open bag (members are
 * `WorkflowMember` — frozen — so we read an extra key off it defensively; the
 * gateway core never reads this, only this validator does). When absent/false a
 * cross-source member is REJECTED at register.
 *
 * NOTE: `WorkflowMember` is a frozen type ({id, verbs}); the cross-source opt-in is
 * carried as an extra property the validator reads structurally, so no frozen-type
 * edit is forced. m4sec-auth gates this behind user-confirm.
 */
export const CROSS_SOURCE_MEMBER_FLAG = "allowCrossSource" as const;

export interface WorkflowValidationResult {
  ok: boolean;
  /** Machine + human reasons, one per violation (empty when ok). */
  reasons: string[];
  /**
   * Per-workflow foreign-source provenance: workflow id → the set of DIFFERENT
   * source ids its members reach into. Surfaced to the m4sec-auth confirm step so a
   * cross-source workflow grant is visibly distinguishable.
   */
  crossSourceProvenance: Record<CapabilityId, SourceId[]>;
}

/** Derive the source of an entry (explicit `source`, else recovered from the id). */
function entrySource(entry: CapabilityEntry): SourceId {
  if (entry.source) return entry.source;
  // ID-DERIVATION RULE fallback: `<sourceSlug>.<noun>.<verb>` — the slug is the
  // part before the first dot pair; we only need a stable string for comparison.
  const slug = entry.id.split(".")[0] ?? entry.id;
  return slug;
}

/** Whether a member object opted into being a cross-source member. */
function memberAllowsCrossSource(member: { [k: string]: unknown }): boolean {
  return member[CROSS_SOURCE_MEMBER_FLAG] === true;
}

/**
 * Validate the WHOLE candidate entry set (existing registry entries PLUS the
 * incoming extension's entries). Pure: no mutation, no throw. Returns ok=false with
 * accumulated reasons on any cyclic / unresolved / un-opted cross-source member.
 *
 * This is the validate side of the validate-vs-commit seam: the registry runs it
 * before committing; m4sec-auth may run it to build the confirm prompt.
 */
export function validateWorkflowGraph(
  candidate: CapabilityEntry[],
): WorkflowValidationResult {
  const byId = new Map<CapabilityId, CapabilityEntry>();
  for (const e of candidate) byId.set(e.id, e);

  const reasons: string[] = [];
  const crossSourceProvenance: Record<CapabilityId, SourceId[]> = {};

  // ── (2) unresolved members + (3) cross-source policy ───────────────────────
  for (const entry of candidate) {
    if (entry.kind !== "workflow") continue;
    const wfSource = entrySource(entry);
    const foreign = new Set<SourceId>();
    for (const member of entry.members ?? []) {
      const target = byId.get(member.id);
      if (!target) {
        reasons.push(
          `workflow ${entry.id} references member ${member.id} which is not a present registry entry (dangling member rejected, not skipped)`,
        );
        continue;
      }
      const memberSource = entrySource(target);
      if (memberSource !== wfSource) {
        foreign.add(memberSource);
        if (!memberAllowsCrossSource(member as unknown as Record<string, unknown>)) {
          reasons.push(
            `workflow ${entry.id} member ${member.id} belongs to a DIFFERENT source (${memberSource}); cross-source members are disallowed by default (authority laundering) — opt in with ${CROSS_SOURCE_MEMBER_FLAG}:true and user-confirm`,
          );
        }
      }
    }
    if (foreign.size > 0) crossSourceProvenance[entry.id] = [...foreign];
  }

  // ── (1) global transitive anti-cycle (DFS w/ visited + on-stack set) ───────
  // Edges: workflow entry → each member id (only edges into present entries; a
  // dangling member is already rejected above and cannot form a real cycle).
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<CapabilityId, number>();

  const adj = (id: CapabilityId): CapabilityId[] => {
    const e = byId.get(id);
    if (!e || e.kind !== "workflow") return [];
    return (e.members ?? []).map((m) => m.id).filter((mid) => byId.has(mid));
  };

  const cycleReasons: string[] = [];
  const dfs = (id: CapabilityId, path: CapabilityId[]): void => {
    color.set(id, GREY);
    for (const next of adj(id)) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        // Back-edge → cycle. Render the cycle path for the reason.
        const idx = path.indexOf(next);
        const loop = (idx >= 0 ? path.slice(idx) : path).concat(next);
        cycleReasons.push(`workflow cycle detected: ${loop.join(" → ")}`);
      } else if (c === WHITE) {
        dfs(next, [...path, next]);
      }
    }
    color.set(id, BLACK);
  };

  for (const e of candidate) {
    if (e.kind !== "workflow") continue;
    if ((color.get(e.id) ?? WHITE) === WHITE) dfs(e.id, [e.id]);
  }
  // De-dup cycle reasons (the same loop may be discovered from multiple roots).
  for (const r of [...new Set(cycleReasons)]) reasons.push(r);

  return { ok: reasons.length === 0, reasons, crossSourceProvenance };
}

/**
 * Provenance summary for the m4sec-auth confirm step: for each workflow in the
 * candidate set, which foreign source ids its members reach into. Empty object when
 * no workflow reaches outside its own source.
 */
export function describeWorkflowProvenance(
  candidate: CapabilityEntry[],
): Record<CapabilityId, SourceId[]> {
  return validateWorkflowGraph(candidate).crossSourceProvenance;
}
