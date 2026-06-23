/**
 * Local management client — the same-origin admin surface (task t11).
 *
 * The gateway enforces a Host/Origin guard (loopback only, §5b). A separate Vite
 * dev-server origin would be REJECTED as cross-origin, so the gateway SERVES the
 * built management client as static assets SAME-ORIGIN under `/admin`, and that
 * UI calls a same-origin admin API under `/admin/api/*`. Because the admin API
 * runs inside the gateway process it is the TRUSTED local management surface: it
 * reads the connection-key directly from `~/.plexus/` (via `state.connectionKey`)
 * and drives the same `GrantService` the protocol endpoints use — so the browser
 * UI never has to paste a connection-key for the management actions.
 *
 * This route is registered in `server.ts` AFTER the Host/Origin guard
 * (`app.use("*", hostOriginGuard)`), so every admin request is still loopback-only
 * + same-origin guarded. A cross-origin request to `/admin/*` is rejected with
 * `host_forbidden` exactly like any other endpoint.
 *
 * The five management functions:
 *   1. List capabilities      → GET  /admin/api/capabilities
 *   2. Set access + issue tok  → POST /admin/api/grants
 *   3. Install cc-master       → POST /admin/api/install-cc-master
 *   4. Issue / revoke / list   → POST /admin/api/grants, POST /admin/api/revoke, GET /admin/api/tokens
 *   5. View audit              → GET  /admin/api/audit
 */

import { Hono } from "hono";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CapabilityEntry,
  GrantRequest,
  GatewayInfo,
  AuditEvent,
  GrantResponse,
  RevokeResponse,
  SourceInstallResult,
} from "../protocol/index.ts";
import type { GatewayState } from "./state.ts";
import { GrantService } from "./grant-service.ts";
import { AutoApproveAuthorizer, defaultAuthorizer } from "../auth/index.ts";
import { gatewayInfo } from "./well-known.ts";
import type { Session } from "./sessions.ts";
import { plexusHome } from "./paths.ts";

/** The directory the built management client lands in (Vite `outDir`). */
const CLIENT_DIST = fileURLToPath(new URL("../../management-client/dist", import.meta.url));

/** Identity used for grants issued by the local management user. */
const ADMIN_AGENT_ID = "plexus-admin";

/** Minimal content-type map for the static asset server (no external dep). */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot) : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Read every audit JSONL line under `~/.plexus/audit/`, newest first. */
function readAudit(limit: number): AuditEvent[] {
  const dir = join(plexusHome(), "audit");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const events: AuditEvent[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as AuditEvent);
      } catch {
        /* skip a torn/partial line */
      }
    }
  }
  // Newest first; cap to `limit`.
  events.reverse();
  return events.slice(0, limit);
}

/** A live (non-revoked, unexpired) token, surfaced to the management UI. */
interface ActiveTokenView {
  jti: string;
  sessionId: string;
  agentId?: string;
  scopes: { id: string; verbs: string[]; synthesizedFor?: string }[];
  expiresAt: string;
}

/**
 * Build the `/admin` sub-app over the wired gateway state. Serves the SPA + the
 * same-origin admin API. Pure construction; mounted in `server.ts`.
 */
export function createAdminApp(state: GatewayState): Hono {
  const admin = new Hono();
  // The management UI IS the trusted human surface (connection-key authenticated,
  // same-origin, loopback-only). When the USER clicks "Issue scoped token" in the
  // ledger they ARE the human approval, so the admin's own grant issuance
  // auto-approves (no self-pending) — pending is for the AGENT's `PUT /grants`.
  const grants = new GrantService(state, new AutoApproveAuthorizer());
  // The pending APPROVE/DENY channel reads the SHARED pending store (keyed by state),
  // so it resolves the agent-side pending grants + registrations. The authorizer here
  // is irrelevant to approve/deny (it only renders policy decisions on new grants).
  const pendingResolver = new GrantService(state, defaultAuthorizer());

  // A single long-lived management session bootstrapped under the live connection
  // key — the local user IS the trusted management surface, so the admin API does
  // the handshake on the user's behalf rather than asking them to paste the key.
  let adminSession: Session | null = null;
  function session(): Session {
    if (adminSession && state.sessions.liveness(adminSession.id).live) return adminSession;
    adminSession = state.sessions.open(state.connectionKey.current(), {
      name: "plexus-management-client",
      agentId: ADMIN_AGENT_ID,
    });
    return adminSession;
  }

  // ── connection-key (the trusted local surface may surface it for paste) ──────
  admin.get("/api/connection-key", (c) => {
    return c.json({ connectionKey: state.connectionKey.current() });
  });

  // ── 1. LIST CAPABILITIES — full self-describe entries + gateway info ─────────
  admin.get("/api/capabilities", (c) => {
    const info: GatewayInfo = gatewayInfo(state.config);
    const entries: CapabilityEntry[] = state.capabilities.all();
    return c.json({ gateway: info, revision: state.capabilities.revision(), entries });
  });

  // ── 2/4. SET ACCESS + ISSUE TOKEN — map expose/access to grant verbs ─────────
  admin.put("/api/grants", async (c) => {
    let body: { grants: GrantRequest["grants"] };
    try {
      body = (await c.req.json()) as { grants: GrantRequest["grants"] };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!body?.grants || typeof body.grants !== "object") {
      return c.json(
        { error: { code: "internal_error", message: "`grants` (id → decision) is required" } },
        400,
      );
    }
    const sess = session();
    const result: GrantResponse = await grants.grant({ sessionId: sess.id, grants: body.grants }, sess);
    return c.json(result);
  });

  // ── 4. LIST ACTIVE TOKENS — from tracked jtis minus revoked ──────────────────
  admin.get("/api/tokens", (c) => {
    const active: ActiveTokenView[] = [];
    for (const sess of state.sessions.all()) {
      if (!state.sessions.liveness(sess.id).live) continue;
      const agentId = sess.agentId ?? sess.client?.agentId;
      for (const jti of sess.issuedJtis) {
        if (state.revocation.isRevoked(jti)) continue;
        active.push({
          jti,
          sessionId: sess.id,
          ...(agentId ? { agentId } : {}),
          // The token's scopes live in the JWT; the management UI cares about the
          // grants behind them, surfaced from the persisted grant store per agent.
          scopes: agentId
            ? state.grants.forAgent(agentId).map((g) => ({
                id: g.capabilityId,
                verbs: g.verbs,
                ...(g.synthesizedFor ? { synthesizedFor: g.synthesizedFor } : {}),
              }))
            : [],
          expiresAt: sess.expiresAt,
        });
      }
    }
    return c.json({ tokens: active });
  });

  // ── 4. REVOKE — by jti (the user's "revoke now") ─────────────────────────────
  admin.post("/api/revoke", async (c) => {
    let body: { jti?: string; agentId?: string; capabilityId?: string; reason?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!body.jti && !(body.agentId && body.capabilityId)) {
      return c.json(
        {
          error: {
            code: "internal_error",
            message: "revoke requires `jti` or both `agentId`+`capabilityId`",
          },
        },
        400,
      );
    }
    const result: RevokeResponse = await grants.revoke({
      ...(body.jti ? { jti: body.jti } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(body.capabilityId ? { capabilityId: body.capabilityId } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return c.json(result);
  });

  // ── PENDING APPROVALS — the human approve/deny channel (m4sec-auth linchpin) ──
  // The management session (connection-key authenticated, same-origin) is the human
  // surface that resolves pending GRANTS + EXTENSION REGISTRATIONS an agent requested.
  admin.get("/api/pending", (c) => {
    return c.json({ pending: pendingResolver.listPending() });
  });

  admin.post("/api/pending/:id", async (c) => {
    const id = c.req.param("id");
    let body: { action?: "approve" | "deny"; reason?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      body = {};
    }
    const action = body.action;
    if (action !== "approve" && action !== "deny") {
      return c.json(
        { error: { code: "internal_error", message: "body.action must be 'approve' or 'deny'" } },
        400,
      );
    }
    const result =
      action === "approve"
        ? await pendingResolver.approve(id)
        : await pendingResolver.deny(id, body.reason);
    if (!result.ok && !result.kind) {
      return c.json(
        { error: { code: "unknown_capability", message: `no pending item '${id}' (or already resolved)` } },
        404,
      );
    }
    // After resolving a register, the capability ledger changed — the UI re-fetches.
    return c.json({ ok: result.ok, action, kind: result.kind, ...(result.reason ? { reason: result.reason } : {}) });
  });

  // ── 3. OPTIONAL-INSTALL cc-master — first-party audited install action ───────
  admin.post("/api/install-cc-master", async (c) => {
    const module = state.sources.get("cc-master");
    if (!module) {
      return c.json(
        {
          ok: false,
          available: false,
          reason: "cc-master source is not registered in this build (t8 provides it).",
        },
        200,
      );
    }
    const { getPlatformServices } = await import("../platform/index.ts");
    const platform = getPlatformServices();
    let source;
    try {
      source = module.createSource(platform);
    } catch {
      source = undefined;
    }
    const install = (source as { install?: Function } | undefined)?.install;
    if (typeof install !== "function") {
      return c.json(
        {
          ok: false,
          available: false,
          reason: "cc-master source exposes no install() action.",
        },
        200,
      );
    }
    try {
      const result: SourceInstallResult = await install.call(source, {
        audit: (e: Parameters<GatewayState["audit"]["write"]>[0]) => state.audit.write(e),
        platform,
      });
      // After install, re-scan so the workflow + members surface in the manifest.
      try {
        await state.capabilities.refresh();
      } catch {
        /* refresh best-effort */
      }
      return c.json({ ...result, available: true });
    } catch (e) {
      return c.json(
        { ok: false, available: true, reason: e instanceof Error ? e.message : String(e) },
        200,
      );
    }
  });

  // ── 5. VIEW AUDIT — the handshake/grant/token/invoke/revoke trail ────────────
  admin.get("/api/audit", (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(Math.max(Number.parseInt(limitRaw, 10) || 200, 1), 1000) : 200;
    return c.json({ events: readAudit(limit) });
  });

  // ── STATIC SPA — serve the built management client same-origin ───────────────
  // GET /admin and any non-API path under /admin/* serve the SPA (index.html for
  // unknown routes so the single-page panel handles its own view state).
  admin.get("/*", (c) => {
    if (!existsSync(CLIENT_DIST)) {
      return c.html(NOT_BUILT_HTML, 200);
    }
    // The mounted base is `/admin`; the matched path here is relative to it.
    const rel = c.req.path.replace(/^\/admin/, "").replace(/^\/+/, "");
    const candidate = rel === "" ? "index.html" : rel;
    const full = normalize(join(CLIENT_DIST, candidate));
    // Path-traversal guard: never serve outside the dist dir.
    if (!full.startsWith(CLIENT_DIST)) {
      return c.text("forbidden", 403);
    }
    if (existsSync(full) && statSync(full).isFile()) {
      const data = readFileSync(full);
      return c.body(data as unknown as ArrayBuffer, 200, { "Content-Type": contentType(full) });
    }
    // SPA fallback → index.html.
    const indexPath = join(CLIENT_DIST, "index.html");
    if (existsSync(indexPath)) {
      return c.html(readFileSync(indexPath, "utf8"), 200);
    }
    return c.html(NOT_BUILT_HTML, 200);
  });

  return admin;
}

/** Shown when the client hasn't been built yet (graceful degrade). */
const NOT_BUILT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Plexus — Management Client</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a">
<h1>Plexus management client not built</h1>
<p>The admin API is live, but the React client has not been built. From the repo root run:</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:6px">cd management-client &amp;&amp; bun install &amp;&amp; bun run build</pre>
<p>Then reload this page. The same-origin admin API is available at <code>/admin/api/*</code>.</p>
</body></html>`;
