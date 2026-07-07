/**
 * Same-origin admin API client. The gateway serves this SPA at /admin and exposes
 * a trusted-local admin API under /admin/api/* (see src/core/admin.ts). Because
 * the UI is same-origin, requests pass the gateway's Host/Origin guard (§5b); a
 * separate dev-server origin would be rejected.
 *
 * Types are imported VERBATIM from the frozen protocol contract so the client
 * stays in lockstep with the gateway (type-only imports are erased at build).
 */
import type {
  CapabilityEntry,
  GatewayInfo,
  GrantResponse,
  GrantDecision,
  RevokeResponse,
  AuditEvent,
  CapabilityId,
  StandingGrant,
  GrantsListResponse,
  TrustWindow,
  Provenance,
  Sensitivity,
  PendingNarration,
  ScopeConstraint,
  BundleView,
  BundlesResponse,
  GrantVerb,
} from "@plexus/protocol";
import type {
  ExtensionManifest,
  ExtensionCapabilityDecl,
  CapabilityHealth,
  HealthStatus,
} from "@plexus/protocol";
import type {
  ConfiguredSource,
  AddResult,
} from "@plexus/runtime/sources/config/types.ts";
import type {
  ConnectorDescriptor,
  ConnectorConfigField,
} from "@plexus/runtime/sources/config/connector-descriptor.ts";
import type { AgentEnrollmentStatus } from "./connect.ts";

/** All admin API paths are under the same origin the SPA is served from. */
const BASE = "/admin/api";

/**
 * The desktop shell's preload bridge (Electron). Present only inside the Plexus
 * desktop app; `getConnectionKey` resolves the management key out-of-band over IPC
 * (the trusted main process read `~/.plexus/connection-key`). Absent in a plain
 * browser/dev session.
 */
declare global {
  interface Window {
    plexusDesktop?: {
      isDesktop?: boolean;
      platform?: string;
      getConnectionKey?: () => Promise<string | null> | string | null;
    };
  }
}

/** LocalStorage slot for a human-pasted key (browser/dev fallback; per-origin). */
const KEY_STORAGE = "plexus.connectionKey.v1";

/**
 * F2 — the management connection-key is NEVER fetched over HTTP. An untrusted agent
 * speaks only HTTP over loopback, so a `GET /admin/api/connection-key` route would
 * let it escalate to the management surface; that route is gone. The trusted admin
 * page obtains the key OUT OF BAND, resolved in this order:
 *   (a) `window.plexusDesktop.getConnectionKey()` — Electron IPC injection (desktop);
 *   (b) a value the human pasted earlier, cached in `localStorage`;
 *   (c) a one-time human paste prompt — the runtime prints the key to its launching
 *       terminal at startup (bin/plexus), so a browser/dev user pastes it once.
 * The result is held in an in-memory cache for the session. Mutating admin calls
 * attach it as `X-Plexus-Connection-Key`.
 */
let cachedKey: string | null = null;
let cachedKeyInflight: Promise<string> | null = null;

/** Reset the cached key (e.g. after the gateway rejects it as wrong/stale). */
export function forgetManagementKey(): void {
  cachedKey = null;
  cachedKeyInflight = null;
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* localStorage may be unavailable; ignore */
  }
}

/**
 * Cache + persist a key the host app already VALIDATED out of band (the in-app gate
 * confirms it against a gated read before calling this). Mirrors the caching
 * `resolveManagementKey` does when the paste prompt returns — exposed so the proactive
 * no-key gate (which never goes through the prompt path) can commit a verified key.
 */
export function rememberManagementKey(key: string): void {
  const k = key.trim();
  if (!k) return;
  cachedKey = k;
  try {
    localStorage.setItem(KEY_STORAGE, k);
  } catch {
    /* localStorage unavailable; ignore */
  }
}

/**
 * Is a management key resolvable WITHOUT prompting the human? Tries desktop IPC
 * injection then the localStorage cache; returns false if neither yields a non-empty
 * value. NEVER invokes the paste fallback — the host app calls this on mount to decide
 * whether to surface the key-entry gate proactively (instead of silently 401-ing).
 */
export async function hasResolvableKey(): Promise<boolean> {
  if (cachedKey) return true;
  try {
    const fromDesktop = await window.plexusDesktop?.getConnectionKey?.();
    if (fromDesktop && fromDesktop.trim()) return true;
  } catch {
    /* desktop bridge absent or failed — fall through */
  }
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    if (stored && stored.trim()) return true;
  } catch {
    /* localStorage unavailable; ignore */
  }
  return false;
}

/**
 * Called when a gated request comes back 401 — the cached key is wrong/stale. The host
 * app wires this to re-surface the key-entry gate. We `forgetManagementKey()` at the
 * call site so the next request re-resolves; this hook just re-opens the UI.
 */
let authFailureHandler: (() => void) | null = null;
export function setAuthFailureHandler(fn: (() => void) | null): void {
  authFailureHandler = fn;
}

/** Common 401 handling for every gated read/write: drop the stale key + re-surface UI. */
function handleUnauthorized(): void {
  forgetManagementKey();
  try {
    authFailureHandler?.();
  } catch {
    /* host handler threw — never let it mask the original request error */
  }
}

/** Overridable hook for the browser/dev human-paste fallback (App wires a real UI). */
let pasteKeyPrompt: () => Promise<string | null> = async () => {
  const v = typeof window !== "undefined" && typeof window.prompt === "function"
    ? window.prompt(
        "Paste your Plexus connection-key (printed by the runtime at startup, or in ~/.plexus/connection-key):",
      )
    : null;
  return v && v.trim() ? v.trim() : null;
};

/** Let the host app supply a nicer inline paste affordance than window.prompt. */
export function setPasteKeyPrompt(fn: () => Promise<string | null>): void {
  pasteKeyPrompt = fn;
}

async function resolveManagementKey(): Promise<string> {
  // (a) Desktop injection over IPC — the trusted main process read the key file.
  try {
    const fromDesktop = await window.plexusDesktop?.getConnectionKey?.();
    if (fromDesktop && fromDesktop.trim()) {
      const k = fromDesktop.trim();
      cachedKey = k;
      return k;
    }
  } catch {
    /* desktop bridge absent or failed — fall through to browser fallbacks */
  }
  // (b) A value the human pasted in a previous browser/dev session.
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    if (stored && stored.trim()) {
      cachedKey = stored.trim();
      return cachedKey;
    }
  } catch {
    /* localStorage unavailable; ignore */
  }
  // (c) Prompt the human to paste it once, then cache for the session.
  const pasted = await pasteKeyPrompt();
  if (pasted && pasted.trim()) {
    const k = pasted.trim();
    cachedKey = k;
    try {
      localStorage.setItem(KEY_STORAGE, k);
    } catch {
      /* ignore */
    }
    return k;
  }
  throw new Error("no connection-key: paste your connection-key to manage Plexus");
}

async function managementKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  if (!cachedKeyInflight) {
    cachedKeyInflight = resolveManagementKey().finally(() => {
      cachedKeyInflight = null;
    });
  }
  return cachedKeyInflight;
}

async function getJson<T>(path: string): Promise<T> {
  // Most admin reads are loopback-only, but some (GET /api/grants, /api/bundles) are
  // management-key gated — and the SPA can't tell which a given path is. So attach the
  // verified connection-key on EVERY read too (harmless on loopback-only routes; required
  // for the gated ones). Same key the mutating `sendJson` uses; resolved out-of-band
  // (desktop IPC / human paste — never an HTTP fetch, F2) and cached.
  const key = await managementKey();
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json", "X-Plexus-Connection-Key": key },
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function getText(path: string): Promise<string> {
  // The authoring guide is served as text/markdown (loopback-only, not mgmt-key gated).
  // Attach the cached key anyway — harmless, and keeps the read path uniform.
  const key = await managementKey();
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "text/markdown, text/plain", "X-Plexus-Connection-Key": key },
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.text();
}

/**
 * GET `/integration/:agentId` — the copy-able ONE-COMMAND install for an already-connected
 * agent (D1-ENDPOINT). This route lives OUTSIDE `/admin/api/*` (mounted at the gateway root),
 * so it does NOT take the `BASE` prefix — but it IS management-key gated. Attach the same
 * out-of-band connection-key the other gated calls use.
 *
 * Bug A: a plain fetch does NOT mint/reset an ALREADY-ACTIVE agent (its live PAT keeps working);
 * the response flags `alreadyEnrolled`. Pass `reissue: true` ONLY for the explicit "re-issue a
 * one-time code" action — that DOES reset the row to pending + invalidate the current credential.
 */
async function getIntegration(agentId: string, opts: { reissue?: boolean } = {}): Promise<IntegrationResult> {
  const key = await managementKey();
  const path = `/integration/${encodeURIComponent(agentId)}${opts.reissue ? "?reissue=1" : ""}`;
  const res = await fetch(path, {
    headers: { accept: "application/json", "X-Plexus-Connection-Key": key },
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${path} → ${res.status} ${detail}`);
  }
  return (await res.json()) as IntegrationResult;
}

async function sendJson<T>(
  path: string,
  method: string,
  body: unknown,
  /**
   * Statuses to TOLERATE — return the parsed body instead of throwing. For endpoints
   * whose response type already models failure (an `{ ok:false, reason }` envelope), so
   * the caller can render `reason` rather than a raw `path → 422 {…}` Error blob (B1).
   */
  tolerateStatuses?: readonly number[],
): Promise<T> {
  // Mutating routes are connection-key gated; attach the verified management key.
  const key = await managementKey();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "X-Plexus-Connection-Key": key,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok && !(tolerateStatuses?.includes(res.status))) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${path} → ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

export interface CapabilitiesResponse {
  gateway: GatewayInfo;
  revision: number;
  entries: CapabilityEntry[];
}

export interface ActiveToken {
  jti: string;
  sessionId: string;
  agentId?: string;
  /**
   * Each scope carries BOTH clocks — the token's 15-min `expiresAt` (above) and the
   * backing GRANT's trust-window (`grantExpiresAt` + `trustWindow`) — plus the
   * source-class (`provenance`) so the UI stops conflating token and grant (ADR-018).
   */
  scopes: {
    id: string;
    verbs: string[];
    synthesizedFor?: string;
    grantExpiresAt?: string;
    trustWindow?: TrustWindow;
    provenance?: Provenance;
  }[];
  expiresAt: string;
}

/** Security-sensitive surface of a pending extension registration (for approval). */
export interface PendingRegisterSurface {
  source: string;
  label: string;
  capabilities: { id: string; label: string; kind: string; transport: string; verbs: string[] }[];
  cliBins: string[];
  restHosts: string[];
  crossSource: { id: string; sources: string[] }[];
  transportBacked: boolean;
}

/** One pending item awaiting a human decision (a deferred grant or an extension register). */
export interface PendingItem {
  pendingId: string;
  kind: "grant" | "register";
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  agentId?: string;
  capabilities?: string[];
  scopes?: { id: string; verbs: string[]; synthesizedFor?: string; constraint?: ScopeConstraint }[];
  reasons?: string[];
  /** Gateway-authored narration (ADR-018) for the approve UI — one row per capability. */
  pendingNarration?: PendingNarration[];
  /** The agent-proposed (advisory) trust-window, if any. */
  requestedTrustWindow?: TrustWindow;
  /**
   * The AGENT-declared free-text purpose (AUTHZ-UX §2.N1) — sanitized + truncated by the
   * gateway. Rendered in the "the agent says:" block, NEVER merged with the gateway
   * narration. Absent ⇒ the card shows "(agent gave no reason)".
   */
  agentPurpose?: string;
  /** The requesting client's name/version (AUTHZ-UX §2.N2) — rendered as a chip by the agentId. */
  client?: { name?: string; version?: string };
  /**
   * For an agent-requested TASK BUNDLE (AUTHZ-UX §2.N3 / D4): the bundle name + member rows.
   * Rendered as ONE grouped pending card the human approves in a single action.
   */
  bundle?: { name: string; members: { id: string; verbs: string[]; constraint?: ScopeConstraint }[] };
  register?: PendingRegisterSurface;
}

/** One member spec when creating a bundle via the "New task grant" composer. */
export interface BundleMemberInput {
  id: string;
  verbs?: GrantVerb[];
  constraint?: ScopeConstraint;
}

/** Body of the admin one-shot bundle create. */
export interface CreateBundleBody {
  name: string;
  agentId: string;
  grants: BundleMemberInput[];
  trustWindow?: TrustWindow;
  context?: { kind: "skill" | "inline"; skillId?: string; label?: string; markdown?: string }[];
}

/** One row of `GET /admin/api/exposure` — a live capability + its top-level on/off state. */
export interface ExposureCapability {
  id: string;
  label: string;
  enabled: boolean;
}

/** `GET /admin/api/exposure` — every live (and explicitly-disabled) capability's exposure. */
export interface ExposureResponse {
  capabilities: ExposureCapability[];
  revision: number;
}

/** `POST /admin/api/exposure/:id` — the toggle result (new effective exposure + revision). */
export interface ExposureSetResponse {
  ok: boolean;
  id: string;
  enabled: boolean;
  revision: number;
}

/** `POST /admin/api/demo-workspace` — the onboarding demo-directory setup result. */
export interface DemoWorkspaceResult {
  ok: boolean;
  /** The materialized demo root (absolute). */
  root: string;
  /** Root-relative files written THIS call (existing files are never overwritten). */
  createdFiles: string[];
  sources: {
    id: string;
    path: string;
    approval: "auto" | "ask";
    capabilities: string[];
    alreadyConfigured: boolean;
  }[];
  reason?: string;
}

/** A configured managed source joined with its live registry status. */
export interface SourceView extends ConfiguredSource {
  live: boolean;
  liveCapabilityCount: number;
  /**
   * The CACHED per-source health snapshot (HEALTH) the gateway stamps onto every
   * `/admin/api/sources` row so the dashboard renders a health dot inline without a
   * second call. Advisory + time-varying (backend caches ~10s, stale-while-revalidate).
   */
  health: CapabilityHealth;
}

/** One per-source row of the dedicated `GET /admin/api/health` report. */
export interface SourceHealthReport {
  id: string;
  label: string;
  status: HealthStatus;
  detail?: string;
  checkedAt?: string;
  capabilities: string[];
}

/** `GET /admin/api/health` — the per-source health report (parallel to `/sources`). */
export interface HealthResponse {
  sources: SourceHealthReport[];
  revision: number;
}

/** A source the detect scan found reachable on this machine (advisory, pre-fills the form). */
export interface DetectedSourceView {
  kind: string;
  suggested: {
    id: string;
    label: string;
    kind: string;
    transport: string;
    route?: Record<string, unknown>;
    secretRef?: string;
  };
  evidence: string;
  alreadyConfigured: boolean;
  reachable: boolean;
  needsSecret?: { name: string };
}

/**
 * The security surface of one extension capability, as projected by the preview/create
 * endpoints (`buildRegisterSurface`). Mirrors `PendingRegisterSurface.capabilities[]`.
 */
export interface ExtensionSurfaceCapability {
  id: string;
  label: string;
  kind: string;
  transport: string;
  verbs: string[];
}

/** The full "see what you're about to trust" surface returned by preview (and used by create). */
export interface ExtensionSurface {
  source: string;
  label: string;
  capabilities: ExtensionSurfaceCapability[];
  cliBins: string[];
  restHosts: string[];
  crossSource: { id: string; sources: string[] }[];
  transportBacked: boolean;
}

/** `POST /admin/api/extensions/preview` — validate + project the surface, NO commit. */
export interface ExtensionPreviewResponse {
  ok: boolean;
  valid: boolean;
  reasons: string[];
  surface: ExtensionSurface | null;
}

/** `POST /admin/api/extensions` — validate → register live → audited. */
export interface ExtensionCreateResponse {
  ok: boolean;
  source: string;
  registered: string[];
  revision: number;
  reason?: string;
}

/** One live extension-provenance source (`GET /admin/api/extensions`). */
export interface ExtensionListItem {
  source: string;
  label: string;
  capabilities: string[];
}

export interface ExtensionListResponse {
  extensions: ExtensionListItem[];
  revision: number;
}

/** `DELETE /admin/api/extensions/:source` — unregister + grant purge. */
export interface ExtensionRemoveResponse {
  ok: boolean;
  source: string;
  removed: string[];
}

/** One scanned local network interface address (`GET /admin/api/interfaces`). */
export interface NetworkInterfaceAddress {
  name: string;
  address: string;
  family: string;
  internal: boolean;
}

/** `GET /admin/api/network` — the persisted bind choice + what's actually bound. */
export interface NetworkConfigResponse {
  bindAddresses: string[];
  active: string[];
  boundPort: number;
}

/** `POST /admin/api/network` — persisted; takes effect on RESTART (restartRequired). */
export interface NetworkConfigResult {
  ok: boolean;
  bindAddresses: string[];
  restartRequired: boolean;
}

// ── Connect an agent (D2-CONSOLE / agent-skill-compile §5, ADR-8) ───────────────
/**
 * `POST /admin/api/agents/connect` — provision an agent: mint a one-time enrollment code
 * AND grant the requested cap-set as standing (execute/high-sensitivity caps can't stand —
 * they surface under `skipped`). `granted` = caps that became standing grants; `skipped` =
 * requested caps that did not. The `code` (+ enroll/handshake URLs) is the one-time
 * enrollment secret, delivered ONCE.
 */
export interface ConnectAgentBody {
  agentId: string;
  capabilities?: string[];
  agentType?: string;
  trustWindow?: TrustWindow;
  ttlMs?: number;
}
export interface ConnectAgentResult {
  ok: boolean;
  agentId: string;
  agentType?: string;
  code: string;
  expiresAt?: string;
  enrollUrl: string;
  handshakeUrl: string;
  granted: StandingGrant[];
  skipped: string[];
}

/** One file of the rendered Claude Code plugin artifact (`GET /integration/:agentId`). */
export interface IntegrationFile {
  path: string;
  mode: number;
  content: string;
}
/**
 * `GET /integration/:agentId` — the copy-able one-command install for a provisioned agent.
 * `installCommand` carries a FRESH one-time code (minted on this call) in an env var; the
 * durable PAT is never served. `files` is the rendered plugin, for the curious.
 */
export interface IntegrationResult {
  ok: boolean;
  agentId: string;
  /**
   * The delivery form. `claude-code` (or absent, legacy) → a compiled CC plugin (`dirName`,
   * `version`, `files`, `installCommand` carrying a code). `generic` → the portable shape:
   * a code-FREE `setupCommand`, the copy-able `instruction` text, and — when a code was
   * minted — a SEPARATE `enrollCommand` / `enrollCode` (delivered once, never in a served file).
   */
  agentType?: string;
  /** CC path only: the rendered plugin dir name. */
  dirName?: string;
  /** CC path only: the compiled plugin version (cache key). */
  version?: string;
  installCommand: string;
  /** CC path only: the rendered plugin files. */
  files?: IntegrationFile[];
  /** Generic path only: the code-free `curl … | bash` setup command. */
  setupCommand?: string;
  /** Generic path only: the filled-in AGENTS.plexus.md instruction text (copy-able). */
  instruction?: string;
  /** Generic path only: `plexus enroll <code>` — present only when a fresh code was minted. */
  enrollCommand?: string;
  /** Generic path only: the raw one-time code — present only when a fresh code was minted. */
  enrollCode?: string;
  capabilities: string[];
  /** Present only when this call minted a fresh one-time code (pending agent, or an explicit reissue). */
  codeExpiresAt?: string;
  /** True iff the agent already held a live PAT BEFORE this call (a re-view, not a first install). */
  alreadyEnrolled?: boolean;
  /** True iff this call explicitly minted a NEW code for an already-active agent — INVALIDATING its
   *  previous credential (it must re-install). Only ever set by the explicit reissue action. */
  reissued?: boolean;
}

/**
 * `POST /admin/api/agents/revoke` — make ALL of one agent's access die immediately:
 * tombstone its enrollment/PAT, invalidate its live sessions, and remove its standing
 * grants (+ revoke tokens). Only that agent is touched.
 */
export interface AgentRevokeResult {
  ok: boolean;
  agentId: string;
  enrollmentRevoked: boolean;
  sessionsInvalidated: number;
  grantsRemoved: number;
  revokedJtis: string[];
  auditId?: string;
}

/**
 * One agent's enrollment lifecycle row (`GET /admin/api/agents/enrollments`). SECRET-FREE
 * by contract — the gateway surfaces only the status + lifecycle timestamps, never the
 * persisted code/PAT hashes. `pending` = provisioned, awaiting install; `active` = enrolled
 * (redeemed a durable PAT); `revoked` = torn down.
 */
export interface AgentEnrollment {
  agentId: string;
  status: AgentEnrollmentStatus;
  issuedAt?: string;
  codeExpiresAt?: string;
  redeemedAt?: string;
  revokedAt?: string;
}

export interface AgentEnrollmentsResponse {
  agents: AgentEnrollment[];
}

export const api = {
  capabilities: () => getJson<CapabilitiesResponse>("/capabilities"),
  tokens: () => getJson<{ tokens: ActiveToken[] }>("/tokens"),
  audit: (limit = 200) => getJson<{ events: AuditEvent[] }>(`/audit?limit=${limit}`),
  /**
   * Issue a GRANT (ADR-018). `agentId` re-targets the grant onto a REAL agent so
   * its next request hits `hasPriorApproval` (decoy fix); `trustWindow` is the
   * authoritative human pick. Both optional — without them the legacy path applies.
   */
  issueGrants: (
    grants: Record<CapabilityId, GrantDecision | "allow" | "deny">,
    opts?: { agentId?: string; trustWindow?: TrustWindow },
  ) =>
    sendJson<GrantResponse>("/grants", "PUT", {
      grants,
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      ...(opts?.trustWindow ? { trustWindow: opts.trustWindow } : {}),
    }),
  revoke: (jti: string) => sendJson<RevokeResponse>("/revoke", "POST", { jti }),
  /** Revoke a standing GRANT by (agentId, capabilityId) — the complete stop (ADR-018). */
  revokeGrant: (agentId: string, capabilityId: string) =>
    sendJson<RevokeResponse>("/revoke", "POST", { agentId, capabilityId }),
  /** The standing-grant ledger (ALL grants, management-key gated). */
  grants: () => getJson<GrantsListResponse>("/grants"),
  // Task-bundle client surface — retained for the ADR-020 roadmap, no 1.0 UI surface (the
  // Task Grants console page is hidden; the backend mechanism stays). See docs/KNOWN-LIMITATIONS.md.
  /** Every task bundle (grouped standing grants + context) — AUTHZ-UX §2.N3. */
  bundles: () => getJson<BundlesResponse>("/bundles"),
  /** Admin one-shot bundle create — retained for ADR-020, no 1.0 surface. */
  createBundle: (body: CreateBundleBody) => sendJson<BundleView>("/bundles", "POST", body),
  /** Revoke a whole task bundle by id — retained for ADR-020, no 1.0 surface. */
  revokeBundle: (bundleId: string) => sendJson<RevokeResponse>("/revoke", "POST", { bundleId }),
  pending: () => getJson<{ pending: PendingItem[] }>("/pending"),
  /**
   * Resolve a pending item. On approve, `trustWindow` is the human's authoritative
   * pick and `agentId` optionally re-targets the resulting grant (decoy fix).
   */
  resolvePending: (
    id: string,
    action: "approve" | "deny",
    opts?: { reason?: string; trustWindow?: TrustWindow; agentId?: string },
  ) =>
    sendJson<{ ok: boolean; action: string; kind?: string; reason?: string }>(
      `/pending/${id}`,
      "POST",
      {
        action,
        ...(opts?.reason ? { reason: opts.reason } : {}),
        ...(opts?.trustWindow ? { trustWindow: opts.trustWindow } : {}),
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      },
    ),

  // ── Connect an agent (D2-CONSOLE) ───────────────────────────────────────────
  /**
   * Provision an agent: mint a one-time enrollment code + grant the cap-set as standing.
   * Returns the code + enroll/handshake URLs + which caps `granted`/`skipped`.
   */
  connectAgent: (body: ConnectAgentBody) =>
    sendJson<ConnectAgentResult>("/agents/connect", "POST", {
      agentId: body.agentId,
      ...(body.capabilities ? { capabilities: body.capabilities } : {}),
      ...(body.agentType ? { agentType: body.agentType } : {}),
      ...(body.trustWindow ? { trustWindow: body.trustWindow } : {}),
      ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    }),
  /**
   * Re-fetch the copy-able one-command install. Does NOT de-enroll an already-active agent (its
   * live PAT keeps working); pass `{ reissue: true }` for the explicit "re-issue a one-time code"
   * action, which resets the row + INVALIDATES the current credential (the agent must re-install).
   */
  integration: (agentId: string, opts: { reissue?: boolean } = {}) => getIntegration(agentId, opts),
  /**
   * Per-agent ENROLLMENT lifecycle (pending/active/revoked) — the dimension the Agents tab
   * merges onto its grants-derived rows to distinguish a provisioned-but-not-yet-enrolled
   * agent from a connected one. Secret-free (no code/PAT hashes).
   */
  agentEnrollments: () => getJson<AgentEnrollmentsResponse>("/agents/enrollments"),
  /** Revoke an agent completely — enrollment + live sessions + standing grants + tokens. */
  revokeAgent: (agentId: string) =>
    sendJson<AgentRevokeResult>("/agents/revoke", "POST", { agentId }),

  // ── Connector catalog ("what Plexus can connect to") ────────────────────────
  connectors: () =>
    getJson<{ connectors: ConnectorDescriptor[]; revision: number }>("/connectors"),

  // ── Exposure policy ("What I expose" — the owner's per-capability on/off) ────
  /**
   * Every live (and explicitly-disabled) capability + whether it is currently EXPOSED.
   * The outermost gate: effective access = granted ∧ exposed. Disabling makes a
   * capability invisible to all agents, ungrantable, and uninvokable.
   */
  getExposure: () => getJson<ExposureResponse>("/exposure"),
  /** Toggle one capability's top-level exposure. Bumps the manifest revision (agents re-fetch). */
  setExposure: (id: string, enabled: boolean) =>
    sendJson<ExposureSetResponse>(`/exposure/${encodeURIComponent(id)}`, "POST", { enabled }),

  // ── Source settings (machine-level knobs; v1 = exec real-launch) ───────────
  /** The exec-class sources' real-launch state (effective + provenance: setting vs env). */
  sourceSettings: () =>
    getJson<{
      sources: {
        sourceId: string;
        realLaunch: boolean;
        persisted: boolean | null;
        envFallback: string;
        envActive: boolean;
      }[];
    }>("/source-settings"),
  /** Set (true/false) or clear (null → env/default) one source's real-launch knob. Audited. */
  setSourceRealLaunch: (sourceId: string, realLaunch: boolean | null) =>
    sendJson<{ ok: boolean; sourceId: string; realLaunch: boolean; persisted: boolean | null }>(
      `/source-settings/${encodeURIComponent(sourceId)}`,
      "PUT",
      { realLaunch },
    ),

  // ── Managed sources (msrc-t2) ───────────────────────────────────────────────
  sources: () => getJson<{ sources: SourceView[]; revision: number }>("/sources"),
  /** The dedicated per-source health report (HEALTH). The ExposeTab prefers the inline
   *  `SourceView.health` on `/sources`; this is here for a focused health view if useful. */
  health: () => getJson<HealthResponse>("/health"),
  detectSources: () => getJson<{ detected: DetectedSourceView[] }>("/sources/detect"),
  addSource: (cfg: ConfiguredSource) => sendJson<AddResult>("/sources", "POST", cfg),
  enable: (id: string) => sendJson<AddResult>(`/sources/${encodeURIComponent(id)}/enable`, "POST", {}),
  disable: (id: string) =>
    sendJson<{ ok: boolean }>(`/sources/${encodeURIComponent(id)}/disable`, "POST", {}),
  reconfigure: (id: string, patch: Partial<ConfiguredSource>) =>
    sendJson<AddResult>(`/sources/${encodeURIComponent(id)}/reconfigure`, "POST", patch),
  removeSource: (id: string) =>
    sendJson<{ ok: boolean }>(`/sources/${encodeURIComponent(id)}`, "DELETE", {}),
  /** WRITE-ONLY — store an API key by name; the response never echoes the value. */
  putSecret: (name: string, value: string) =>
    sendJson<{ ok: boolean; name: string }>(`/secrets/${encodeURIComponent(name)}`, "POST", {
      value,
    }),
  /**
   * P1b onboarding — materialize the demo directory (~/PlexusDemo by default) and
   * expose it as the two demo sources: `demo-intro` (open reads) + `your-secret`
   * (Protected — approval:"ask"). Idempotent on the gateway side.
   */
  demoWorkspace: (path?: string) =>
    // Tolerate 422 (partial/failed setup) so the caller reads `res.reason` from the
    // `{ ok:false }` envelope instead of a thrown raw-status Error (B1).
    sendJson<DemoWorkspaceResult>("/demo-workspace", "POST", path ? { path } : {}, [422]),

  // ── Extensions (FEAT-CREATE-EXTENSION) ──────────────────────────────────────
  /** Validate + project the security surface WITHOUT committing — the "see what you trust" step. */
  previewExtension: (manifest: ExtensionManifest) =>
    sendJson<ExtensionPreviewResponse>("/extensions/preview", "POST", { manifest }),
  /** Validate → register LIVE (human-approved commit) → audited. */
  createExtension: (manifest: ExtensionManifest) =>
    sendJson<ExtensionCreateResponse>("/extensions", "POST", { manifest }),
  /** Live extension-provenance sources + their contributed capability ids. */
  extensions: () => getJson<ExtensionListResponse>("/extensions"),
  /** Unregister a live extension source + purge its grants. */
  removeExtension: (source: string) =>
    sendJson<ExtensionRemoveResponse>(`/extensions/${encodeURIComponent(source)}`, "DELETE", {}),
  /** The agent-facing markdown authoring guide (management-key gated). */
  authoringGuide: () => getText("/extensions/authoring-guide"),

  // ── Network binding (FEAT configurable-binding) ─────────────────────────────
  /** Scan the machine's network interfaces (to choose which to bind). */
  interfaces: () => getJson<{ interfaces: NetworkInterfaceAddress[] }>("/interfaces"),
  /** The current bind config + what's actually bound + the port. */
  network: () => getJson<NetworkConfigResponse>("/network"),
  /** Persist a chosen bind-address set. Takes effect on RESTART (restartRequired). */
  setNetwork: (bindAddresses: string[]) =>
    sendJson<NetworkConfigResult>("/network", "POST", { bindAddresses }),
};

export type {
  CapabilityEntry,
  GatewayInfo,
  GrantResponse,
  AuditEvent,
  ConfiguredSource,
  AddResult,
  ConnectorDescriptor,
  ConnectorConfigField,
  StandingGrant,
  TrustWindow,
  Provenance,
  Sensitivity,
  PendingNarration,
  ScopeConstraint,
  BundleView,
  GrantVerb,
  ExtensionManifest,
  ExtensionCapabilityDecl,
  CapabilityHealth,
  HealthStatus,
};
