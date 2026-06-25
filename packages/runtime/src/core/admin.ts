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
 * ── AUTH BOUNDARY (msrc-rev security gate) ───────────────────────────────────
 * The loopback Host guard alone is NOT a sufficient gate for the MUTATING admin
 * routes: ANY local process can send `Host: 127.0.0.1`, so loopback-only would let
 * a non-management local caller add a write-capable source (cli exec / exfil
 * redirect) or write a secret with no key + no human. So every state-changing +
 * secret + grant-mutating `/admin/api/*` route additionally requires a VERIFIED
 * connection-key (`X-Plexus-Connection-Key`, checked via `state.connectionKey`).
 * The management CLIENT obtains the key OUT OF BAND — NEVER over HTTP (F2): the
 * desktop app injects it via Electron IPC (it read `~/.plexus/connection-key`), or
 * a human pastes the key the runtime printed to its launching terminal. There is
 * deliberately NO `GET /admin/api/connection-key` route: an untrusted agent speaks
 * only HTTP over loopback, so any HTTP route that returns (or hints at) the key
 * would let the agent escalate to the management surface. The `plexus source` CLI
 * reads the key file directly. Read-only GETs (capabilities/manifest/tokens/audit/
 * sources LIST/detect) stay loopback-only — they DISCLOSE local discovery state but
 * cannot change authority and never serialize the connection-key — DOCUMENTED as
 * the read boundary.
 *
 * The five management functions:
 *   1. List capabilities      → GET  /admin/api/capabilities
 *   2. Set access + issue tok  → POST /admin/api/grants
 *   3. cc-master launch config → GET/POST /admin/api/cc-master/config (loadCcMaster gate)
 *   4. Issue / revoke / list   → POST /admin/api/grants, POST /admin/api/revoke, GET /admin/api/tokens
 *   5. View audit              → GET  /admin/api/audit
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CapabilityEntry,
  ExtensionManifest,
  GrantRequest,
  GatewayInfo,
  AuditEvent,
  GrantResponse,
  GrantsListResponse,
  Provenance,
  RevokeResponse,
  StandingGrant,
  TrustWindow,
} from "@plexus/protocol";
import { provenanceFor } from "./capability-registry.ts";
import { buildRegisterSurface } from "./register-surface.ts";
import type { GatewayState } from "./state.ts";
import { GrantService } from "./grant-service.ts";
import type { CreateBundleInput } from "./grant-service.ts";
import { AutoApproveAuthorizer, defaultAuthorizer } from "../auth/index.ts";
import { gatewayInfo } from "./well-known.ts";
import type { Session } from "./sessions.ts";
import { plexusHome, ensureDir } from "./paths.ts";
import type { ConfiguredSource } from "../sources/config/types.ts";
import { connectorCatalog } from "../sources/config/catalog.ts";
import { isSafeSecretName } from "../sources/extension.ts";
import { readCcMasterConfig, writeCcMasterConfig } from "../sources/cc-master/config.ts";

/** The directory the built web-admin SPA lands in (Vite `outDir`). */
const CLIENT_DIST = fileURLToPath(new URL("../../../web-admin/dist", import.meta.url));

/** The repo-root authoring guide served at GET /admin/api/extensions/authoring-guide. */
const AUTHORING_GUIDE_PATH = fileURLToPath(
  new URL("../../../../docs/extension-authoring.md", import.meta.url),
);

/** Minimal fallback when the guide file isn't reachable (graceful degrade). */
const AUTHORING_GUIDE_FALLBACK = `# Authoring a Plexus extension

An extension is a runtime-registered connector declared by an ExtensionManifest
(manifest:"plexus-extension/0.1") with { source, label, transport, capabilities[] }.
Preview a manifest at POST /admin/api/extensions/preview (no commit), install it at
POST /admin/api/extensions, list at GET /admin/api/extensions, remove at
DELETE /admin/api/extensions/:source. See docs/extension-authoring.md.`;

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
  scopes: {
    id: string;
    verbs: string[];
    synthesizedFor?: string;
    /** Trust-window ceiling of the backing grant (ADR-018). */
    grantExpiresAt?: string;
    /** The trust-window the backing grant was approved under (ADR-018). */
    trustWindow?: TrustWindow;
    /** Source-class of the backing capability (ADR-018). */
    provenance?: Provenance;
  }[];
  expiresAt: string;
}

/** A configured managed source + its derived LIVE status (for the Sources panel). */
interface SourceView extends ConfiguredSource {
  /** Is this source currently registered in the live capability registry? */
  live: boolean;
  /** How many capability ids this source contributes to the live registry. */
  liveCapabilityCount: number;
}

/**
 * Join the persisted `ConfiguredSource` desired-state with the LIVE registry: a
 * source is "live" when at least one of its capabilities is registered (the
 * registry indexes entries by `source` = the SourceId). Disabled-but-persisted
 * sources show `live:false`.
 */
function sourceViews(state: GatewayState): SourceView[] {
  const liveCounts = new Map<string, number>();
  for (const entry of state.capabilities.all()) {
    liveCounts.set(entry.source, (liveCounts.get(entry.source) ?? 0) + 1);
  }
  return state.managedSources.list().map((cfg) => {
    const liveCapabilityCount = liveCounts.get(cfg.id) ?? 0;
    return { ...cfg, live: liveCapabilityCount > 0, liveCapabilityCount };
  });
}

/** Write a named secret value to `~/.plexus/secrets/<name>` with 0600 perms. */
function writeSecret(name: string, value: string): void {
  const dir = ensureDir(join(plexusHome(), "secrets"));
  const file = join(dir, name);
  // Owner-only file: write then chmod 600 (the value is handed to a transport at
  // dispatch via `resolveSecret`; it never leaves this store, never read back here).
  writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort tighten (e.g. umask-relaxed create) */
  }
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

  // Resolve a capability's 3-class source-class (ADR-018) for the Grants/Tokens views:
  // first-party (reserved id), managed (user-added via the admin UI), else extension.
  const managedSourceIds = (): ReadonlySet<string> =>
    new Set(state.managedSources.list().map((s) => s.id));
  const provenanceOfCapability = (capabilityId: string): Provenance => {
    const entry = state.capabilities.get(capabilityId);
    if (entry) {
      // Prefer the registry's STAMPED posture (single source of truth for the
      // managed-source provider) so Tokens/Grants views agree with the manifest.
      const stamped =
        typeof state.capabilities.stampPosture === "function"
          ? state.capabilities.stampPosture(entry)
          : entry;
      if (stamped.provenance) return stamped.provenance;
    }
    const source = entry?.source ?? capabilityId.split(".").slice(0, -2).join(".") ?? capabilityId;
    return provenanceFor(source, managedSourceIds());
  };

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

  // ── MANAGEMENT-KEY GUARD — required on every MUTATING admin route ────────────
  // The Host/Origin guard proves "loopback", not "the trusted management client".
  // A verified connection-key (obtained out-of-band by the real client — desktop
  // IPC injection or human paste, NEVER over HTTP; the CLI reads the key file) is
  // what distinguishes the management surface from an arbitrary local process — an
  // agent only speaks HTTP, so it can never present it. Applied below to all
  // state-changing + secret + grant
  // routes; read-only GETs stay loopback-only (see header doc).
  const requireManagementKey: MiddlewareHandler = async (c, next) => {
    const presented =
      c.req.header("x-plexus-connection-key") ?? c.req.header("X-Plexus-Connection-Key");
    if (!presented || !state.connectionKey.verify(presented)) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "this admin route requires a verified management connection-key (X-Plexus-Connection-Key)",
          },
        },
        401,
      );
    }
    await next();
  };

  // Gate the MUTATING + secret + grant-mutating routes by method+prefix. Hono runs a
  // `use` matcher before the handler; we scope to the exact paths that change
  // authority/state so read-only GETs are untouched (the SPA + LIST/audit stay open).
  admin.get("/api/grants", requireManagementKey);
  admin.post("/api/grants", requireManagementKey);
  admin.put("/api/grants", requireManagementKey);
  admin.post("/api/revoke", requireManagementKey);
  admin.get("/api/bundles", requireManagementKey);
  admin.post("/api/bundles", requireManagementKey);
  admin.post("/api/cc-master/config", requireManagementKey);
  admin.post("/api/pending/:id", requireManagementKey);
  admin.post("/api/sources", requireManagementKey);
  admin.post("/api/sources/:id/enable", requireManagementKey);
  admin.post("/api/sources/:id/disable", requireManagementKey);
  admin.post("/api/sources/:id/reconfigure", requireManagementKey);
  admin.delete("/api/sources/:id", requireManagementKey);
  admin.post("/api/secrets/:name", requireManagementKey);
  // Extension preview/create/list/remove — the management surface over the
  // runtime-registration primitives (FEAT-CREATE-EXTENSION). The list + preview
  // are mgmt-key gated too: they DISCLOSE/PROJECT manifest authority, and the local
  // user holding the connection-key IS the trusted human approver.
  admin.get("/api/extensions", requireManagementKey);
  admin.post("/api/extensions", requireManagementKey);
  admin.post("/api/extensions/preview", requireManagementKey);
  admin.delete("/api/extensions/:source", requireManagementKey);

  // ── connection-key — DELIBERATELY NOT AN HTTP ROUTE (F2) ─────────────────────
  // There is NO `GET /api/connection-key`. The management connection-key gates the
  // mutating admin surface, and an untrusted AGENT only ever speaks HTTP over
  // loopback — so handing the key out over ANY HTTP route (even a "loopback-only"
  // one) lets an agent fetch it and escalate to the management surface. The key
  // must NEVER touch an agent-reachable surface, nor may any payload hint that such
  // a management key exists. The trusted admin world obtains it OUT OF BAND instead:
  //   - the desktop app reads `~/.plexus/connection-key` and injects it into the
  //     admin page via Electron IPC (see packages/desktop/main/{main,preload}.js);
  //   - the runtime prints it to the launching terminal at startup (bin/plexus) for
  //     a human to paste once in a browser/dev session.
  // The web-admin client resolves the key in that order (desktop inject → cached →
  // human paste) — see packages/web-admin/src/api.ts `managementKey()`. No fetch.

  // ── 1. LIST CAPABILITIES — full self-describe entries + gateway info ─────────
  admin.get("/api/capabilities", (c) => {
    const info: GatewayInfo = gatewayInfo(state.config);
    const entries: CapabilityEntry[] = state.capabilities.all();
    return c.json({ gateway: info, revision: state.capabilities.revision(), entries });
  });

  // ── 2/4. GRANT ACCESS — persist a standing grant under a REAL agent (decoy fix) ─
  // ADR-018: an admin "Grant access" must target a REAL agentId so the agent's next
  // request hits `hasPriorApproval`. When `agentId` is supplied the grant persists
  // under THAT agent (a fresh management session opened as that agent); the chosen
  // `trustWindow` (authoritative) is threaded onto every decision in the body. With
  // no `agentId` it falls back to the management `plexus-admin` session (legacy).
  admin.put("/api/grants", async (c) => {
    let body: { grants: GrantRequest["grants"]; agentId?: string; trustWindow?: TrustWindow };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!body?.grants || typeof body.grants !== "object") {
      return c.json(
        { error: { code: "internal_error", message: "`grants` (id → decision) is required" } },
        400,
      );
    }
    // Thread an admin-chosen (authoritative) trust-window onto each decision so the
    // grant persists under the picked window, not the per-class default.
    let grantsBody: GrantRequest["grants"] = body.grants;
    if (body.trustWindow) {
      const tw = body.trustWindow;
      grantsBody = {};
      for (const [id, raw] of Object.entries(body.grants)) {
        const dec = raw === "allow" ? { decision: "allow" as const } : raw === "deny" ? { decision: "deny" as const } : raw;
        grantsBody[id] = dec.decision === "allow" ? { ...dec, trustWindow: tw } : dec;
      }
    }
    // Target a REAL agent when supplied (decoy fix) — open a management session AS that
    // agent so the persisted grant is keyed to it. Else the legacy plexus-admin session.
    const sess =
      body.agentId && body.agentId !== ADMIN_AGENT_ID
        ? state.sessions.open(state.connectionKey.current(), {
            name: "plexus-management-client",
            agentId: body.agentId,
          })
        : session();
    const result: GrantResponse = await grants.grant({ sessionId: sess.id, grants: grantsBody }, sess);
    return c.json(result);
  });

  // ── GRANTS LEDGER (ADR-018) — every standing grant projected for the UI ──────
  // Management-key gated (read of durable trust state). Rows carry agent · capability ·
  // verbs · source-class · trust-window · expiry · standing, with per-grant Revoke
  // wired to POST /api/revoke (agentId+capabilityId).
  admin.get("/api/grants", (c) => {
    const all: StandingGrant[] = grants.listGrants();
    const res: GrantsListResponse = { grants: all };
    return c.json(res);
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
          // Each row carries BOTH windows (token expiresAt above + grantExpiresAt /
          // trustWindow here) + the source-class so the UI stops conflating them.
          scopes: agentId
            ? state.grants.forAgent(agentId).map((g) => ({
                id: g.capabilityId,
                verbs: g.verbs,
                ...(g.synthesizedFor ? { synthesizedFor: g.synthesizedFor } : {}),
                grantExpiresAt: g.expiresAt,
                ...(g.trustWindow ? { trustWindow: g.trustWindow } : {}),
                provenance: provenanceOfCapability(g.capabilityId),
              }))
            : [],
          expiresAt: sess.expiresAt,
        });
      }
    }
    return c.json({ tokens: active });
  });

  // ── 4. REVOKE — by jti, by (agentId, capabilityId), or by bundleId (AUTHZ-UX §2.N3) ──
  admin.post("/api/revoke", async (c) => {
    let body: { jti?: string; agentId?: string; capabilityId?: string; bundleId?: string; reason?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!body.jti && !(body.agentId && body.capabilityId) && !body.bundleId) {
      return c.json(
        {
          error: {
            code: "internal_error",
            message: "revoke requires `jti`, both `agentId`+`capabilityId`, or `bundleId`",
          },
        },
        400,
      );
    }
    // Revoke-by-bundle: remove every member grant + revoke their tokens + drop context.
    if (body.bundleId) {
      const result: RevokeResponse = await grants.revokeBundle(body.bundleId, body.reason);
      return c.json(result);
    }
    const result: RevokeResponse = await grants.revoke({
      ...(body.jti ? { jti: body.jti } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(body.capabilityId ? { capabilityId: body.capabilityId } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return c.json(result);
  });

  // ── TASK BUNDLES (AUTHZ-UX §2.N3 / D4) — admin one-shot create + grouped list ─────
  // The management UI / CLI is the human approver (auto-approve, same as `POST /api/grants`):
  // ONE create = the whole task authorized. Members persist as normal grants tagged bundleId.
  admin.post("/api/bundles", async (c) => {
    let body: CreateBundleInput;
    try {
      body = (await c.req.json()) as CreateBundleInput;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!body?.name || !body?.agentId || !Array.isArray(body.grants)) {
      return c.json(
        { error: { code: "internal_error", message: "`name`, `agentId`, and `grants[]` are required" } },
        400,
      );
    }
    const result = await grants.createBundle(body);
    if (!result.ok) {
      return c.json({ error: { code: "internal_error", message: result.reason } }, 422);
    }
    return c.json(result.bundle);
  });

  admin.get("/api/bundles", (c) => {
    return c.json({ bundles: grants.listBundles() });
  });

  // ── PENDING APPROVALS — the human approve/deny channel (m4sec-auth linchpin) ──
  // The management session (connection-key authenticated, same-origin) is the human
  // surface that resolves pending GRANTS + EXTENSION REGISTRATIONS an agent requested.
  admin.get("/api/pending", (c) => {
    return c.json({ pending: pendingResolver.listPending() });
  });

  admin.post("/api/pending/:id", async (c) => {
    const id = c.req.param("id");
    let body: { action?: "approve" | "deny"; reason?: string; trustWindow?: TrustWindow; agentId?: string };
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
    // ADR-018: approve carries the human's authoritative trust-window + an optional
    // target agentId (decoy fix — persist under the REAL agent, not plexus-admin).
    const result =
      action === "approve"
        ? await pendingResolver.approve(id, {
            ...(body.trustWindow ? { trustWindow: body.trustWindow } : {}),
            ...(body.agentId ? { agentId: body.agentId } : {}),
          })
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

  // ── 3. cc-master LAUNCH-PROFILE CONFIG — the loadCcMaster gate ────────────────
  // The CONNECTOR is Claude Code (a first-party app Plexus launches headless with the
  // EMBEDDED cc-master plugin — never touching ~/.claude). Its single config is the
  // `loadCcMaster` toggle, which GATES the orchestration capabilities. GET reads the
  // persisted gate; POST writes it (to ~/.plexus/cc-master.json) + re-scans so the
  // capability ledger re-gates. No ~/.claude write happens anywhere.
  admin.get("/api/cc-master/config", (c) => {
    return c.json({ config: readCcMasterConfig() });
  });

  admin.post("/api/cc-master/config", async (c) => {
    let body: { loadCcMaster?: unknown };
    try {
      body = (await c.req.json()) as { loadCcMaster?: unknown };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (typeof body.loadCcMaster !== "boolean") {
      return c.json(
        { error: { code: "internal_error", message: "`loadCcMaster` (boolean) is required" } },
        400,
      );
    }
    let config;
    try {
      config = writeCcMasterConfig(body.loadCcMaster);
    } catch (e) {
      return c.json(
        { error: { code: "internal_error", message: e instanceof Error ? e.message : String(e) } },
        500,
      );
    }
    // Re-scan so the gated capability set re-publishes (on ⇒ orchestration; off ⇒ base).
    try {
      await state.capabilities.refresh();
    } catch {
      /* refresh best-effort */
    }
    return c.json({ ok: true, config });
  });

  // ── 5. VIEW AUDIT — the handshake/grant/token/invoke/revoke trail ────────────
  admin.get("/api/audit", (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(Math.max(Number.parseInt(limitRaw, 10) || 200, 1), 1000) : 200;
    return c.json({ events: readAudit(limit) });
  });

  // ── MANAGED SOURCES (msrc-t2) — the trusted same-origin management surface ────
  // These routes are connection-key/management-session authed + same-origin guarded
  // exactly like every other /admin/api/* route (a cross-origin/non-loopback request
  // is rejected by the Host/Origin guard before reaching here). The USER driving the
  // admin UI IS the trusted human, so adding a write-capable source here AUTO-APPROVES
  // (approvedByHuman:true) — unlike the agent/wire `POST /extensions` path, which
  // still PENDS for a human decision. All delegate to `state.managedSources`.

  // LIST — configured sources + their live/enabled status (+ live capability count).
  admin.get("/api/sources", (c) => {
    return c.json({ sources: sourceViews(state), revision: state.capabilities.revision() });
  });

  // DETECT — reachable/installed sources the user could add (Task 4 fills detectors).
  // Best-effort: a detector probe failing must NEVER 500 the management UI — it just
  // means "nothing detected" (the user can still add a source manually via the form).
  admin.get("/api/sources/detect", async (c) => {
    try {
      const detected = await state.managedSources.detect();
      return c.json({ detected });
    } catch {
      return c.json({ detected: [] });
    }
  });

  // CONNECTORS — the catalog of "what Plexus can connect to" (连接器 / connector TYPES).
  // Read route, gated the SAME way as GET /api/sources (loopback-only; the SPA attaches
  // the connection-key on every read anyway). Pure advisory descriptors: managed kinds
  // (wireable → dynamic form) + first-party builtins (informational). No secret values.
  admin.get("/api/connectors", (c) => {
    return c.json({ connectors: connectorCatalog(), revision: state.capabilities.revision() });
  });

  // ADD — register LIVE + persist a ConfiguredSource. The admin path is the trusted
  // human, so approvedByHuman:true (no pend — that's the agent/wire path only).
  admin.post("/api/sources", async (c) => {
    let cfg: ConfiguredSource;
    try {
      cfg = (await c.req.json()) as ConfiguredSource;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!cfg || typeof cfg !== "object" || typeof cfg.kind !== "string" || !cfg.kind) {
      return c.json({ error: { code: "internal_error", message: "`kind` is required" } }, 400);
    }
    const result = await state.managedSources.add(cfg, { approvedByHuman: true });
    return c.json(result, result.ok ? 200 : 422);
  });

  // ENABLE — re-register + flip enabled:true + persist (trusted human → auto-approve).
  admin.post("/api/sources/:id/enable", async (c) => {
    const result = await state.managedSources.enable(c.req.param("id"), { approvedByHuman: true });
    return c.json(result, result.ok ? 200 : 422);
  });

  // DISABLE — unregister + persist enabled:false (config retained).
  admin.post("/api/sources/:id/disable", async (c) => {
    await state.managedSources.disable(c.req.param("id"));
    return c.json({ ok: true });
  });

  // RECONFIGURE — hot-swap the module for the same id + persist (trusted human).
  admin.post("/api/sources/:id/reconfigure", async (c) => {
    let patch: Partial<ConfiguredSource>;
    try {
      patch = (await c.req.json()) as Partial<ConfiguredSource>;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    const result = await state.managedSources.reconfigure(c.req.param("id"), patch, {
      approvedByHuman: true,
    });
    return c.json(result, result.ok ? 200 : 422);
  });

  // REMOVE — unregister + drop from config + purge grants for the removed ids.
  admin.delete("/api/sources/:id", async (c) => {
    await state.managedSources.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── EXTENSIONS — the management surface over runtime registration ────────────
  // FEAT-CREATE-EXTENSION. These wire the EXISTING primitives (validateRegistration,
  // buildRegisterSurface, registerExtension, unregister) into a mgmt-key-gated admin
  // surface so the local human (the connection-key holder) can PREVIEW a manifest
  // (no commit), INSTALL it (the trusted/approved-by-human path → commit + audit
  // source.install), LIST live extensions, and REMOVE one — mirroring the agent/wire
  // POST /extensions + DELETE /extensions/:source, but as the human-approved channel.

  // PREVIEW — validate + project the security surface WITHOUT committing. Pinned
  // response contract (the UI agent builds against this exact shape).
  admin.post("/api/extensions/preview", async (c) => {
    let body: { manifest?: ExtensionManifest };
    try {
      body = (await c.req.json()) as { manifest?: ExtensionManifest };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    const manifest = body?.manifest;
    const registry = state.capabilities;
    if (typeof registry.validateRegistration !== "function") {
      return c.json(
        { error: { code: "internal_error", message: "extension registration is not available in this build" } },
        500,
      );
    }
    if (!manifest || typeof manifest !== "object") {
      return c.json({ ok: true, valid: false, reasons: ["`manifest` is required"], surface: null });
    }

    const verdict = registry.validateRegistration(manifest);
    // Best-effort surface even on invalid (so the UI can still show what was asked for);
    // null only when the projection itself can't run (a structurally broken manifest).
    let surface: ReturnType<typeof buildRegisterSurface> | null = null;
    try {
      surface = buildRegisterSurface(manifest, verdict.crossSourceProvenance ?? {});
    } catch {
      surface = null;
    }
    const projected = surface
      ? {
          source: surface.source,
          label: surface.label,
          capabilities: surface.capabilities.map((cap) => ({
            id: cap.id,
            label: cap.label,
            kind: cap.kind,
            transport: cap.transport,
            verbs: cap.verbs,
          })),
          cliBins: surface.cliBins,
          restHosts: surface.restHosts,
          crossSource: surface.crossSource,
          transportBacked: surface.transportBacked,
        }
      : null;
    return c.json({ ok: true, valid: verdict.ok, reasons: verdict.reasons, surface: projected });
  });

  // CREATE — the human-approved install path: validate → register LIVE (commit) →
  // audit source.install. The local user (connection-key authenticated) IS the
  // approver, so this commits directly (unlike the agent/wire path which pends).
  admin.post("/api/extensions", async (c) => {
    let body: { manifest?: ExtensionManifest };
    try {
      body = (await c.req.json()) as { manifest?: ExtensionManifest };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    const manifest = body?.manifest;
    const registry = state.capabilities;
    if (typeof registry.registerExtension !== "function" || typeof registry.validateRegistration !== "function") {
      return c.json(
        { error: { code: "internal_error", message: "extension registration is not available in this build" } },
        500,
      );
    }
    if (!manifest || typeof manifest !== "object") {
      return c.json(
        { ok: false, source: "", registered: [], revision: registry.revision(), reason: "`manifest` is required" },
        400,
      );
    }

    // VALIDATE (no commit) — reject WITHOUT committing on any reason.
    const verdict = registry.validateRegistration(manifest);
    if (!verdict.ok) {
      await state.audit.write({
        type: "source.install",
        detail: { source: manifest.source, kind: "extension", outcome: "rejected", reason: verdict.reasons.join("; ") },
      });
      return c.json({
        ok: false,
        source: manifest.source ?? "",
        registered: [],
        revision: registry.revision(),
        reason: verdict.reasons.join("; "),
      });
    }

    // COMMIT — registerExtension re-validates internally (nothing slips past). Audit
    // the human-approved install + publish a manifest_changed so connected agents refetch.
    const result = await registry.registerExtension(manifest);
    await state.audit.write({
      type: "source.install",
      detail: {
        source: manifest.source,
        kind: "extension",
        outcome: result.ok ? "committed" : "rejected",
        approvedByHuman: true,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });
    if (result.ok) {
      state.events.publish({ type: "manifest_changed", revision: registry.revision() });
    }
    return c.json(result, result.ok ? 200 : 422);
  });

  // LIST — live registry sources whose provenance is "extension" (not first-party,
  // not a managed source). Grouped by source with its contributed capability ids.
  admin.get("/api/extensions", (c) => {
    const managed = managedSourceIds();
    const bySource = new Map<string, { source: string; label: string; capabilities: string[] }>();
    for (const entry of state.capabilities.all()) {
      if (provenanceFor(entry.source, managed) !== "extension") continue;
      let row = bySource.get(entry.source);
      if (!row) {
        row = { source: entry.source, label: entry.source, capabilities: [] };
        bySource.set(entry.source, row);
      }
      row.capabilities.push(entry.id);
    }
    return c.json({ extensions: [...bySource.values()], revision: state.capabilities.revision() });
  });

  // REMOVE — unregister + purge lingering grants for the removed ids (so a future
  // re-register of the same id must be re-confirmed). Mirrors DELETE /extensions/:source.
  admin.delete("/api/extensions/:source", async (c) => {
    const source = c.req.param("source");
    if (!source) {
      return c.json({ error: { code: "internal_error", message: "missing :source" } }, 400);
    }
    const registry = state.capabilities;
    if (typeof registry.unregister !== "function") {
      return c.json(
        { error: { code: "internal_error", message: "unregister is not available in this build" } },
        500,
      );
    }
    const removed = await registry.unregister(source);
    let purgedGrants = 0;
    for (const id of removed) {
      purgedGrants += state.grants.removeForCapability(id);
    }
    await state.audit.write({
      type: "source.install",
      detail: { source, kind: "extension", outcome: "unregistered", removed: removed.length, purgedGrants },
    });
    if (removed.length > 0) {
      state.events.publish({ type: "manifest_changed", revision: registry.revision() });
    }
    return c.json({ ok: removed.length > 0, source, removed });
  });

  // AUTHORING GUIDE — the markdown contract an external agent fetches to author a
  // valid manifest ("用嘴造扩展" target). Loopback-only (served like the SPA); not
  // mgmt-key gated so an agent drafting in a sibling process can read the contract.
  admin.get("/api/extensions/authoring-guide", (c) => {
    if (existsSync(AUTHORING_GUIDE_PATH)) {
      return c.body(readFileSync(AUTHORING_GUIDE_PATH, "utf8"), 200, {
        "Content-Type": "text/markdown; charset=utf-8",
      });
    }
    return c.body(AUTHORING_GUIDE_FALLBACK, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  // ── SECRETS — WRITE-ONLY store for an API key the UI references by NAME ───────
  // The UI stores e.g. the Obsidian REST token under a name, then the source
  // references it via `secretRef` (name-only in sources.json). This route NEVER
  // returns a secret (no read-back), and the name is validated so it can never
  // escape `~/.plexus/secrets/` (path-traversal / value-smuggling defeated).
  admin.post("/api/secrets/:name", async (c) => {
    const name = c.req.param("name");
    if (!isSafeSecretName(name)) {
      return c.json(
        {
          error: {
            code: "internal_error",
            message: `unsafe secret name "${name}" (must be a plain name, no path traversal)`,
          },
        },
        400,
      );
    }
    let body: { value?: unknown };
    try {
      body = (await c.req.json()) as { value?: unknown };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (typeof body.value !== "string" || body.value.length === 0) {
      return c.json(
        { error: { code: "internal_error", message: "`value` (non-empty string) is required" } },
        400,
      );
    }
    try {
      writeSecret(name, body.value);
    } catch (e) {
      return c.json(
        { error: { code: "internal_error", message: e instanceof Error ? e.message : String(e) } },
        500,
      );
    }
    // Write-only acknowledgement — the value is NEVER echoed back.
    return c.json({ ok: true, name });
  });

  // ── STATIC SPA — serve the built management client same-origin ───────────────
  // GET /admin and any non-API path under /admin/* serve the SPA (index.html for
  // unknown routes so the single-page panel handles its own view state).
  admin.get("/*", (c) => {
    // An unmatched `/admin/api/*` path is a MISSING API route, NOT an SPA view — it
    // must 404, never fall through to index.html. Critical for F2: the removed
    // `GET /api/connection-key` must answer 404, not a 200 SPA page that could mask
    // the deletion. (Also the correct contract for any unknown admin API path.)
    // The path is matched relative to the mount, but the /v1/admin re-mount makes it
    // absolute here — so check both `/api/` and `/admin/api/`.
    const p = c.req.path;
    if (p.includes("/api/")) {
      return c.json(
        { error: { code: "unknown_capability", message: `No admin API route for GET ${p}` } },
        404,
      );
    }
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
<pre style="background:#f4f4f5;padding:1rem;border-radius:6px">cd packages/web-admin &amp;&amp; bun install &amp;&amp; bun run build</pre>
<p>Then reload this page. The same-origin admin API is available at <code>/admin/api/*</code>.</p>
</body></html>`;
