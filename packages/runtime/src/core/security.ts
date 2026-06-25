/**
 * Host/Origin guard middleware (§5b, ADR-016) — enforced on EVERY endpoint BEFORE
 * auth. Loopback bind alone stops neither other local processes nor a
 * DNS-rebinding browser attack; this validates the `Host` header is an ACCEPTED
 * authority and validates `Origin`. Non-accepted Host/Origin ⇒ `host_forbidden`.
 *
 * ── ACCEPTED authorities (FEAT configurable-binding) ─────────────────────────
 * By DEFAULT the gateway binds loopback only (`127.0.0.1`) and the guard accepts
 * ONLY loopback authorities — the historical, unchanged behavior (a non-loopback
 * Host, e.g. a LAN IP or a DNS-rebinding hostname, is still rejected). When the
 * USER opts to ALSO bind specific interface IPs (or `0.0.0.0` = all interfaces),
 * the guard additionally accepts a Host whose authority matches one of the ACTIVE
 * bound addresses — and ONLY those. The match is against the actual configured /
 * active bind set (a fixed snapshot of this machine's interface IPs for `0.0.0.0`),
 * NEVER "any host", so the guard never becomes an open bypass. Loopback is ALWAYS
 * accepted; the DNS-rebinding defense for the default loopback case is untouched.
 *
 * The policy + check are REAL (the contract pins this down precisely). It is wired
 * into the Hono app in `server.ts`.
 */

import type { MiddlewareHandler } from "hono";
import type { HostOriginPolicy, ErrorResponse } from "@plexus/protocol";
import {
  type GatewayConfig,
  baseUrl,
  expectedHost,
  scanNetworkInterfaces,
  BIND_ALL_IPV4,
  LOOPBACK_BIND_ADDRESS,
} from "../config.ts";

/** Build the default Host/Origin policy from config (management client origin allowed). */
export function buildHostOriginPolicy(config: GatewayConfig): HostOriginPolicy {
  return {
    expectedHost: expectedHost(config),
    // Default: only the management client's own origin (its UI lives on the same
    // loopback base). Agent CLIs send no Origin and are allowed via allowMissingOrigin.
    allowedOrigins: [baseUrl(config)],
    allowMissingOrigin: true,
  };
}

/**
 * Loopback hostnames the guard accepts on ANY port (tfix1).
 *
 * The security property of the loopback case is "loopback only", NOT "this exact
 * port". An attacker already on loopback can reach any local port directly, so
 * pinning the Host to one specific configured port adds no defense — it only
 * breaks ephemeral-port binds (`Bun.serve({ port: 0 })`), where the OS-assigned
 * authority (e.g. 127.0.0.1:54321) diverges from `config.port` and every request
 * would be wrongly rejected `host_forbidden`. The DNS-rebinding / non-loopback
 * defense is fully preserved: any Host whose hostname is NOT one of these (e.g.
 * `evil.example.com`, a non-configured LAN IP, `0.0.0.0`) is still rejected.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Extract the host portion of an authority like "127.0.0.1:54321" or "[::1]:1234". */
function hostnameOf(authority: string): string {
  // Split host:port from the right so IPv6 "[::1]:1234" keeps its bracketed host intact.
  const lastColon = authority.lastIndexOf(":");
  // A bare hostname with no port (e.g. "localhost") is also acceptable.
  return lastColon > authority.lastIndexOf("]") ? authority.slice(0, lastColon) : authority;
}

/** True iff `authority` (a Host-header value) is loopback on any port. */
function isLoopbackAuthority(authority: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostnameOf(authority));
}

/** True iff `origin` is a same-scheme loopback origin (http://<loopback>[:port]). */
function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // URL.hostname strips IPv6 brackets, so compare against the unbracketed form too.
  return (
    url.protocol === "http:" &&
    (LOOPBACK_HOSTNAMES.has(url.hostname) || LOOPBACK_HOSTNAMES.has(`[${url.hostname}]`))
  );
}

/**
 * Resolve the set of NON-loopback host strings the guard additionally accepts,
 * from the configured/active bind addresses. (SECURITY-CRITICAL — this is the
 * exact relaxation surface.)
 *
 *  - loopback literals never appear here (loopback is always accepted separately);
 *  - `0.0.0.0` (bind-all) expands to a fixed SNAPSHOT of this machine's interface
 *    addresses (IPv4 + IPv6), so a request reaching the gateway over ANY of its own
 *    interfaces is accepted — but a foreign Host (a name the machine doesn't own)
 *    is still rejected;
 *  - a specific user-chosen IP is accepted as-is.
 *
 * IPv6 addresses are stored bracketed (`[fe80::1]`) so they compare against the
 * bracketed Host authority form.
 */
function buildAllowedBoundHosts(bindAddresses: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  const add = (addr: string, family?: string): void => {
    if (addr === LOOPBACK_BIND_ADDRESS || addr === "::1") return; // loopback handled separately
    // Bracket IPv6 literals so they match the "[addr]:port" Host form.
    if (family === "IPv6" || (addr.includes(":") && !addr.includes("]"))) {
      allowed.add(`[${addr}]`);
    } else {
      allowed.add(addr);
    }
  };
  for (const addr of bindAddresses) {
    if (addr === BIND_ALL_IPV4) {
      // Expand bind-all to every concrete interface address (a fixed snapshot).
      for (const nic of scanNetworkInterfaces()) add(nic.address, nic.family);
    } else {
      add(addr);
    }
  }
  return allowed;
}

/** The extra (non-loopback) accept-set carried alongside the wire HostOriginPolicy. */
export interface BoundHostSet {
  /** Non-loopback host strings the guard accepts (from configured/active binds). */
  readonly hosts: ReadonlySet<string>;
}

/** Build the bound-host accept-set from a config's bindAddresses (loopback excluded). */
export function buildBoundHostSet(bindAddresses: readonly string[]): BoundHostSet {
  return { hosts: buildAllowedBoundHosts(bindAddresses) };
}

/**
 * Evaluate the Host/Origin policy against a request's headers. `bound` (optional)
 * carries the extra non-loopback host accept-set from the configured/active bind
 * addresses; when omitted, ONLY loopback is accepted (the default behavior).
 */
export function checkHostOrigin(
  policy: HostOriginPolicy,
  host: string | null,
  origin: string | null,
  bound?: BoundHostSet,
): { ok: true } | { ok: false; reason: string } {
  // Host must be a loopback authority (any port — tfix1) OR match one of the
  // configured/active bound interface addresses. Loopback is ALWAYS accepted; a
  // non-loopback Host is accepted ONLY when its host portion is in the bound set.
  if (host === null) {
    return { ok: false, reason: "Host '<missing>' is not an accepted authority" };
  }
  const acceptedHost =
    isLoopbackAuthority(host) || (bound ? bound.hosts.has(hostnameOf(host)) : false);
  if (!acceptedHost) {
    return { ok: false, reason: `Host '${host}' is not an accepted authority` };
  }
  // Origin, when present (browser context), must be allow-listed OR a loopback
  // origin OR an origin whose host matches one of the bound addresses (same any-port
  // rationale). Cross-origin NON-accepted Origins are still rejected.
  if (origin !== null) {
    const originOk =
      policy.allowedOrigins.includes(origin) ||
      isLoopbackOrigin(origin) ||
      (bound ? isBoundOrigin(origin, bound) : false);
    if (!originOk) {
      return { ok: false, reason: `Origin '${origin}' is not allowed` };
    }
  } else if (!policy.allowMissingOrigin) {
    return { ok: false, reason: "Origin header is required but missing" };
  }
  return { ok: true };
}

/** True iff `origin` is an http origin whose host is one of the bound addresses. */
function isBoundOrigin(origin: string, bound: BoundHostSet): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  // URL.hostname strips IPv6 brackets — compare against both forms.
  return bound.hosts.has(url.hostname) || bound.hosts.has(`[${url.hostname}]`);
}

/** Hono middleware enforcing the Host/Origin guard before any handler. */
export function hostOriginGuard(config: GatewayConfig): MiddlewareHandler {
  const policy = buildHostOriginPolicy(config);
  // Snapshot the non-loopback accept-set ONCE at construction from the configured
  // bind addresses. Loopback-only config ⇒ an empty set ⇒ the historical behavior.
  const bound = buildBoundHostSet(config.bindAddresses ?? []);
  return async (c, next) => {
    const result = checkHostOrigin(
      policy,
      c.req.header("host") ?? null,
      c.req.header("origin") ?? null,
      bound,
    );
    if (!result.ok) {
      const body: ErrorResponse = {
        error: { code: "host_forbidden", message: result.reason },
      };
      return c.json(body, 403);
    }
    await next();
  };
}
