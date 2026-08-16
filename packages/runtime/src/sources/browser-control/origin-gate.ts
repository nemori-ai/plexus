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
 *   1. FAIL CLOSED WHERE THERE IS SOMETHING TO PROTECT. Against the owner's OWN browser
 *      (`attach`) an empty allowlist denies everything: unset is inert, not open. Against a
 *      browser Plexus launched on an empty profile there is no authenticated anything to wall
 *      off, so an empty allowlist means the open web — walling off a browser that is nobody
 *      protects nothing and breaks the first call. Which browser the agent got is the decision
 *      that carries the weight; this rule follows it.
 *   2. STRUCTURED HOST COMPARISON, NOT STRING PREFIX. An entry authorizes its host AND that
 *      host's subdomains — `deepseek.com` covers `www.deepseek.com`, because a site whose apex
 *      redirects to `www` is one site to the owner who typed it. The match is made on the
 *      PARSED host at a DOT BOUNDARY, so `deepseek.com.evil.com` and `evildeepseek.com` are
 *      both outside it, as is `https://deepseek.com@evil.com` (whose real host is `evil.com`).
 *      An entry that is an IP literal matches EXACTLY — suffix logic on numbers would let
 *      `168.1.5` admit `192.168.1.5`. The scheme must match too, and a plain host is read as
 *      `https`, so authorizing a site never implies its plaintext form.
 *   3. IT JUDGES THE REAL TARGET. Callers must pass the URL that will actually be acted on —
 *      parsed from the live tab or the navigation argument — never a separate origin field the
 *      agent supplies alongside it, which the agent could simply lie about.
 *
 * KNOWN LIMIT: there is no public-suffix list here, so an owner who writes a suffix that is not
 * a registrable domain (`co.uk`) authorizes everything under it. Owner input, owner scope.
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

/** True for a literal address — `127.0.0.1`, or a bracketed IPv6 host as `URL` reports it. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Normalize an owner-configured allowlist entry to a comparable ORIGIN.
 *
 * Accepts what an owner would naturally type — `github.com`, `https://github.com`,
 * `https://github.com/` — and resolves each to a canonical origin. A bare host is treated as
 * `https`, because defaulting to plaintext for a convenience input is the wrong default.
 * Anything that will not parse is dropped rather than guessed at: a malformed entry must not
 * silently widen or narrow the gate in some unintended direction.
 *
 * A SINGLE-LABEL host is dropped unless it is `localhost` or an address literal: since an entry
 * now covers its subdomains, accepting `com` would authorize most of the web from one typo.
 */
export function normalizeAllowEntry(entry: string): string | undefined {
  const raw = (entry ?? "").trim();
  if (!raw) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (!ALLOWED_SCHEMES.has(u.protocol)) return undefined;
    if (!u.hostname) return undefined;
    if (!u.hostname.includes(".") && u.hostname !== "localhost" && !isIpLiteral(u.hostname)) {
      return undefined;
    }
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
export function judgeUrl(
  url: string | undefined,
  allowlist: readonly string[] | undefined,
  unrestricted = false,
): OriginVerdict {
  const allowed = normalizeAllowlist(allowlist);
  // `unrestricted` is the LAUNCH-mode default: a browser Plexus started on its own empty
  // profile has no cookies and no logged-in sessions, so there is no authenticated anything to
  // wall off — requiring a domain list there would only make the first call fail while
  // protecting nothing. The scheme rule below still applies.
  if (!unrestricted && allowed.length === 0) {
    // Unset means inert, not open — checked FIRST so an unconfigured source cannot be probed
    // for what parses.
    return { allowed: false, reason: "no-allowlist" };
  }

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
  // Property 2. `new URL` has already resolved userinfo, case and punycode on BOTH sides, so
  // the comparison below is between real hosts: `https://github.com@evil.com` arrives here as
  // host `evil.com`, and `github.com.evil.com` as its own host.
  if (unrestricted && allowed.length === 0) return { allowed: true, origin: parsed.origin };
  if (!allowed.some((entry) => covers(entry, parsed))) {
    return { allowed: false, reason: "not-allowed", origin: parsed.origin };
  }
  return { allowed: true, origin: parsed.origin };
}

/**
 * Does one normalized allowlist entry cover this URL?
 *
 * Scheme must match. A port on the entry must match exactly; an entry without one covers any
 * port on the host. The host matches itself or any subdomain of it — at a DOT BOUNDARY, which
 * is what keeps `evildeepseek.com` out of `deepseek.com`. Address literals match exactly.
 */
function covers(entry: string, url: URL): boolean {
  let e: URL;
  try {
    e = new URL(entry);
  } catch {
    return false;
  }
  if (e.protocol !== url.protocol) return false;
  if (e.port !== "" && e.port !== url.port) return false;
  if (isIpLiteral(e.hostname)) return url.hostname === e.hostname;
  return url.hostname === e.hostname || url.hostname.endsWith(`.${e.hostname}`);
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
