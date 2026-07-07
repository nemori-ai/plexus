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
 * ── AUTH BOUNDARY (msrc-rev gate + FEAT configurable-binding re-gating) ───────
 * The loopback Host guard alone is NOT a sufficient gate: ANY local process can
 * send `Host: 127.0.0.1`, and once the user opts to ALSO bind a LAN interface a
 * real LAN device can reach `/admin/api/*` too. So EVERY `/admin/api/*` DATA route
 * — reads AND writes — requires a VERIFIED connection-key (`X-Plexus-Connection-Key`,
 * checked via `state.connectionKey`), applied uniformly by one blanket
 * `admin.use("/api/*", requireManagementKey)`. (Originally only the MUTATING +
 * secret + grant routes were gated and read-only GETs stayed loopback-only; the
 * network-binding relaxation makes those reads LAN-reachable, so they are gated now.)
 * The management CLIENT obtains the key OUT OF BAND — NEVER over HTTP (F2): the
 * desktop app injects it via Electron IPC (it read `~/.plexus/connection-key`), or
 * a human pastes the key the runtime printed to its launching terminal. There is
 * deliberately NO `GET /admin/api/connection-key` route: an untrusted agent speaks
 * only HTTP, so any HTTP route that returns (or hints at) the key would let the
 * agent escalate to the management surface. The `plexus source` CLI reads the key
 * file directly. ONLY the SPA HTML / static-asset serving (the `/*` catch-all) stays
 * key-free so the page can load; the public AGENT protocol surface (`.well-known`,
 * `/link/handshake`, `/grants`, `/invoke`, `/events`, `/manifest`, `POST /extensions`)
 * is NOT under `/admin/api/*` and keeps its own auth — untouched by this gate.
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
  CapabilityHealth,
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
import { gatewayInfo, authAdvertisement } from "./well-known.ts";
import type { Session } from "./sessions.ts";
import { plexusHome, ensureDir } from "./paths.ts";
import type { ConfiguredSource } from "../sources/config/types.ts";
import { connectorCatalog } from "../sources/config/catalog.ts";
import { isSafeSecretName } from "../sources/extension.ts";
import { readCcMasterConfig, writeCcMasterConfig } from "../sources/cc-master/config.ts";
import { defaultDemoRoot, setupDemoWorkspace } from "./demo-workspace.ts";
import {
  scanNetworkInterfaces,
  writeNetworkConfig,
  DEFAULT_BIND_ADDRESSES,
} from "../config.ts";
import {
  REAL_LAUNCH_SOURCES,
  realLaunchEnabled,
  sourceSettings,
  writeSourceSettings,
} from "../sources/config/settings.ts";

/** The directory the built web-admin SPA lands in (Vite `outDir`). */
const CLIENT_DIST = fileURLToPath(new URL("../../../web-admin/dist", import.meta.url));

/** The SPA's source tree (for the stale-build check below; absent in shipped images). */
const CLIENT_SRC = fileURLToPath(new URL("../../../web-admin/src", import.meta.url));

/** Newest file mtime under `dir`, recursive; 0 when unreadable/empty. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      try {
        const t = statSync(join(entry.parentPath ?? dir, entry.name)).mtimeMs;
        if (t > newest) newest = t;
      } catch {
        /* racing deletes are fine */
      }
    }
  } catch {
    /* dir missing/unreadable ⇒ 0 */
  }
  return newest;
}

/**
 * STALE-BUILD guard for the served console. `dist/` is a gitignored LOCAL build —
 * the gateway serves whatever was last built, which can lag the source by months
 * and resurrect long-dead UI flows (a pre-ADR-019 bundle shipped a connect wizard
 * that handed the CONNECTION-KEY to agents — exactly the class of regression this
 * warning exists to catch). Warn loudly when the checkout's `src/` is newer than
 * the built `dist/` (or `dist/` is missing); stay silent in shipped images where
 * only `dist/` exists.
 */
let staleDistChecked = false;
function warnIfClientDistStale(): void {
  if (staleDistChecked) return; // once per process (tests construct many apps)
  staleDistChecked = true;
  const srcNewest = newestMtimeMs(CLIENT_SRC);
  if (srcNewest === 0) return; // no source tree (shipped/packaged) — nothing to compare
  const distNewest = newestMtimeMs(CLIENT_DIST);
  if (distNewest === 0) {
    console.error(
      "[plexus] WARNING: the admin console has never been built (packages/web-admin/dist is empty).\n" +
        "[plexus]          /admin will 404 — build it:  bun run --cwd packages/web-admin build",
    );
    return;
  }
  if (srcNewest > distNewest) {
    console.error(
      "[plexus] WARNING: the served admin console is a STALE build — packages/web-admin/src is newer\n" +
        "[plexus]          than dist/. You may be serving an outdated (even insecure) UI.\n" +
        "[plexus]          Rebuild it:  bun run --cwd packages/web-admin build",
    );
  }
}

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
  /**
   * The CACHED per-source health snapshot (HEALTH) so the dashboard can show health
   * inline without a second call. Advisory + time-varying (the `/admin/api/health`
   * contract); a disabled/offline source reads "unavailable"/"unknown".
   */
  health: { status: CapabilityHealth["status"]; detail?: string; checkedAt?: string };
}

/** Read a source's cached health (HEALTH), defensively (an injected fake registry may lack it). */
function healthOf(state: GatewayState, sourceId: string): CapabilityHealth {
  return typeof state.capabilities.healthOf === "function"
    ? state.capabilities.healthOf(sourceId)
    : { status: "unknown" };
}

/**
 * Join the persisted `ConfiguredSource` desired-state with the LIVE registry: a
 * source is "live" when at least one of its capabilities is registered (the
 * registry indexes entries by `source` = the SourceId). Disabled-but-persisted
 * sources show `live:false`. Each row also carries the cached per-source health.
 */
function sourceViews(state: GatewayState): SourceView[] {
  const liveCounts = new Map<string, number>();
  for (const entry of state.capabilities.all()) {
    liveCounts.set(entry.source, (liveCounts.get(entry.source) ?? 0) + 1);
  }
  return state.managedSources.list().map((cfg) => {
    const liveCapabilityCount = liveCounts.get(cfg.id) ?? 0;
    const h = healthOf(state, cfg.id);
    return {
      ...cfg,
      live: liveCapabilityCount > 0,
      liveCapabilityCount,
      health: {
        status: h.status,
        ...(h.detail ? { detail: h.detail } : {}),
        ...(h.checkedAt ? { checkedAt: h.checkedAt } : {}),
      },
    };
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
  // One-shot stale-build check for the served SPA (see warnIfClientDistStale).
  warnIfClientDistStale();
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

  // ── MANAGEMENT-KEY GUARD — required on EVERY /admin/api/* DATA route ─────────
  // The Host/Origin guard proves "an accepted authority" (loopback, or — once the
  // user opts into LAN binding — a configured interface). It does NOT prove "the
  // trusted management client": ANY local process can send a loopback Host, and once
  // the gateway is bound to the LAN a real LAN device can reach `/admin/api/*` too.
  // A verified connection-key (obtained out-of-band by the real client — desktop IPC
  // injection or human paste, NEVER over HTTP; the CLI reads the key file) is what
  // distinguishes the management surface from an arbitrary caller — an agent / LAN
  // peer only speaks HTTP, so it can never present it.
  //
  // SECURITY RE-GATING (FEAT configurable-binding): previously the read-only
  // `/admin/api/*` GETs (capabilities/tokens/audit/sources/health/…) were loopback-
  // only WITHOUT a key — acceptable while strictly loopback. Opening the bind to the
  // LAN would leak that local discovery state to any LAN peer, so the key gate is now
  // applied UNIFORMLY to every `/admin/api/*` route (reads + writes). The SPA HTML /
  // asset serving (the `/*` catch-all below) STAYS reachable without a key so the page
  // can load — only the DATA routes under `/api/*` are gated. The web-admin client
  // (`packages/web-admin/src/api.ts`) attaches `X-Plexus-Connection-Key` on EVERY read
  // + write, so the SPA keeps working once gated.
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

  // ONE blanket gate over the whole `/admin/api/*` DATA surface (reads + writes).
  // Hono runs `use` matchers before the route handlers; `/api/*` matches every API
  // path but NOT the SPA HTML/asset paths served by the `/*` catch-all (those are
  // `/admin`, `/admin/index.html`, `/admin/assets/...` — none under `/api/`). The
  // authoring guide is intentionally included now (it would otherwise be LAN-exposed):
  // the SPA sends the key on that read too.
  admin.use("/api/*", requireManagementKey);

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

  // ── EXPOSURE POLICY ("What I expose") — the owner's per-capability on/off switch ─
  // The OUTERMOST gate, intersected with the grant model (effective access = granted ∧
  // exposed). Management-key gated (it changes the agent-visible surface + the trust
  // boundary). GET lists every live capability + its exposure; POST toggles one, bumps the
  // manifest revision, and publishes `manifest_changed` so connected agents re-fetch.

  // LIST — every live capability id + whether it is currently exposed (default true). Also
  // includes any EXPLICITLY-disabled id that is no longer live, so the page can still re-enable it.
  admin.get("/api/exposure", (c) => {
    const seen = new Set<string>();
    const capabilities: { id: string; label: string; enabled: boolean }[] = [];
    for (const entry of state.capabilities.all()) {
      seen.add(entry.id);
      capabilities.push({
        id: entry.id,
        label: entry.label,
        enabled: state.exposure.isEnabled(entry.id),
      });
    }
    // Surface explicitly-disabled ids that aren't in the live registry right now (so a
    // disabled-then-source-offline capability remains toggleable from the page).
    for (const id of state.exposure.disabledIds()) {
      if (!seen.has(id)) capabilities.push({ id, label: id, enabled: false });
    }
    return c.json({ capabilities, revision: state.capabilities.revision() });
  });

  // TOGGLE — enable/disable one capability's top-level exposure. Persists, bumps the
  // manifest revision (so agents re-fetch), publishes `manifest_changed`, and audits.
  admin.post("/api/exposure/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ error: { code: "internal_error", message: "missing :id" } }, 400);
    }
    let body: { enabled?: unknown };
    try {
      body = (await c.req.json()) as { enabled?: unknown };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json(
        { error: { code: "internal_error", message: "`enabled` (boolean) is required" } },
        400,
      );
    }
    const was = state.exposure.isEnabled(id);
    state.exposure.setEnabled(id, body.enabled);
    // Only churn the revision / notify when the effective exposure actually changed.
    if (was !== body.enabled) {
      const revision =
        typeof state.capabilities.bumpRevision === "function"
          ? state.capabilities.bumpRevision()
          : state.capabilities.revision();
      // Agents are notified the agent-visible manifest changed (the toggled id moved in/out
      // of the entry set) → they re-fetch `GET /manifest`.
      state.events.publish({
        type: "manifest_changed",
        revision,
        changed: { updated: [id] },
      });
      await state.audit.write({
        type: "exposure.set",
        capabilityId: id,
        detail: { enabled: body.enabled, surface: "what-i-expose" },
      });
    }
    return c.json({ ok: true, id, enabled: body.enabled, revision: state.capabilities.revision() });
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

  // ── CONNECT AN AGENT (agent-skill-compile §3 step 1 / §5 / Inv I·III / ADR-3·4·5) ─
  // The ADMIN side of "Connect an agent." ONE management-gated action provisions an
  // agent end-to-end: (a) grant the selected cap-set to `agentId` as STANDING grants
  // (this admin grant IS the human approval, done once at admin-time — Inv I), so once
  // the agent redeems its PAT + handshakes, its `PUT /grants` short-circuits with no
  // per-call approval; and (b) mint a ONE-TIME enrollment code the agent redeems for its
  // durable per-agent PAT. The raw code is returned to the admin caller ONCE so the
  // console (D2) can render the copy-able install command carrying it (ADR-8). This
  // route is management-key gated (the blanket `/api/*` guard) and NEVER agent-reachable —
  // the connection-key stays admin-only (Inv III). Re-connecting an already-enrolled agent
  // is the lost-PAT / re-provision path: mint resets the enrollment row + drops the old PAT.
  admin.post("/api/agents/connect", async (c) => {
    let body: { agentId?: unknown; capabilities?: unknown; agentType?: unknown; trustWindow?: TrustWindow; ttlMs?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    // F2: normalize agentId IDENTICALLY on connect + revoke — TRIM only (case-sensitive,
    // but the SAME derivation on both paths) so the stored grant/session key matches the
    // key `/api/agents/revoke` looks up. `connect("agent-Z")` then `revoke(" agent-Z")`
    // must hit the same agent. F3 (defense-in-depth): the admin-id guard compares
    // case-insensitively so "Plexus-Admin" can't sneak past the reserved-id check.
    const agentIdRaw = body.agentId;
    if (typeof agentIdRaw !== "string" || agentIdRaw.trim().length === 0 || agentIdRaw.trim().toLowerCase() === ADMIN_AGENT_ID) {
      return c.json(
        { error: { code: "internal_error", message: "`agentId` (a non-empty string, not the admin id) is required" } },
        400,
      );
    }
    const agentId = agentIdRaw.trim();
    const requestedCaps = Array.isArray(body.capabilities)
      ? body.capabilities.filter((x): x is string => typeof x === "string")
      : [];
    // Reject unknown capability ids up front (no silent skip → a truthful contract). A
    // disabled-but-known cap is NOT rejected here (the grant service audits + skips it —
    // it just won't become standing, and is reported under `skipped`).
    const unknown = requestedCaps.filter((id) => !state.capabilities.get(id));
    if (unknown.length > 0) {
      return c.json(
        {
          error: {
            code: "unknown_capability",
            message: `unknown capability id(s): ${unknown.join(", ")} — run GET /admin/api/capabilities for current ids`,
          },
          unknownCapabilities: unknown,
        },
        400,
      );
    }
    let ttlMs: number | undefined;
    if (body.ttlMs !== undefined) {
      if (typeof body.ttlMs !== "number" || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
        return c.json(
          { error: { code: "internal_error", message: "`ttlMs` must be a positive number of milliseconds" } },
          400,
        );
      }
      ttlMs = body.ttlMs;
    }

    // (b) MINT the one-time enrollment code FIRST (F4 — atomicity). Minting is the step that
    // can fail (enrollment-store I/O), so doing it BEFORE persisting any standing grant means a
    // mint failure surfaces (throws → 500) while NOTHING has been persisted — never leaving
    // orphan standing grants behind for an agent that can't actually enroll. The raw code is
    // delivered to the admin ONCE for the install command.
    const minted = state.agentEnrollment.mintEnrollmentCode(agentId, ttlMs !== undefined ? { ttlMs } : {});

    // (a) GRANT the cap-set as STANDING under the REAL agentId. Open a management session
    // AS that agent (exactly as `PUT /api/grants` does for the decoy fix) so the persisted
    // grants key to it, and thread the admin-chosen (authoritative) trust-window. The admin
    // GrantService's AutoApproveAuthorizer makes this a real human-approved standing grant
    // that `hasStanding()`/`hasPriorApproval()` recognize. `execute`/`once`-sensitivity caps
    // do not stand (per-cap sensitivity, ADR-5) — even with an admin-supplied trust-window the
    // grant service forces `once` (chooseTrustWindow), so they never persist as standing and
    // simply won't appear under `granted` (they surface under `skipped`).
    if (requestedCaps.length > 0) {
      const grantsBody: GrantRequest["grants"] = {};
      for (const id of requestedCaps) {
        grantsBody[id] = body.trustWindow ? { decision: "allow", trustWindow: body.trustWindow } : "allow";
      }
      const sess = state.sessions.open(state.connectionKey.current(), {
        name: "plexus-management-client",
        agentId,
      });
      await grants.grant({ sessionId: sess.id, grants: grantsBody }, sess);
    }
    // Read back the standing grants now on record for this agent (the truthful "what the
    // agent can do frictionlessly" set), and which requested caps did NOT become standing.
    const standing: StandingGrant[] = grants.listGrants(agentId);
    const standingIds = new Set(standing.map((g) => g.capabilityId));
    const granted = standing.filter((g) => requestedCaps.includes(g.capabilityId));
    const skipped = requestedCaps.filter((id) => !standingIds.has(id));

    const adv = authAdvertisement(state.config, state.boundPort);
    await state.audit.write({
      type: "handshake",
      agentId,
      detail: {
        event: "agent.connect",
        ...(typeof body.agentType === "string" ? { agentType: body.agentType } : {}),
        grantedCount: granted.length,
        skippedCount: skipped.length,
      },
    });
    return c.json({
      ok: true,
      agentId,
      ...(typeof body.agentType === "string" ? { agentType: body.agentType } : {}),
      code: minted.code,
      expiresAt: minted.expiresAt,
      enrollUrl: adv.enrollmentUrl,
      handshakeUrl: adv.handshakeUrl,
      granted,
      skipped,
    });
  });

  // ── REVOKE AN AGENT (agent-skill-compile §3 step 4 / Inv III / ADR-3) ─────────────
  // Revoke an agent = make ALL of THAT agent's access die IMMEDIATELY, nothing else
  // affected. Three parts, each per-agent scoped:
  //   1. ENROLLMENT/PAT — `agentEnrollment.revoke(agentId)` tombstones the enrollment row +
  //      drops its PAT from the active index → future handshakes with that PAT fail closed.
  //   2. LIVE SESSIONS — `sessions.invalidateByAgentId(agentId)` kills the agent's already-open
  //      sessions (the A2 follow-up) + revokes their tokens, so revoke is IMMEDIATE rather than
  //      delayed by ~session-lifetime.
  //   3. STANDING GRANTS — `grants.revokeAllForAgent(agentId)` removes the agent's standing
  //      grants + tombstones them (Inv III: ALL its access dies) + revokes any remaining tokens.
  // ONLY that agent is touched — other agents' enrollments, sessions, and grants are untouched.
  admin.post("/api/agents/revoke", async (c) => {
    let body: { agentId?: unknown; reason?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    // F2: normalize agentId IDENTICALLY to `/api/agents/connect` — TRIM only. A revoke with a
    // whitespace-variant id (`" agent-Z"`) now derives the SAME stored key connect used, so the
    // agent's enrollment/sessions/grants are actually torn down instead of silently no-op'ing.
    const agentIdRaw = body.agentId;
    if (typeof agentIdRaw !== "string" || agentIdRaw.trim().length === 0) {
      return c.json(
        { error: { code: "internal_error", message: "`agentId` (a non-empty string) is required" } },
        400,
      );
    }
    const agentId = agentIdRaw.trim();
    const reason = typeof body.reason === "string" ? body.reason : undefined;

    // 1. Kill the enrollment row + its PAT (future handshakes with that PAT now fail closed).
    const enrollmentRevoked = state.agentEnrollment.revoke(agentId);
    // 2. Invalidate the agent's LIVE sessions NOW + revoke their tracked tokens (immediate).
    const sessionJtis = state.sessions.invalidateByAgentId(agentId);
    for (const jti of sessionJtis) {
      if (state.revocation.isRevoked(jti)) continue;
      state.revocation.revoke(jti, reason ?? "agent revoked");
      state.events.publish({ type: "token_revoked", jti, reason: reason ?? "agent revoked" });
    }
    // 3. Remove the agent's standing grants (+ tombstone) + revoke any remaining tokens.
    const grantRevoke: RevokeResponse = await grants.revokeAllForAgent(agentId, reason);

    return c.json({
      ok: enrollmentRevoked || sessionJtis.length > 0 || grantRevoke.ok,
      agentId,
      enrollmentRevoked,
      sessionsInvalidated: sessionJtis.length,
      grantsRemoved: grantRevoke.grantRemoved,
      revokedJtis: grantRevoke.revokedJtis,
      auditId: grantRevoke.auditId,
    });
  });

  // ── AGENT ENROLLMENT STATUS (agent-skill-compile §3 Auth model) — the console read ─
  // The Agents tab knows an agent's GRANTS but not its ENROLLMENT lifecycle: a
  // provisioned-but-not-yet-redeemed agent (code minted, PAT not yet redeemed) is
  // "pending" — awaiting install / not yet enrolled — as distinct from "active" (enrolled,
  // holds a durable PAT) or "revoked". This management-key-gated read (the blanket `/api/*`
  // guard) projects the per-agent enrollment ledger so the console can distinguish
  // "created but not integrated" from "connected" at a glance, alongside the separate
  // live-session activity dimension. SECRET HYGIENE (Inv III): only the agentId + status +
  // lifecycle timestamps are surfaced — the persisted `codeHash` / `patHash` NEVER leave here.
  admin.get("/api/agents/enrollments", (c) => {
    const agents = state.agentEnrollment.list().map((r) => ({
      agentId: r.agentId,
      status: r.status,
      issuedAt: r.issuedAt,
      codeExpiresAt: r.codeExpiresAt,
      ...(r.redeemedAt ? { redeemedAt: r.redeemedAt } : {}),
      ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
    }));
    return c.json({ agents });
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

  // ── PER-SOURCE HEALTH (HEALTH) — the dashboard health report ─────────────────
  // Read-only GET (loopback-only, like /api/sources): a per-source health row + the
  // capability ids that inherit it. PROBES each source NOW (awaitable refresh) so the
  // first admin read is accurate rather than a lazy "unknown"; the probe is cheap +
  // best-effort (a slow/failing probe degrades to the last cached value, never 500s).
  admin.get("/api/health", async (c) => {
    const registry = state.capabilities;
    if (typeof registry.healthReport !== "function") {
      // An injected fake registry without HEALTH support: empty report (never 500).
      return c.json({ sources: [], revision: registry.revision() });
    }
    // Refresh each contributing source NOW (deduped + bounded) so the report is fresh.
    if (typeof registry.refreshHealth === "function") {
      const sourceIds = new Set(registry.all().map((e) => e.source));
      await Promise.all(
        [...sourceIds].map((id) =>
          registry.refreshHealth(id).catch(() => {
            /* advisory — a failed probe degrades to the cached value */
          }),
        ),
      );
    }
    return c.json(registry.healthReport());
  });

  // ── NETWORK BINDING (FEAT configurable-binding) ──────────────────────────────
  // The user opens the gateway beyond loopback by scanning interfaces + choosing
  // which to ALSO bind. All three routes are management-key gated by the blanket
  // `/api/*` guard above (they DISCLOSE the machine's interface layout + CHANGE the
  // trust boundary, so the connection-key holder — the trusted human — drives them).

  // SCAN — the machine's network interfaces (IPv4 + IPv6, `internal` for loopback).
  admin.get("/api/interfaces", (c) => {
    return c.json({ interfaces: scanNetworkInterfaces() });
  });

  // READ — the current persisted bind choice + what's ACTUALLY bound + the port.
  admin.get("/api/network", (c) => {
    const configured = state.config.bindAddresses ?? DEFAULT_BIND_ADDRESSES;
    const active = state.boundAddresses ?? configured;
    const boundPort = state.boundPort ?? state.config.port;
    return c.json({
      bindAddresses: [...configured],
      active: [...active],
      boundPort,
      publicHostnames: [...(state.config.publicHostnames ?? [])],
    });
  });

  // WRITE — validate + persist the chosen bind addresses (and, optionally, the
  // published public hostnames — FEAT public-hostname) to ~/.plexus/network.json.
  // Bind addresses must each be loopback, "0.0.0.0", or a REAL local interface
  // address; public hostnames must be plain DNS names (never IPs — validated in
  // `validatePublicHostnames`). Omitting `publicHostnames` leaves the persisted
  // choice untouched; `[]` clears it. Rebinding a live socket is involved, so v1
  // PERSISTS and requires a RESTART to take effect — the response says
  // `restartRequired:true`. Any invalid entry → 400 (nothing written).
  admin.post("/api/network", async (c) => {
    let body: { bindAddresses?: unknown; publicHostnames?: unknown };
    try {
      body = (await c.req.json()) as { bindAddresses?: unknown; publicHostnames?: unknown };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (!Array.isArray(body.bindAddresses)) {
      return c.json(
        { error: { code: "internal_error", message: "`bindAddresses` (string[]) is required" } },
        400,
      );
    }
    if (body.publicHostnames !== undefined && !Array.isArray(body.publicHostnames)) {
      return c.json(
        { error: { code: "internal_error", message: "`publicHostnames`, when present, must be string[]" } },
        400,
      );
    }
    const requested = (body.bindAddresses as unknown[]).filter(
      (a): a is string => typeof a === "string",
    );
    const requestedHosts = Array.isArray(body.publicHostnames)
      ? (body.publicHostnames as unknown[]).filter((a): a is string => typeof a === "string")
      : undefined;
    const result = writeNetworkConfig(requested, requestedHosts);
    if (!result.ok) {
      return c.json(
        {
          error: {
            code: "internal_error",
            message:
              "invalid network entry — bind addresses must be loopback, 0.0.0.0, or a real local " +
              "interface; public hostnames must be plain DNS names (no IP, scheme, port, or path); " +
              `rejected: ${result.rejected.join(", ")}`,
          },
          rejected: result.rejected,
        },
        400,
      );
    }
    return c.json({
      ok: true,
      bindAddresses: result.bindAddresses,
      publicHostnames: result.publicHostnames,
      restartRequired: true,
    });
  });

  // ── SOURCE SETTINGS — the owner's machine-level knobs for first-party sources ──
  // v1 carries ONE knob: `realLaunch` on the exec-class sources (codex / claudecode /
  // cc-master) — whether an APPROVED execute call actually spawns the tool (spending
  // the owner's model quota / running agents) or performs the honest record-mode
  // dry-run. Machine capability is the OWNER's static decision; the per-call grant
  // approval stays what it is. Live-effective (launchers read per call, no restart);
  // audited (`source.settings`) because flipping it changes what "approve" does.

  // READ — the trio + where each effective value comes from (setting vs env vs default).
  admin.get("/api/source-settings", (c) => {
    const sources = REAL_LAUNCH_SOURCES.map(({ sourceId, envFallback }) => {
      const persisted = sourceSettings(sourceId).realLaunch;
      return {
        sourceId,
        realLaunch: realLaunchEnabled(sourceId, envFallback),
        persisted: typeof persisted === "boolean" ? persisted : null,
        envFallback,
        envActive: process.env[envFallback] === "1",
      };
    });
    return c.json({ sources });
  });

  // WRITE — set (true/false) or clear (null ⇒ fall back to env/default) one source's knob.
  admin.put("/api/source-settings/:sourceId", async (c) => {
    const sourceId = c.req.param("sourceId");
    const known = REAL_LAUNCH_SOURCES.find((s) => s.sourceId === sourceId);
    if (!known) {
      return c.json(
        { error: { code: "unknown_capability", message: `no settable source '${sourceId}' — settable: ${REAL_LAUNCH_SOURCES.map((s) => s.sourceId).join(", ")}` } },
        404,
      );
    }
    let body: { realLaunch?: unknown };
    try {
      body = (await c.req.json()) as { realLaunch?: unknown };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (body.realLaunch !== null && typeof body.realLaunch !== "boolean") {
      return c.json(
        { error: { code: "internal_error", message: "`realLaunch` must be true, false, or null (clear)" } },
        400,
      );
    }
    const persisted = writeSourceSettings(sourceId, {
      realLaunch: body.realLaunch === null ? undefined : body.realLaunch,
    });
    const effective = realLaunchEnabled(sourceId, known.envFallback);
    await state.audit.write({
      type: "source.settings",
      detail: {
        sourceId,
        realLaunch: body.realLaunch,
        effective,
        // Why this is trust-relevant, spelled out for the audit reader:
        note: effective
          ? "approved execute calls on this source now REALLY spawn the tool"
          : "approved execute calls on this source now record-mode (no real spawn)",
      },
    });
    return c.json({
      ok: true,
      sourceId,
      realLaunch: effective,
      persisted: typeof persisted.realLaunch === "boolean" ? persisted.realLaunch : null,
    });
  });

  // ── MESH (federated-mesh §7 Q3 / A1) — the out-of-process join-token mint surface ─
  // A primary mints a ONE-TIME join token the operator hands a remote proxy out-of-band
  // (the `mintJoinToken()` authority was in-process only). Both routes ride the blanket
  // `/api/*` management-key gate above — minting an admission token is a trust-boundary
  // act, so only the connection-key holder (the trusted local human) can do it. There is
  // NO new auth code here. Returns the token PLUS the upstream coordinates a proxy needs
  // (tunnel port + the primary's pinned pubkey) so the operator can assemble the proxy's
  // env in one step. Zero-exposure entry (Q3): a token admits a workload but grants ZERO
  // visibility/access until the owner deliberately exposes + grants.

  // STATUS — the mesh posture (mode, bound tunnel endpoints, primary pubkey). Read-only.
  // Reports BOTH listeners (B7 / P4-0): `tunnelPort` (the plain-`ws` port, back-compat) PLUS the
  // full `endpoints` array — `[{scheme:"ws",…}]` and, when TLS is configured, a `wss` entry — so
  // an operator can hand a container/VM proxy a reachable upstream URL + the right scheme.
  admin.get("/api/mesh", (c) => {
    // PER-WORKLOAD HEALTH (mesh-health-reporting.md §6): the primary surfaces each mounted
    // workload's route + REPORTED health so the console renders the real status of mounted mesh
    // caps (healthy/degraded/down/stale/connecting) instead of "health unknown". Empty on a proxy
    // / before start (defensive: an injected fake mesh runtime may lack the method).
    const workloads =
      state.mode === "primary" && typeof state.mesh.meshWorkloadHealth === "function"
        ? state.mesh.meshWorkloadHealth()
        : [];
    return c.json({
      mode: state.mode,
      tunnelPort: state.mesh.tunnelPort,
      endpoints: state.mesh.tunnelEndpoints,
      primaryPubKey: state.mesh.meshPublicKey,
      workloads,
    });
  });

  // MINT — issue a one-time join token (primary only). 409 when this gateway is not a
  // primary or the mesh tunnel has not started (no enrollment authority); 400 on a
  // malformed `ttlMs`. The raw token is returned ONCE — only its hash is ever persisted.
  admin.post("/api/mesh/join-token", async (c) => {
    if (state.mode !== "primary") {
      return c.json(
        {
          error: {
            code: "mesh_not_primary",
            message: `this gateway is mode '${state.mode}' — only a primary mints join tokens`,
          },
        },
        409,
      );
    }
    const enrollment = state.mesh.enrollment;
    if (!enrollment) {
      return c.json(
        {
          error: {
            code: "mesh_not_started",
            message: "the mesh tunnel is not started — no enrollment authority to mint a join token",
          },
        },
        409,
      );
    }
    // Optional `ttlMs` (positive integer milliseconds); absent ⇒ a no-TTL token.
    let ttlMs: number | undefined;
    if (c.req.header("content-type")?.includes("application/json")) {
      let body: { ttlMs?: unknown };
      try {
        body = (await c.req.json()) as { ttlMs?: unknown };
      } catch {
        return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
      }
      if (body.ttlMs !== undefined) {
        if (typeof body.ttlMs !== "number" || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
          return c.json(
            { error: { code: "internal_error", message: "`ttlMs` must be a positive number of milliseconds" } },
            400,
          );
        }
        ttlMs = body.ttlMs;
      }
    }
    const minted = enrollment.mintJoinToken(ttlMs !== undefined ? { ttlMs } : {});
    return c.json({
      token: minted.token,
      ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
      tunnelPort: state.mesh.tunnelPort,
      endpoints: state.mesh.tunnelEndpoints,
      primaryPubKey: state.mesh.meshPublicKey,
    });
  });

  // REVOKE — terminally revoke a remote workload across the mesh (B6, primary only). Rides
  // the same blanket `/api/*` management-key gate — revoking a workload is a trust-boundary
  // act. 409 when this gateway is not a primary or the mesh has not started (no enrollment
  // authority); 400 on a missing/blank `workload`. The orchestrator tombstones the
  // enrollment, un-mounts its addresses, purges their grants, drops its live socket, and
  // stamps it unavailable — a reconnect with the old pinned key then fails closed
  // (`not_enrolled`). Per-GRANT revocation of a single mounted address stays on `/api/revoke`.
  admin.post("/api/mesh/revoke", async (c) => {
    if (state.mode !== "primary") {
      return c.json(
        {
          error: {
            code: "mesh_not_primary",
            message: `this gateway is mode '${state.mode}' — only a primary revokes a workload`,
          },
        },
        409,
      );
    }
    if (!state.mesh.enrollment) {
      return c.json(
        {
          error: {
            code: "mesh_not_started",
            message: "the mesh tunnel is not started — no enrollment authority to revoke a workload",
          },
        },
        409,
      );
    }
    let body: { workload?: unknown };
    try {
      body = (await c.req.json()) as { workload?: unknown };
    } catch {
      return c.json({ error: { code: "internal_error", message: "invalid JSON body" } }, 400);
    }
    if (typeof body.workload !== "string" || body.workload.length === 0) {
      return c.json(
        { error: { code: "internal_error", message: "`workload` is required (a non-empty string)" } },
        400,
      );
    }
    const result = state.mesh.revokeWorkload(body.workload);
    return c.json(result);
  });

  // ── 5. VIEW AUDIT — the handshake/grant/token/invoke/revoke trail ────────────
  // Each event is returned VERBATIM as persisted (redaction already applied by the
  // single audit writer), so an `invoke` item now also carries `input` (the request
  // args) and `output` (the result, or `{ error }` for a denial/failure) — both
  // redacted + size-capped at write time — for the Activity view's request/result
  // panes. Older events simply omit the fields (optional, backward-compatible).
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

  // DEMO WORKSPACE (P1b onboarding) — one call materializes the demo directory
  // (default ~/PlexusDemo; body.path overrides) and exposes it as TWO managed
  // workspace-dir sources with opposite postures: `demo-intro` (auto — reads flow)
  // + `your-secret` (approval:"ask" — every verb pends for the owner). IDEMPOTENT:
  // repeat calls never overwrite user-edited files and never re-register / retune
  // an existing source. Trusted local human surface, gated like every source route.
  admin.post("/api/demo-workspace", async (c) => {
    let body: { path?: unknown } = {};
    try {
      body = (await c.req.json()) as { path?: unknown };
    } catch {
      /* an empty body is fine — the default root applies */
    }
    const root =
      typeof body.path === "string" && body.path.trim().length > 0 ? body.path : defaultDemoRoot();
    try {
      const result = await setupDemoWorkspace(state.managedSources, root, {
        // Report/verify the REAL live capabilities for an already-configured source, so a
        // disabled/failed source is re-enabled rather than reported ready-but-dead (P3).
        liveCapabilityIds: (sourceId) =>
          state.capabilities
            .all()
            .filter((e) => e.source === sourceId && e.kind === "capability")
            .map((e) => e.id),
      });
      return c.json(result, result.ok ? 200 : 422);
    } catch (e) {
      return c.json(
        { error: { code: "internal_error", message: e instanceof Error ? e.message : String(e) } },
        500,
      );
    }
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
      // PERSIST for restart-survival: this USER-INSTALLED extension is written to
      // `~/.plexus/extensions.json` so it is REPLAYED on the next boot (unlike the raw
      // `registerExtension`, which also serves non-persistable bundle/tunnel sources).
      state.installedExtensions.upsert(manifest);
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
    // Drop it from the durable installed-extension store so a future restart does not
    // replay it (idempotent — a no-op for a source that was never persisted here).
    state.installedExtensions.remove(source);
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
