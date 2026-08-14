/**
 * The ORIGIN GATE — which sites a browser-control call may touch.
 *
 * WHY THIS EXISTS. Chrome's own consent for a remote-debugging session is all-or-nothing: the
 * dialog authorizes *the browser*, not a set of sites, and Chrome exposes no per-tab or
 * per-origin scoping. So the boundary the owner actually wants — "this agent may drive GitHub
 * tabs and nothing else" — has to be enforced here.
 *
 * THREE PROPERTIES CARRY THE SECURITY OF THIS MODULE:
 *
 *   1. FAIL CLOSED, INCLUDING WHEN UNSET. An empty allowlist denies everything. "Unset" is not
 *      "unrestricted" — an unconfigured browser-control source is inert, not open. This is the
 *      one default that must never be convenient.
 *   2. ORIGIN COMPARISON, NOT STRING PREFIX. `https://github.com.evil.com` and
 *      `https://github.com@evil.com` both *look* like the allowed host to a `startsWith` check.
 *      The URL is parsed and its origin compared exactly, so neither is ever allowed.
 *   3. IT JUDGES THE REAL TARGET. Callers must pass the URL that will actually be acted on —
 *      parsed from the live tab or the navigation argument — never a separate origin field the
 *      agent supplies alongside it, which the agent could simply lie about.
 *
 * Pure and dependency-free so the decision is unit-testable in isolation; the bridge owns the
 * plumbing, this owns the answer.
 */

/** Why a URL was refused — surfaced to the owner's audit, and (sanitized) to the agent. */
export type OriginVerdict =
  | { allowed: true; origin: string }
  | { allowed: false; reason: "no-allowlist" | "unparseable" | "scheme" | "not-allowed"; origin?: string };

/**
 * Schemes a browser-control call may target. `http`/`https` only — deliberately excluding
 * `file:` (the local disk is other sources' business, under their own confinement),
 * `chrome:`/`devtools:` (browser-internal surfaces, including the very settings page that
 * governs remote debugging), and `javascript:` (arbitrary evaluation through the back door).
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Normalize an owner-configured allowlist entry to a comparable ORIGIN.
 *
 * Accepts what an owner would naturally type — `github.com`, `https://github.com`,
 * `https://github.com/` — and resolves each to a canonical origin. A bare host is treated as
 * `https`, because defaulting to plaintext for a convenience input is the wrong default.
 * Anything that will not parse is dropped rather than guessed at: a malformed entry must not
 * silently widen or narrow the gate in some unintended direction.
 */
export function normalizeAllowEntry(entry: string): string | undefined {
  const raw = (entry ?? "").trim();
  if (!raw) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (!ALLOWED_SCHEMES.has(u.protocol)) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** Normalize a whole allowlist, dropping entries that do not resolve to an origin. */
export function normalizeAllowlist(entries: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const e of entries ?? []) {
    const origin = normalizeAllowEntry(e);
    if (origin) out.add(origin);
  }
  return [...out];
}

/**
 * May a call act on `url`?
 *
 * `allowlist` is the OWNER's configured set (already normalized, or raw — normalized here
 * either way so a caller cannot bypass normalization by passing raw strings).
 */
export function judgeUrl(url: string | undefined, allowlist: readonly string[] | undefined): OriginVerdict {
  const allowed = normalizeAllowlist(allowlist);
  // Property 1: unset means inert, not open. Checked FIRST so an unconfigured source cannot
  // be probed for what parses — with no allowlist the answer is "no" regardless of the input.
  if (allowed.length === 0) return { allowed: false, reason: "no-allowlist" };

  const raw = (url ?? "").trim();
  if (!raw) return { allowed: false, reason: "unparseable" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, reason: "unparseable" };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { allowed: false, reason: "scheme", origin: parsed.protocol };
  }
  // Property 2: exact ORIGIN equality. `new URL` has already resolved userinfo, ports, case
  // and punycode, so `https://github.com@evil.com` has origin `https://evil.com` and
  // `https://github.com.evil.com` has its own — neither can impersonate an allowed entry.
  if (!allowed.includes(parsed.origin)) {
    return { allowed: false, reason: "not-allowed", origin: parsed.origin };
  }
  return { allowed: true, origin: parsed.origin };
}

/**
 * The agent-facing refusal message. Names the origin it asked for and what the owner would do
 * about it — never the allowlist itself, which would turn a denial into a way to enumerate the
 * owner's other authorized sites.
 */
export function refusalMessage(v: Extract<OriginVerdict, { allowed: false }>): string {
  switch (v.reason) {
    case "no-allowlist":
      return (
        "browser control has no authorized sites yet, so every target is refused. The owner " +
        "sets the allowed origins in Plexus → What I expose → Browser control."
      );
    case "unparseable":
      return "that is not a valid absolute http(s) URL.";
    case "scheme":
      return "only http and https targets can be driven; browser-internal and file URLs are refused.";
    case "not-allowed":
      return (
        `${v.origin ?? "that origin"} is not among the sites the owner authorized for browser ` +
        `control. Ask the owner to add it if you need it.`
      );
  }
}
