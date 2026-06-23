/**
 * Host/Origin guard middleware (§5b, ADR-016) — enforced on EVERY endpoint BEFORE
 * auth. Loopback bind alone stops neither other local processes nor a
 * DNS-rebinding browser attack; this validates the `Host` header is a LOOPBACK
 * authority (127.0.0.1 / localhost / [::1], any port — see tfix1 / LOOPBACK_HOSTNAMES)
 * and validates `Origin`. Non-loopback Host/Origin ⇒ `host_forbidden`.
 *
 * The policy + check are REAL (the contract pins this down precisely). It is wired
 * into the Hono app in `server.ts`.
 */

import type { MiddlewareHandler } from "hono";
import type { HostOriginPolicy, ErrorResponse } from "../protocol/index.ts";
import { type GatewayConfig, baseUrl, expectedHost } from "../config.ts";

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
 * The security property of the Host/Origin guard is "loopback only", NOT "this
 * exact port". An attacker already on loopback can reach any local port directly,
 * so pinning the Host to one specific configured port adds no defense — it only
 * breaks ephemeral-port binds (`Bun.serve({ port: 0 })`), where the OS-assigned
 * authority (e.g. 127.0.0.1:54321) diverges from `config.port` and every request
 * would be wrongly rejected `host_forbidden`. The DNS-rebinding / non-loopback
 * defense is fully preserved: any Host whose hostname is NOT one of these (e.g.
 * `evil.example.com`, a LAN IP, `0.0.0.0`) is still rejected.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True iff `authority` (a Host-header value like "127.0.0.1:54321") is loopback on any port. */
function isLoopbackAuthority(authority: string): boolean {
  // Split host:port from the right so IPv6 "[::1]:1234" keeps its bracketed host intact.
  const lastColon = authority.lastIndexOf(":");
  // A bare hostname with no port (e.g. "localhost") is also acceptable.
  const hostname = lastColon > authority.lastIndexOf("]") ? authority.slice(0, lastColon) : authority;
  return LOOPBACK_HOSTNAMES.has(hostname);
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

/** Evaluate the Host/Origin policy against a request's headers. */
export function checkHostOrigin(
  policy: HostOriginPolicy,
  host: string | null,
  origin: string | null,
): { ok: true } | { ok: false; reason: string } {
  // Host must be a loopback authority — the bound authority, or ANY loopback host
  // on ANY port (tfix1: ephemeral-port binds; see LOOPBACK_HOSTNAMES). The exact
  // configured authority still matches as a subset; non-loopback is still rejected.
  if (host === null || !isLoopbackAuthority(host)) {
    return { ok: false, reason: `Host '${host ?? "<missing>"}' is not a loopback authority` };
  }
  // Origin, when present (browser context), must be allow-listed OR a loopback
  // origin (same any-port-loopback rationale: a loopback page is co-located with
  // the gateway; cross-origin NON-loopback Origins are still rejected).
  if (origin !== null) {
    if (!policy.allowedOrigins.includes(origin) && !isLoopbackOrigin(origin)) {
      return { ok: false, reason: `Origin '${origin}' is not allowed` };
    }
  } else if (!policy.allowMissingOrigin) {
    return { ok: false, reason: "Origin header is required but missing" };
  }
  return { ok: true };
}

/** Hono middleware enforcing the Host/Origin guard before any handler. */
export function hostOriginGuard(config: GatewayConfig): MiddlewareHandler {
  const policy = buildHostOriginPolicy(config);
  return async (c, next) => {
    const result = checkHostOrigin(policy, c.req.header("host") ?? null, c.req.header("origin") ?? null);
    if (!result.ok) {
      const body: ErrorResponse = {
        error: { code: "host_forbidden", message: result.reason },
      };
      return c.json(body, 403);
    }
    await next();
  };
}
