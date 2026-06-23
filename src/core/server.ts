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
import type { ErrorResponse, SourceRegistry } from "../protocol/index.ts";
import { type GatewayConfig } from "../config.ts";
import { buildWellKnown } from "./well-known.ts";
import { hostOriginGuard } from "./security.ts";
import { createGatewayState, type GatewayState } from "./state.ts";
import { Handlers } from "./handlers.ts";
import { createAdminApp } from "./admin.ts";
import { defaultAuthorizer } from "../auth/index.ts";
import type { CapabilityRegistry } from "./capability-registry.ts";
import type { Authorizer } from "../protocol/index.ts";

/** Optional injection points (tests inject a fake source/capability registry). */
export interface AppOverrides {
  sources?: SourceRegistry;
  capabilities?: CapabilityRegistry;
  authorizer?: Authorizer;
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
    });
  const handlers = new Handlers(
    state,
    overrides?.authorizer ??
      defaultAuthorizer({
        managedSources: () => new Set(state.managedSources.list().map((s) => s.id)),
        defaultTrustWindows: config.auth.defaultTrustWindows,
      }),
  );

  const app = new Hono();

  // §5b — Host/Origin guard on EVERY endpoint, BEFORE auth.
  app.use("*", hostOriginGuard(config));

  // ── 1. DISCOVER — GET /.well-known/plexus (unauthenticated, summary tier) ──
  app.get("/.well-known/plexus", (c) => {
    const doc = buildWellKnown(config, state.capabilities.summaries());
    return c.json(doc);
  });

  // ── 2. UNDERSTAND — POST /link/handshake ──────────────────────────────────
  app.post("/link/handshake", handlers.handshake);

  // ── 3. GRANTED — grants surface ───────────────────────────────────────────
  app.put("/grants", handlers.putGrants);
  app.get("/grants", handlers.grantsList);
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
  app.route("/admin", createAdminApp(state));

  // ── Uniform fallthrough error envelope ────────────────────────────────────
  app.notFound((c) => {
    const body: ErrorResponse = {
      error: { code: "unknown_capability", message: `No route for ${c.req.method} ${c.req.path}` },
    };
    return c.json(body, 404);
  });

  return { app, state };
}

/** Build just the Hono app (the entrypoint + existing tests use this). */
export function createApp(config: GatewayConfig): Hono {
  return createAppWithState(config).app;
}
