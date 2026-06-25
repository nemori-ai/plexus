/**
 * Scope-constraint enforcer (AUTHZ-UX §3 — N3a, the security-critical spine).
 *
 * A `ScopeConstraint` (protocol §3.1) NARROWS a granted scope: a constrained scope
 * only COVERS a call whose `input` satisfies the constraint. `constraintSatisfied()`
 * is a PURE predicate evaluated at the single invoke chokepoint (`scopesCover` →
 * pipeline). It never grants authority — `scopesCover` still requires id + verbs first;
 * this only ever returns the additional `&&` that can turn an otherwise-covering scope
 * INERT for a given call.
 *
 * SECURITY INVARIANTS (must hold):
 *  - FAIL CLOSED. A missing/malformed input field, a type mismatch, an unsupported op,
 *    or a path that escapes its prefix ⇒ FALSE (denied). The DEFAULT is deny OUTSIDE the
 *    constraint.
 *  - It can ONLY narrow. There is no branch here that returns TRUE for a call the bare
 *    (id + verbs) scope did not already cover — coverage is decided by `scopesCover`;
 *    this function only ever subtracts.
 *  - Path checks REUSE the shipped lexical traversal-rejecting confinement
 *    (`lexicalConfine` from the obsidian vault reader), NOT a naive `startsWith`, so
 *    `Inbox/` cannot be defeated by `Inbox/../secrets`.
 *  - `op:"regex"` is NOT enforced in this phase (ReDoS / mis-anchor footgun, AUTHZ-UX D2)
 *    — it FAILS CLOSED (returns FALSE), so a constraint that relies on it denies.
 *
 * v1 enforces: `pathPrefix`, `allow` (resource-id allowlist), and `match` (eq/prefix/in).
 */

import type { ScopeConstraint, ScopeMatch } from "@plexus/protocol";
import { lexicalConfine } from "../sources/obsidian/vault-reader.ts";

/** Read a dotted path (e.g. "params.folder") out of a call input. Missing ⇒ undefined. */
function readField(input: Record<string, unknown>, field: string): unknown {
  if (!field) return undefined;
  const parts = field.split(".");
  let cur: unknown = input;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Normalize a constraint prefix to the SAME lexical form `lexicalConfine` produces for
 * an input path: POSIX, no leading "./", trailing slash stripped for comparison. A
 * prefix that itself escapes (absolute / `..`) is treated as un-confinable ⇒ no match.
 */
function normalizePrefix(prefix: string): string | undefined {
  const trimmed = (prefix ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return ""; // root prefix — matches everything in-root
  return lexicalConfine(trimmed);
}

/** Does the normalized path sit AT or UNDER the normalized prefix (segment-aware)? */
function pathUnderPrefix(normPath: string, normPrefix: string): boolean {
  if (normPrefix === "") return true; // root prefix
  if (normPath === normPrefix) return true; // exact directory/file match
  return normPath.startsWith(normPrefix + "/"); // strict descendant (segment boundary)
}

/** Evaluate a single `match` predicate. FAIL CLOSED on missing field / bad op / type. */
function matchSatisfied(m: ScopeMatch, input: Record<string, unknown>): boolean {
  const v = readField(input, m.field);
  if (v === undefined) return false; // missing field ⇒ deny
  switch (m.op) {
    case "eq":
      return m.value !== undefined && v === m.value;
    case "prefix":
      return (
        typeof v === "string" &&
        typeof m.value === "string" &&
        v.startsWith(m.value)
      );
    case "in":
      return Array.isArray(m.values) && m.values.some((x) => x === v);
    case "regex":
      // RESERVED — not enforced in this phase (AUTHZ-UX D2). Fail closed.
      return false;
    default:
      // Unknown op ⇒ deny.
      return false;
  }
}

/**
 * TRUE iff `input` satisfies EVERY present predicate of `constraint` (AND). An empty /
 * absent constraint is unconstrained ⇒ TRUE (caller treats it as a whole-capability
 * scope). Any present predicate that fails ⇒ FALSE (the scope is INERT for this call).
 */
export function constraintSatisfied(
  constraint: ScopeConstraint | undefined,
  input: Record<string, unknown>,
): boolean {
  if (!constraint) return true;
  const safeInput = input ?? {};

  // pathPrefix: the field, treated as a relative path, must resolve under one prefix.
  if (constraint.pathPrefix) {
    const { field, allow } = constraint.pathPrefix;
    const raw = readField(safeInput, field);
    if (typeof raw !== "string") return false; // missing / non-string ⇒ deny
    const normPath = lexicalConfine(raw);
    if (normPath === undefined) return false; // traversal / absolute ⇒ deny
    if (!Array.isArray(allow) || allow.length === 0) return false; // no prefixes ⇒ deny
    const ok = allow.some((p) => {
      const np = normalizePrefix(p);
      return np !== undefined && pathUnderPrefix(normPath, np);
    });
    if (!ok) return false;
  }

  // allow: exact-equal resource-id allowlist.
  if (constraint.allow) {
    const { field, values } = constraint.allow;
    const v = readField(safeInput, field);
    if (v === undefined) return false; // missing ⇒ deny
    if (!Array.isArray(values) || !values.some((x) => x === v)) return false;
  }

  // match: generic value predicates (eq / prefix / in; regex fails closed).
  if (constraint.match) {
    for (const m of constraint.match) {
      if (!matchSatisfied(m, safeInput)) return false;
    }
  }

  return true;
}
