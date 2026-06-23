/**
 * `local-rest` transport — HTTP(S) against a localhost service the app exposes
 * (e.g. Obsidian Local REST API). Plexus acts as the HTTP client. (ADR-003.)
 *
 * Routing config lives on `entry.extras.route` (mirrors `ExtensionCapabilityDecl.route`,
 * read ONLY by this transport — never by core):
 *
 *   route = {
 *     app?: string,                 // LocalServiceHint app id → locateLocalService
 *     baseUrl?: string,             // explicit base, overrides app discovery
 *     defaultPort?: number,
 *     method?: "GET"|"POST"|...,    // default: GET for read-only, POST otherwise
 *     path: string,                 // e.g. "/vault/{path}" — {tokens} filled from input
 *     bodyFrom?: "input",           // send the (path-substituted-remainder of) input as JSON body
 *     secret?: { name, attach, as } // ExtensionSecretRef — how to present the credential
 *   }
 *
 * The secret VALUE is resolved at dispatch time via the platform seam and attached
 * to the outgoing request only; it never enters the entry, manifest, or audit.
 */

import type {
  Transport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
  ExtensionSecretRef,
} from "../protocol/index.ts";
import type { PlatformServices } from "../platform/index.ts";
import { isAllowedHost, restPolicyFromRoute } from "./transport-policy.ts";

interface RestRoute {
  app?: string;
  baseUrl?: string;
  defaultPort?: number;
  method?: string;
  path: string;
  bodyFrom?: "input";
  secret?: ExtensionSecretRef;
  /** Security policy (read by the egress policy, not by core): user-confirmed hosts. */
  allowedHosts?: string[];
}

export class LocalRestTransport implements Transport {
  readonly kind = "local-rest" as const;

  constructor(private readonly platform: PlatformServices) {}

  async dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    _ctx?: TransportDispatchContext,
  ): Promise<TransportResult> {
    const route = entry.extras?.route as RestRoute | undefined;
    if (!route || !route.path) {
      return this.err(`local-rest: entry ${entry.id} has no extras.route.path`);
    }

    // 1) Resolve base URL: explicit baseUrl, else locate the app's local service.
    let baseUrl = route.baseUrl;
    let secretRef: string | undefined = route.secret?.name;
    if (!baseUrl) {
      if (!route.app) {
        return this.err(`local-rest: entry ${entry.id} route needs baseUrl or app`);
      }
      const located = await this.platform.locateLocalService({
        app: route.app,
        ...(route.defaultPort !== undefined ? { defaultPort: route.defaultPort } : {}),
      });
      if (!located) {
        return {
          ok: false,
          error: {
            code: "source_unavailable",
            message: `local-rest: ${route.app} service not reachable`,
            capabilityId: entry.id,
          },
        };
      }
      baseUrl = located.address;
      secretRef = secretRef ?? located.secretRef;
    }

    // SECURITY (#3): egress confinement. An explicit `route.baseUrl` BYPASSED the
    // loopback check before — validate the RESOLVED baseUrl (explicit or located) here
    // so an attacker manifest cannot point Plexus at 169.254.169.254 / attacker.example
    // / a LAN IP. Loopback is always allowed; a non-loopback host is allowed ONLY if the
    // user confirmed it into the per-extension host allow-list. Rejected ⇒ host_forbidden
    // (the same code the gateway's own Host guard uses). The secret-attach below is gated
    // on this decision so a credential NEVER leaks to a non-allow-listed host.
    const hostPolicy = restPolicyFromRoute(route as unknown as Record<string, unknown>);
    const hostDecision = isAllowedHost(baseUrl, hostPolicy);
    if (!hostDecision.allowed) {
      return {
        ok: false,
        error: {
          code: "host_forbidden",
          message: hostDecision.message ?? "local-rest: destination host not allowed",
          capabilityId: entry.id,
          detail: { policy: "local-rest-egress", reason: hostDecision.reason },
        },
      };
    }

    // 2) Substitute {tokens} in the path from input; track consumed keys.
    const consumed = new Set<string>();
    const path = route.path.replace(/\{(\w+)\}/g, (_m, key: string) => {
      consumed.add(key);
      const v = input[key];
      return encodeURIComponent(v === undefined || v === null ? "" : String(v));
    });
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").toString();

    // SECURITY (#3, defense-in-depth): `new URL(path, baseUrl)` lets an absolute or
    // protocol-relative `route.path` (e.g. "http://evil/x" or "//evil/x") OVERRIDE the
    // host of the validated baseUrl. Re-validate the FINAL resolved URL host so the path
    // cannot smuggle the request to a forbidden host. This is also the decision the
    // secret-attach is gated on.
    const finalDecision = isAllowedHost(url, hostPolicy);
    if (!finalDecision.allowed) {
      return {
        ok: false,
        error: {
          code: "host_forbidden",
          message: finalDecision.message ?? "local-rest: destination host not allowed",
          capabilityId: entry.id,
          detail: { policy: "local-rest-egress", reason: finalDecision.reason },
        },
      };
    }

    const method = (route.method ?? (entry.grants.includes("write") ? "POST" : "GET")).toUpperCase();
    const headers: Record<string, string> = { Accept: "application/json" };

    // 3) Attach the secret per its ExtensionSecretRef.attach mode (value never logged).
    // GATED on the egress decision: a resolved secret is attached ONLY when the final
    // destination is loopback or a user-confirmed allow-listed host. (The request is
    // already host_forbidden-rejected above for any other host, so this gate is a
    // belt-and-suspenders guarantee that the credential can never reach a foreign host.)
    let finalUrl = url;
    if (secretRef && finalDecision.allowed) {
      const value = await this.platform.resolveSecret(secretRef);
      if (value) {
        const attach = route.secret?.attach ?? "bearer";
        if (attach === "bearer") {
          headers["Authorization"] = `Bearer ${value}`;
        } else if (attach === "header" && route.secret?.as) {
          headers[route.secret.as] = value;
        } else if (attach === "query" && route.secret?.as) {
          const u = new URL(finalUrl);
          u.searchParams.set(route.secret.as, value);
          finalUrl = u.toString();
        }
        // attach:"env" is not meaningful for an HTTP client — ignored here.
      }
    }

    // 4) Body: the non-consumed remainder of input as JSON (for non-GET).
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const remainder: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        if (!consumed.has(k)) remainder[k] = v;
      }
      body = JSON.stringify(route.bodyFrom === "input" ? input : remainder);
      headers["Content-Type"] = "application/json";
    }

    // 5) Issue the request.
    try {
      const res = await fetch(finalUrl, { method, headers, ...(body !== undefined ? { body } : {}) });
      const text = await res.text();
      let data: unknown = text;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json") && text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        return {
          ok: false,
          error: {
            code: "transport_error",
            message: `local-rest: HTTP ${res.status}`,
            capabilityId: entry.id,
            detail: { status: res.status },
          },
        };
      }
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "transport_error",
          message: err instanceof Error ? err.message : String(err),
          capabilityId: entry.id,
        },
      };
    }
  }

  private err(message: string): TransportResult {
    return { ok: false, error: { code: "transport_error", message } };
  }
}
