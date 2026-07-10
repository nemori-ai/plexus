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
 *     pathTemplate: string,         // e.g. "/vault/{path}" — {tokens} filled from input
 *                                   //   (EXTENSION-SPEC §6 field; `path` accepted as a legacy alias)
 *     queryFrom?: string[],         // input fields appended as URL query params (consumed)
 *     bodyFrom?: "input"|"content"|"none", // "input"=whole-input JSON; "content"=raw single
 *                                   //   field; "none"=no request body (query-param-only POST)
 *     bodyField?: string,           // bodyFrom:"content" — which field is the raw body (def "content")
 *     bodyContentType?: string,     // bodyFrom:"content" — body Content-Type (def "text/markdown")
 *     secret?: { name, attach, as } // ExtensionSecretRef — how to present the credential
 *   }
 *
 * HTTPS: `baseUrl` may be `https://…`. A self-signed certificate is accepted ONLY when the
 * final destination is loopback (the Obsidian Local REST API serves self-signed HTTPS on
 * 127.0.0.1) — a non-loopback HTTPS host still gets full cert verification. See step 5.
 *
 * REDIRECTS (egress re-gating — SECURITY #1): the request is issued with
 * `redirect:"manual"` so `fetch` NEVER auto-follows a 3xx. A redirect would otherwise
 * escape the egress allow-list: a `local-rest` listener the extension controls on
 * loopback (which passes `isAllowedHost` and gets the Bearer attached) could answer
 * `302 Location: http://169.254.169.254/…` and `fetch`, following it, would re-issue the
 * request — Authorization header included — to the metadata/internal host. Instead, on a
 * 3xx we resolve the `Location`, re-run the SAME `isAllowedHost` gate on the redirect
 * target, and only follow it MANUALLY (re-applying the host gate + the per-host
 * secret-attach + the loopback-only TLS relaxation FRESH for the new hop) when it is
 * allowed; a redirect to a non-allow-listed host is refused with `host_forbidden` and the
 * secret is NEVER attached/replayed to it. Bounded to MAX_REDIRECT_HOPS to stop loops.
 *
 * The secret VALUE is resolved at dispatch time via the platform seam and attached
 * to the outgoing request only; it never enters the entry, manifest, or audit. The
 * secret-attach decision is re-evaluated per hop against that hop's egress decision, so
 * the credential can only ever reach a loopback / user-allow-listed host.
 */

import type {
  Transport,
  CapabilityEntry,
  TransportDispatchContext,
  TransportResult,
  ExtensionSecretRef,
} from "@plexus/protocol";
import type { PlatformServices } from "../platform/index.ts";
import { isAllowedHost, restPolicyFromRoute } from "./transport-policy.ts";

interface RestRoute {
  app?: string;
  baseUrl?: string;
  defaultPort?: number;
  method?: string;
  /**
   * The URL path template (`{token}` interpolation). EXTENSION-SPEC §6 publishes this
   * field as `pathTemplate`; the meta-skill generator emits `pathTemplate`. Legacy
   * first-party callers (and direct test entries) may use `path` — we accept either,
   * canonical = `pathTemplate`, with `path` as a back-compat alias. See `pathOf()`.
   */
  pathTemplate?: string;
  /** Legacy alias for `pathTemplate` (kept working for back-compat). */
  path?: string;
  /**
   * Token names that interpolate as a multi-segment PATH (slashes preserved, each segment
   * still percent-escaped) rather than a single fully-escaped component. Needed for the
   * Obsidian REST shape `/vault/{path}` (path = "Daily/Note.md"). The final-URL host
   * re-validation still runs, so a path token cannot smuggle the request off-host.
   */
  pathTokens?: string[];
  /**
   * Input field names appended to the request URL as query-string parameters
   * (`?name=value`, percent-escaped via URLSearchParams). A named field that is
   * `undefined`/`null` in the input is omitted. Consumed fields do NOT flow into a
   * JSON remainder body. Generic: any query-param-driven endpoint (e.g. a search
   * endpoint taking `?query=…`) declares its params here. Query params cannot change
   * the URL host, and the final URL is still host-re-validated below.
   */
  queryFrom?: string[];
  /**
   * How to build the request body for a mutating (non-GET/HEAD) method:
   *  - "input"   : send the WHOLE input object as a JSON body.
   *  - "content" : send a SINGLE named input field (`bodyField`, default "content") as
   *    the RAW request body with `bodyContentType` (default "text/markdown"). This is the
   *    shape the Obsidian Local REST API PUT /vault/{path} expects (body = note markdown).
   *  - "none"    : send NO body — for endpoints driven purely by the URL (path/query
   *    params), e.g. a POST search endpoint whose inputs are all query params.
   *  - (unset)   : send the non-path-consumed remainder of input as a JSON body.
   */
  bodyFrom?: "input" | "content" | "none";
  /** For bodyFrom:"content": which input field carries the raw body (default "content"). */
  bodyField?: string;
  /** For bodyFrom:"content": the Content-Type of the raw body (default "text/markdown"). */
  bodyContentType?: string;
  secret?: ExtensionSecretRef;
  /** Security policy (read by the egress policy, not by core): user-confirmed hosts. */
  allowedHosts?: string[];
}

/**
 * The canonical URL path template for a route. EXTENSION-SPEC §6 publishes `pathTemplate`
 * (what the meta-skill generator emits); `path` is the legacy alias. Returns whichever is
 * present, preferring the spec field. The returned value still flows through the SAME
 * loopback + final-URL host re-validation as before, so the field choice cannot weaken
 * the egress confinement.
 */
function pathOf(route: RestRoute): string | undefined {
  return route.pathTemplate ?? route.path;
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
    const routePath = route ? pathOf(route) : undefined;
    if (!route || !routePath) {
      return this.err(`local-rest: entry ${entry.id} has no extras.route.pathTemplate`);
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
    // By default each token is fully `encodeURIComponent`-escaped (so a `/` or a host-
    // smuggling token like "//evil" is neutralized). A token NAMED in `route.pathTokens`
    // is treated as a multi-segment PATH (slashes preserved) — needed for the Obsidian
    // REST shape `/vault/{path}` where path = "Daily/Note.md". Each segment is still
    // percent-escaped, and the FINAL resolved URL host is re-validated below, so a
    // path-style token still cannot smuggle the request to a forbidden host.
    const pathTokens = new Set(
      Array.isArray(route.pathTokens) ? route.pathTokens.filter((t): t is string => typeof t === "string") : [],
    );
    const consumed = new Set<string>();
    const path = routePath.replace(/\{(\w+)\}/g, (_m, key: string) => {
      consumed.add(key);
      const v = input[key];
      const s = v === undefined || v === null ? "" : String(v);
      if (pathTokens.has(key)) {
        return s.split("/").map(encodeURIComponent).join("/");
      }
      return encodeURIComponent(s);
    });
    const urlObj = new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");

    // 2b) Append declared query params from input (`route.queryFrom`). URLSearchParams
    // percent-escapes values, and a query string cannot change the URL host — the final
    // URL is still re-validated below regardless. Consumed fields are excluded from a
    // JSON remainder body (same discipline as path tokens).
    if (Array.isArray(route.queryFrom)) {
      for (const key of route.queryFrom) {
        if (typeof key !== "string") continue;
        consumed.add(key);
        const v = input[key];
        if (v === undefined || v === null) continue;
        urlObj.searchParams.set(key, String(v));
      }
    }
    const url = urlObj.toString();

    // SECURITY (#3, defense-in-depth): `new URL(path, baseUrl)` lets an absolute or
    // protocol-relative pathTemplate (e.g. "http://evil/x" or "//evil/x") OVERRIDE the
    // host of the validated baseUrl. This holds for WHICHEVER field supplied the value
    // (`pathTemplate` or the legacy `path`) — both flow through `pathOf` into this same
    // check. Re-validate the FINAL resolved URL host so the path
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

    // 3) Resolve the secret VALUE once (value never logged). It is ATTACHED per hop in the
    // redirect loop below — and ONLY to a hop whose own egress decision is allowed — so the
    // credential can never be replayed to a host that fails the gate (SECURITY #1).
    const secretValue = secretRef ? await this.platform.resolveSecret(secretRef) : undefined;

    // 4) Body for a mutating method (non-GET/HEAD). The body's Content-Type is set per hop
    // in the request loop (from `route.bodyFrom`), since the headers are rebuilt each hop.
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD" && route.bodyFrom !== "none") {
      if (route.bodyFrom === "content") {
        // RAW-body mode (Obsidian PUT /vault/{path}): a single named field is the body.
        const field = route.bodyField ?? "content";
        const raw = input[field];
        body = raw === undefined || raw === null ? "" : String(raw);
      } else {
        const remainder: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) {
          if (!consumed.has(k)) remainder[k] = v;
        }
        body = JSON.stringify(route.bodyFrom === "input" ? input : remainder);
      }
    }

    // 5) Issue the request with MANUAL redirect handling (SECURITY #1 — egress re-gating).
    //
    // `redirect:"manual"` stops `fetch` from auto-following a 3xx; if it did, the redirect
    // target would bypass the egress allow-list and the Authorization header could be
    // replayed to a metadata/internal host. On a 3xx we re-run the SAME `isAllowedHost`
    // gate on the resolved `Location` and only follow it (FRESH per-hop host gate +
    // secret-attach + TLS relaxation) when allowed; otherwise we refuse with host_forbidden
    // and never attach the secret to it. Bounded by MAX_REDIRECT_HOPS to stop loops.
    //
    // SECURITY (HTTPS self-signed acceptance — rwapi): the Obsidian Local REST API serves
    // HTTPS on loopback with a SELF-SIGNED certificate, so a normal fetch would fail cert
    // verification. We relax verification ONLY when THIS hop's already-egress-validated
    // destination is loopback AND the scheme is https — so a public/non-loopback HTTPS host
    // still gets FULL certificate verification. The relaxation is per-request (Bun's `tls`
    // fetch option), NEVER global (no NODE_TLS_REJECT_UNAUTHORIZED / process-wide agent).
    const MAX_REDIRECT_HOPS = 3;
    let currentUrl = url;
    let currentDecision = finalDecision; // the initial `url` was already gated above.
    try {
      for (let hop = 0; ; hop++) {
        // Build the per-hop headers FRESH: the secret is attached ONLY because this hop's
        // egress decision is `allowed` (loopback / user-allow-listed). A hop that failed
        // the gate is refused below before we ever reach here.
        const headers: Record<string, string> = { Accept: "application/json" };
        let hopUrl = currentUrl;
        if (secretValue && currentDecision.allowed) {
          const attach = route.secret?.attach ?? "bearer";
          if (attach === "bearer") {
            headers["Authorization"] = `Bearer ${secretValue}`;
          } else if (attach === "header" && route.secret?.as) {
            headers[route.secret.as] = secretValue;
          } else if (attach === "query" && route.secret?.as) {
            const u = new URL(hopUrl);
            u.searchParams.set(route.secret.as, secretValue);
            hopUrl = u.toString();
          }
          // attach:"env" is not meaningful for an HTTP client — ignored here.
        }
        if (body !== undefined && method !== "GET" && method !== "HEAD") {
          headers["Content-Type"] =
            route.bodyFrom === "content"
              ? route.bodyContentType ?? "text/markdown"
              : "application/json";
        }

        const isHttps = (() => {
          try {
            return new URL(hopUrl).protocol === "https:";
          } catch {
            return false;
          }
        })();
        const tlsRelax =
          isHttps && currentDecision.loopback ? { tls: { rejectUnauthorized: false } } : {};

        const res = await fetch(hopUrl, {
          method,
          headers,
          redirect: "manual",
          ...tlsRelax,
          ...(body !== undefined ? { body } : {}),
        });

        // ── Redirect handling: re-gate the Location target before following. ──
        if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
          if (hop >= MAX_REDIRECT_HOPS) {
            return {
              ok: false,
              error: {
                code: "transport_error",
                message: `local-rest: too many redirects (>${MAX_REDIRECT_HOPS})`,
                capabilityId: entry.id,
                detail: { policy: "local-rest-egress", reason: "redirect_loop" },
              },
            };
          }
          const loc = res.headers.get("location") ?? "";
          let nextUrl: string;
          try {
            nextUrl = new URL(loc, hopUrl).toString();
          } catch {
            return {
              ok: false,
              error: {
                code: "transport_error",
                message: "local-rest: redirect Location is malformed",
                capabilityId: entry.id,
                detail: { policy: "local-rest-egress", reason: "redirect_malformed" },
              },
            };
          }
          const nextDecision = isAllowedHost(nextUrl, hostPolicy);
          if (!nextDecision.allowed) {
            // Refuse: do NOT follow + do NOT replay the secret to a non-allow-listed host.
            return {
              ok: false,
              error: {
                code: "host_forbidden",
                message: nextDecision.message ?? "local-rest: redirect target host not allowed",
                capabilityId: entry.id,
                detail: { policy: "local-rest-egress", reason: nextDecision.reason },
              },
            };
          }
          currentUrl = nextUrl;
          currentDecision = nextDecision;
          continue; // follow the redirect manually on the next hop.
        }

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
      }
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
