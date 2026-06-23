/**
 * Scope coverage check (§4, §5 enforcement).
 *
 * A call is allowed only if some scope in the token covers the entry's `id` with
 * EVERY verb the entry REQUIRES. Per-call, not per-session (§5). Synthesized
 * workflow member scopes participate identically (no special-casing).
 */

import type { CapabilityEntry, TokenScope } from "../protocol/index.ts";

/** True iff the token's scopes cover `entry`'s required verbs for its id. */
export function scopesCover(scopes: TokenScope[], entry: CapabilityEntry): boolean {
  const required = entry.grants;
  // No required verbs ⇒ no grant needed (e.g. a pure skill). Still must be a
  // present entry; that's checked upstream.
  if (required.length === 0) return true;
  const granted = new Set<string>();
  for (const scope of scopes) {
    if (scope.id !== entry.id) continue;
    for (const v of scope.verbs) granted.add(v);
  }
  return required.every((v) => granted.has(v));
}

/** The verbs the entry requires (for audit detail / error messages). */
export function requiredVerbs(entry: CapabilityEntry): string[] {
  return [...entry.grants];
}
