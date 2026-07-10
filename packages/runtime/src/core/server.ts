/**
 * Gateway server bootstrap — the Hono app (§2 endpoint contract, §7 four jobs).
 *
 * The core routes through the registry/seams; it does NOT branch on
 * source/transport type. The session-scoped endpoints (handshake / grants /
 * refresh / revoke / grant-status / invoke / manifest / events / extensions) are
 * implemented by the `Handlers` bundle over the wired `GatewayState`. The
 * Host/Origin guard (§5b) runs on EVERY route BEFORE auth, and the unauthenticated
 * `.well-known` discovery doc (ADR-008) is served summary-tier.
 */

import { Hono } from "hono";
import type { ErrorResponse, SourceRegistry } from "@plexus/protocol";
import { type GatewayConfig } from "../config.ts";
import { buildPublicWellKnown } from "./well-known.ts";
import { hostOriginGuard } from "./security.ts";
import { createGatewayState, type GatewayState } from "./state.ts";
import { Handlers } from "./handlers.ts";
import { createAdminApp } from "./admin.ts";
import { createIntegrationApp } from "./integration-endpoint.ts";
import { createV1App } from "./v1.ts";
import { defaultAuthorizer } from "../auth/index.ts";
import type { CapabilityRegistry } from "./capability-registry.ts";
import type { Authorizer } from "@plexus/protocol";
import type { MeshRuntimeOptions } from "../mesh/runtime.ts";

/** Optional injection points (tests inject a fake source/capability registry). */
export interface AppOverrides {
  sources?: SourceRegistry;
  capabilities?: CapabilityRegistry;
  authorizer?: Authorizer;
  /** Mesh identity/join-token injection (T12) — for in-process primary+proxy auth tests. */
  mesh?: MeshRuntimeOptions;
  /** Use a pre-built state (tests that need to poke the stores directly). */
  state?: GatewayState;
}

/**
 * Build the Hono app + the wired `GatewayState`. Returns both so callers (tests,
 * the curl smoke-flow) can reach into the stores. Pure construction; no listening
 * here (see `index.ts`).
 */
export function createAppWithState(
  config: GatewayConfig,
  overrides?: AppOverrides,
): { app: Hono; state: GatewayState } {
  const state =
    overrides?.state ??
    createGatewayState(config, {
      ...(overrides?.sources ? { sources: overrides.sources } : {}),
      ...(overrides?.capabilities ? { capabilities: overrides.capabilities } : {}),
      ...(overrides?.mesh ? { mesh: overrides.mesh } : {}),
    });
  const handlers = new Handlers(
    state,
    overrides?.authorizer ??
      defaultAuthorizer({
        managedSources: () => new Set(state.managedSources.list().map((s) => s.id)),
        // Per-instance "Protected" posture: sources configured approval:"ask" NEVER
        // auto-allow — every verb (reads included) pends for the owner on first use.
        askSources: () =>
          new Set(
            state.managedSources
              .list()
              .filter((s) => (s.approval ?? "auto") === "ask")
              .map((s) => s.id),
          ),
        defaultTrustWindows: config.auth.defaultTrustWindows,
        // Optional pend-policy override: PLEXUS_CONFIRM_MODE=confirm-all pends EVERY
        // grant (incl. low-risk first-party reads) so a revoked capability is NOT
        // silently auto-re-granted on re-request. Default stays "confirm-risky".
        ...(process.env.PLEXUS_CONFIRM_MODE === "confirm-all" ? { mode: "confirm-all" as const } : {}),
      }),
  );

  const app = new Hono();

  // §5b — Host/Origin guard on EVERY endpoint, BEFORE auth.
  app.use("*", hostOriginGuard(config));

  // ── 1. DISCOVER — GET /.well-known/plexus (unauthenticated, lifecycle-only) ──
  // Authorized-subset model (`docs/design/agent-authorized-subset.md` §3.3): the public,
  // pre-identity discovery doc advertises the gateway identity + the lifecycle/auth
  // endpoints ONLY — NO capability catalog. A cold caller enrolls + handshakes to receive
  // the capabilities Plexus authorized IT to access (its scoped manifest), so an agent
  // never learns Plexus has more than its subset and no catalog is enumerable pre-identity.
  // Reports the ACTUAL bound port when known (REDESIGN-ARCHITECTURE §3.4).
  app.get("/.well-known/plexus", (c) => {
    return c.json(buildPublicWellKnown(config, state.boundPort));
  });

  // ── 1b. SIGNPOST — GET / (unauthenticated, same exposure as `.well-known`) ──
  // A cold agent that lands on the root immediately learns where the real discovery
  // doc lives. Registered as a REAL route (precedes the catch-all) so `/` no longer
  // falls through to the `unknown_capability` 404. Purely a pointer; carries no data.
  app.get("/", (c) =>
    c.json({
      service: "plexus",
      discovery: "/.well-known/plexus",
      hint: "GET /.well-known/plexus for the gateway identity + enroll/handshake flow",
    }),
  );

  // ── 2. UNDERSTAND — POST /link/handshake ──────────────────────────────────
  app.post("/link/handshake", handlers.handshake);

  // ── 2b. ENROLL — POST /agents/enroll (agent-skill-compile §3 / ADR-4) ──────
  // Redeem a one-time enrollment code → durable per-agent bearer PAT. UNAUTHENTICATED
  // by design (the code IS the credential; the admin connection-key is never accepted
  // here). Still behind the Host/Origin guard (loopback-only), like every route.
  app.post("/agents/enroll", handlers.enrollAgent);

  // ── 3. GRANTED — grants surface ───────────────────────────────────────────
  app.put("/grants", handlers.putGrants);
  app.get("/grants", handlers.grantsList);
  app.get("/grants/context", handlers.grantsContext);
  app.post("/grants/refresh", handlers.refresh);
  app.post("/grants/revoke", handlers.revoke);
  app.get("/grants/status", handlers.grantStatus);

  // ── 4. CALL — POST /invoke ─────────────────────────────────────────────────
  app.post("/invoke", handlers.invoke);

  // ── Lifecycle endpoints ────────────────────────────────────────────────────
  app.get("/manifest", handlers.manifest);
  app.get("/events", handlers.events);
  app.post("/extensions", handlers.extensions);
  app.delete("/extensions/:source", handlers.deleteExtension);

  // ── Local management client (t11) — same-origin admin SPA + admin API ───────
  // Mounted under `/admin`, AFTER the Host/Origin guard (which runs on `*`), so
  // every admin request stays loopback-only + same-origin guarded. The UI is
  // served as static assets from the SAME origin it calls, satisfying §5b.
  const adminApp = createAdminApp(state);
  app.route("/admin", adminApp);

  // ── DELIVER — GET /integration/:agentId (D1-ENDPOINT, agent-skill-compile §5) ─
  // The copy-able ONE-COMMAND install for an already-connected agent: compiles the
  // agent's granted cap-set + the Floor into a CC plugin (G1), gates it through the
  // Floor oracle (G3 assertVerified), and returns the install command carrying a
  // FRESH one-time enrollment code. Management-key gated (its OWN guard, outside
  // `/admin/api/*`); never agent-reachable. Mounted after the Host/Origin guard.
  app.route("/integration", createIntegrationApp(state));

  // ── LRA v1 — the thin status/health/config/rotate endpoints + the MANAGEMENT
  // event stream (REDESIGN-ARCHITECTURE §2.2–§2.4). Mounted AFTER the Host/Origin
  // guard (loopback-only); its mutating + push routes are management-key gated. The
  // SAME `adminApp` is re-mounted under `/v1/admin` so `/v1/admin/api/*` is a working
  // alias of `/admin/api/*` (the existing CLI + web admin keep using `/admin/api/*`).
  app.route("/v1", createV1App(state, adminApp));

  // ── Uniform fallthrough error envelope ────────────────────────────────────
  app.notFound((c) => {
    const body: ErrorResponse = {
      error: {
        code: "unknown_capability",
        message: `No route for ${c.req.method} ${c.req.path}. See GET /.well-known/plexus for the gateway identity + enroll/handshake flow.`,
        discovery: "/.well-known/plexus",
      },
    };
    return c.json(body, 404);
  });

  return { app, state };
}

/** Build just the Hono app (the entrypoint + existing tests use this). */
export function createApp(config: GatewayConfig): Hono {
  return createAppWithState(config).app;
}
