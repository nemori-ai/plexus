/**
 * ============================================================================
 * LRA v1 — the thin Local Runtime API surface (REDESIGN-ARCHITECTURE §2.2–§2.4)
 * ============================================================================
 *
 * The versioned, transport-clean local contract every client (Electron / TUI /
 * web / CLI) speaks. This module mounts the NEW thin `/v1/*` endpoints + the
 * MANAGEMENT event stream, and aliases the existing `/admin/api/*` admin handlers
 * under `/v1` so one namespace carries the whole management plane:
 *
 *   GET  /v1/status                 — pid/version/protocol/port/uptime + counts (thin)
 *   GET  /v1/health                 — {ok:true} supervisor probe (trivial)
 *   GET  /v1/config                 — read auth-config (token lifetime, trust windows, …)
 *   PUT  /v1/config                 — write those auth-config.json fields (validated/clamped)
 *   POST /v1/connection-key/rotate  — expose connectionKey.rotate() (drops sessions/tokens)
 *   GET  /v1/events                 — MANAGEMENT SSE stream (§2.3 — the one real push gap)
 *   /v1/admin/api/*                 — the existing admin handlers, aliased under /v1
 *
 * AUTH: every MUTATING + push route is management-key gated (`X-Plexus-Connection-Key`,
 * verified via `state.connectionKey`) on top of the loopback Host/Origin guard that
 * `server.ts` already applies on `*`. Read-only probes (`/v1/health`, `/v1/status`,
 * `GET /v1/config`) stay loopback-only — they disclose local state but change nothing.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { GatewayState } from "./state.ts";
import { uptimeMs } from "./state.ts";
import { GrantService } from "./grant-service.ts";
import { defaultAuthorizer } from "../auth/index.ts";
import {
  PLEXUS_VERSION,
  PLEXUS_PROTOCOL,
  TOKEN_LIFETIME_MIN_MS,
  TOKEN_LIFETIME_MAX_MS,
  loadAuthConfig,
  writeAuthConfig,
  type AuthConfigPatch,
} from "../config.ts";
import { LRA_VERSION } from "../runtime/runtime-file.ts";

/**
 * Build the `/v1` sub-app over the wired gateway state. `adminApp` is the SAME
 * `createAdminApp(state)` instance `server.ts` mounts at `/admin` — re-mounted here
 * under `/v1/admin` so `/v1/admin/api/*` is a working alias of `/admin/api/*`.
 */
export function createV1App(state: GatewayState, adminApp: Hono): Hono {
  const v1 = new Hono();

  // A read-only GrantService instance to project the pending list for status counts.
  const pendingResolver = new GrantService(state, defaultAuthorizer());

  // ── MANAGEMENT-KEY GUARD — same gate as `/admin/api/*` mutating routes ───────
  const requireManagementKey: MiddlewareHandler = async (c, next) => {
    const presented =
      c.req.header("x-plexus-connection-key") ?? c.req.header("X-Plexus-Connection-Key");
    if (!presented || !state.connectionKey.verify(presented)) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "this v1 route requires a verified management connection-key (X-Plexus-Connection-Key)",
          },
        },
        401,
      );
    }
    await next();
  };

  // The MUTATING + push routes require the management key (the SSE stream re-emits
  // pending/audit — management-sensitive — so it is gated like the mutating routes).
  v1.put("/config", requireManagementKey);
  v1.post("/connection-key/rotate", requireManagementKey);
  v1.get("/events", requireManagementKey);

  // ── GET /v1/health — the supervisor liveness probe (trivial, loopback-only) ──
  v1.get("/health", (c) => c.json({ ok: true }));

  // ── GET /v1/status — thin lifecycle/status snapshot composed from the stores ──
  v1.get("/status", (c) => {
    const port = state.boundPort ?? state.config.port;
    const pending = pendingResolver.listPending();
    const grantsAll = state.grants.all();
    return c.json({
      lraVersion: LRA_VERSION,
      protocolVersion: PLEXUS_PROTOCOL,
      runtimeVersion: PLEXUS_VERSION,
      pid: process.pid,
      port,
      ...(state.config.instance ? { instance: state.config.instance } : {}),
      uptime: uptimeMs(),
      counts: {
        sources: state.managedSources.list().length,
        capabilities: state.capabilities.all().length,
        grants: grantsAll.length,
        pending: pending.length,
        sessions: state.sessions.all().length,
      },
    });
  });

  // ── GET /v1/config — read the auth-config (token lifetime, trust windows, …) ──
  v1.get("/config", (c) => {
    const auth = state.config.auth;
    return c.json({
      tokenLifetimeMs: auth.tokenLifetimeMs,
      tokenLifetimeBounds: { minMs: TOKEN_LIFETIME_MIN_MS, maxMs: TOKEN_LIFETIME_MAX_MS },
      maxTrustWindowMs: auth.maxTrustWindowMs,
      allowUntilRevoked: auth.allowUntilRevoked,
      defaultTrustWindows: auth.defaultTrustWindows,
    });
  });

  // ── PUT /v1/config — write the auth-config fields (validated + clamped) ──────
  // Persists the supplied fields to `~/.plexus/auth-config.json` (merged + clamped
  // by `writeAuthConfig`), then returns the resulting effective config. The change
  // applies to NEW state on next construction; the persisted file is authoritative.
  v1.put("/config", async (c) => {
    let body: AuthConfigPatch;
    try {
      body = (await c.req.json()) as AuthConfigPatch;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: { code: "internal_error", message: "a JSON object body is required" } }, 400);
    }
    const effective = writeAuthConfig(body);
    return c.json({
      ok: true,
      config: {
        tokenLifetimeMs: effective.tokenLifetimeMs,
        maxTrustWindowMs: effective.maxTrustWindowMs,
        allowUntilRevoked: effective.allowUntilRevoked,
        defaultTrustWindows: effective.defaultTrustWindows,
      },
    });
  });

  // ── POST /v1/connection-key/rotate — rotate the key (drops sessions/tokens) ──
  // `connectionKey.rotate()` bumps the epoch + fires the registered rotation hook,
  // which invalidates standing sessions under the old key + revokes their jtis
  // (already wired in state.ts). Returns the new key (loopback, management-gated).
  v1.post("/connection-key/rotate", (c) => {
    const next = state.connectionKey.rotate();
    return c.json({ ok: true, connectionKey: next, epoch: state.connectionKey.epoch() });
  });

  // ── GET /v1/events — the MANAGEMENT SSE stream (REDESIGN-ARCHITECTURE §2.3) ──
  // A mirror of the agent `GET /events`, but a MANAGEMENT audience: it re-emits the
  // management-only variants (`pending_added`/`pending_resolved`/`audit_appended`)
  // AND re-broadcasts the existing `manifest_changed`/`token_revoked`/`source_status`
  // (a tray/dashboard wants those too). `grant_resolved` is the agent-facing twin of
  // `pending_resolved`; we re-emit it as well so a management client sees the token.
  v1.get("/events", (c) => {
    const stream = new ReadableStream({
      start: (controller) => {
        const enc = new TextEncoder();
        const send = (event: { type: string }) => {
          try {
            controller.enqueue(enc.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            /* stream closed */
          }
        };
        // Initial comment to open the stream (same pattern as the agent stream).
        controller.enqueue(enc.encode(`: plexus management event stream\n\n`));
        const unsubscribe = state.events.subscribe(send);
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // ── /v1/admin/api/* — alias the existing admin handlers under /v1 ────────────
  // The SAME `createAdminApp(state)` instance mounted at `/admin`; re-mounting it
  // here makes `/v1/admin/api/*` a working alias of `/admin/api/*` (the existing
  // CLI + web admin keep using `/admin/api/*`; new clients may use the v1 path).
  v1.route("/admin", adminApp);

  return v1;
}
