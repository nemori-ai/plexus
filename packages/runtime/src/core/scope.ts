/**
 * Scope coverage check (§4, §5 enforcement).
 *
 * A call is allowed only if some scope in the token covers the entry's `id` with
 * EVERY verb the entry REQUIRES. Per-call, not per-session (§5). Synthesized
 * workflow member scopes participate identically (no special-casing).
 *
 * SCOPE CONSTRAINTS (AUTHZ-UX §3.2, additive): a scope MAY carry a `constraint`. A
 * constrained scope is INERT (contributes no verbs) for a call whose `input` fails the
 * constraint, so coverage then fails → the existing `grant_required` denial (default-deny
 * OUTSIDE the constraint; NO new ErrorCode). A constraint can ONLY narrow — coverage still
 * requires id + verbs first, so adding a constraint never grants authority the bare scope
 * did not. An UNCONSTRAINED scope is unchanged. `input` is optional: callers that pass none
 * are treated as `{}` (a constrained scope then evaluates its predicates against an empty
 * input and, fail-closed, will typically be inert — which is correct, since a constrained
 * grant should not cover an input-less call it was scoped to confine).
 */

import type { CapabilityEntry, TokenScope } from "@plexus/protocol";
import { constraintSatisfied } from "./constraint.ts";

/** True iff the token's scopes cover `entry`'s required verbs for its id. */
export function scopesCover(
  scopes: TokenScope[],
  entry: CapabilityEntry,
  input?: Record<string, unknown>,
): boolean {
  const required = entry.grants;
  // No required verbs ⇒ no grant needed (e.g. a pure skill). Still must be a
  // present entry; that's checked upstream.
  if (required.length === 0) return true;
  const granted = new Set<string>();
  for (const scope of scopes) {
    if (scope.id !== entry.id) continue;
    // A constrained scope is INERT for a call whose input fails the constraint
    // (default-deny outside the constraint). Unconstrained scopes are unchanged.
    if (scope.constraint && !constraintSatisfied(scope.constraint, input ?? {})) continue;
    for (const v of scope.verbs) granted.add(v);
  }
  return required.every((v) => granted.has(v));
}

/** The verbs the entry requires (for audit detail / error messages). */
export function requiredVerbs(entry: CapabilityEntry): string[] {
  return [...entry.grants];
}
