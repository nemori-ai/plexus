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
  PlexusEvent,
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
 *
 * `as` is the DELIVERY-FORM projection override (`claude-code` | `generic` | `in-context`): it
 * re-projects an already-provisioned agent into a different delivery form and PERSISTS that choice
 * WITHOUT minting a code, re-granting, or writing audit — a pure display switch, not a
 * re-authorization. The returned response carries NO fresh code (the caller keeps the code it
 * already holds; it is form-agnostic). `as` and `reissue` are mutually exclusive.
 */
async function getIntegration(
  agentId: string,
  opts: { reissue?: boolean; as?: string } = {},
): Promise<IntegrationResult> {
  const key = await managementKey();
  const query = opts.as
    ? `?as=${encodeURIComponent(opts.as)}`
    : opts.reissue
    ? "?reissue=1"
    : "";
  const path = `/integration/${encodeURIComponent(agentId)}${query}`;
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
  /**
   * The owner's `default-grant` flag (authorized-subset §3.1): pre-check this capability
   * in the connect wizard. Orthogonal to `enabled`; a UI default only, never a runtime grant.
   */
  defaultGrant: boolean;
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
  /** Execute caps opted into a STANDING grant for this agent (ADR-023). Subset of `capabilities`. */
  standingExecute?: string[];
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
   * `in-context` → the HTTP-only shape: a code-FREE `instruction` TEXT + `enrollHint`, and — when
   * a code was minted — a SEPARATE `enrollCode` (delivered once here; never in the instruction).
   * No install/setup command and no served file exist for in-context.
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
  /**
   * Form-AGNOSTIC manual walkthrough (DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE) — returned on
   * ALL three delivery forms (cc / generic / in-context) so the "Manual + skill" tab is form-agnostic.
   * Code-free + key-free (the one-time code rides `enrollCode`). Absent only on an older backend.
   */
  manual?: string;
  /** Generic path only: `plexus enroll <code>` — present only when a fresh code was minted. */
  enrollCommand?: string;
  /** Generic + in-context paths: the raw one-time code — present only when a fresh code was minted. */
  enrollCode?: string;
  /** In-context path only: a one-line hint on how to hand off the instruction + code to the agent. */
  enrollHint?: string;
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
  /** Present only for a "revoke & delete": true iff the enrollment row was removed
   *  from the roster entirely (not just tombstoned). */
  deleted?: boolean;
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

// ── MANAGEMENT event stream (GET /v1/events) — the Realtime view's live feed ──
/** Handlers for the management SSE subscription (`subscribeV1Events`). */
export interface EventStreamHandlers {
  /** One decoded `PlexusEvent` (audit_appended / pending_added / pending_resolved / …). */
  onEvent: (event: PlexusEvent) => void;
  /** The stream connected (or reconnected) cleanly. `reconnect` is false only on the first open. */
  onOpen?: (info: { reconnect: boolean }) => void;
  /** A transient connect/read error — the subscription WILL retry with backoff. */
  onError?: (err: unknown) => void;
  /**
   * The management key was missing or rejected (401). The subscription STOPS retrying —
   * an infinite auth-retry loop would re-trigger the key prompt every backoff cycle (B5).
   * The host surfaces this ONCE and offers an explicit reconnect (re-subscribe).
   */
  onAuthError?: (err: unknown) => void;
}

/** A parse failure that must not be swallowed as a network error (kept separate for C2). */
class FrameParseError extends Error {}

/**
 * Subscribe to the MANAGEMENT SSE stream `GET /v1/events` (v1.ts, §2.3). A browser
 * `EventSource` CANNOT attach the `X-Plexus-Connection-Key` header the route requires,
 * so we open the stream with `fetch` (header attached) and read it via
 * `response.body.getReader()`, parsing SSE frames (`data:` lines, blank-line delimited)
 * by hand. Auto-reconnects with capped exponential backoff until the returned
 * unsubscribe fn is called; an AUTH failure (401 / no key) stops instead of looping.
 * Same out-of-band management key the gated admin calls use.
 */
export function subscribeV1Events(handlers: EventStreamHandlers): () => void {
  let closed = false;
  let controller: AbortController | null = null;
  let backoff = 500;
  let opens = 0;
  const MIN_BACKOFF = 500;
  const MAX_BACKOFF = 15000;
  // Reset backoff only after a connection has SURVIVED this long (B4) — otherwise a server
  // that accepts then immediately closes the stream would trigger a ~2 req/s reconnect storm.
  const ALIVE_RESET_MS = 3000;

  const schedule = () => {
    if (closed) return;
    const wait = backoff;
    backoff = Math.min(MAX_BACKOFF, Math.round(backoff * 1.7));
    setTimeout(() => void connect(), wait);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    controller = new AbortController();
    let key: string;
    try {
      key = await managementKey();
    } catch (e) {
      // No key resolvable — an AUTH failure, not a transient network error. Stop looping (B5).
      if (!closed) handlers.onAuthError?.(e);
      return;
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let openedAt = 0;
    try {
      const res = await fetch("/v1/events", {
        headers: { "X-Plexus-Connection-Key": key, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (res.status === 401) {
        handleUnauthorized();
        // Stale/rejected key — surface once and STOP (B5); the host offers explicit reconnect.
        if (!closed) handlers.onAuthError?.(new Error("/v1/events → 401"));
        return;
      }
      if (!res.ok || !res.body) throw new Error(`/v1/events → ${res.status}`);
      openedAt = Date.now();
      handlers.onOpen?.({ reconnect: opens > 0 });
      opens++;
      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // SSE frames are separated by a blank line; a frame may carry multiple `data:` lines.
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLines = raw
            .split("\n")
            .map((l) => l.replace(/\r$/, ""))
            .filter((l) => l.startsWith("data:"));
          if (dataLines.length === 0) continue; // comment / heartbeat frame
          const json = dataLines.map((l) => l.slice(5).trim()).join("\n");
          // C2: parse and dispatch are SEPARATE — a throw inside onEvent (a React state
          // update) must NOT be misread as a "malformed frame" and silently drop events.
          let parsed: PlexusEvent;
          try {
            parsed = JSON.parse(json) as PlexusEvent;
          } catch {
            continue; // genuinely malformed frame — skip it
          }
          try {
            handlers.onEvent(parsed);
          } catch (e) {
            throw new FrameParseError(String(e)); // surface a real handler crash, don't swallow
          }
        }
      }
      throw new Error("/v1/events stream ended");
    } catch (e) {
      if (closed || controller?.signal.aborted) return;
      handlers.onError?.(e);
      // Reset the backoff only if the connection was alive long enough to count as healthy (B4).
      if (openedAt && Date.now() - openedAt >= ALIVE_RESET_MS) backoff = MIN_BACKOFF;
      schedule();
    } finally {
      // C1: always release the reader lock so an abandoned stream can't wedge the body.
      if (reader) {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
      }
    }
  };

  void connect();
  return () => {
    closed = true;
    try {
      controller?.abort();
    } catch {
      /* already closed */
    }
  };
}

export const api = {
  capabilities: () => getJson<CapabilitiesResponse>("/capabilities"),
  tokens: () => getJson<{ tokens: ActiveToken[] }>("/tokens"),
  audit: (limit = 200) => getJson<{ events: AuditEvent[] }>(`/audit?limit=${limit}`),
  /** One audit event's full detail (params + result), fetched on demand for a row. */
  auditEvent: (id: string) => getJson<{ event: AuditEvent }>(`/audit/${encodeURIComponent(id)}`),
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
      // The standing-execute opt-ins (ADR-023) MUST ride through — dropping them silently kept
      // an opted execute per-use, so the agent still pended (the "I allowed it but it still
      // asks me to approve" bug).
      ...(body.standingExecute && body.standingExecute.length ? { standingExecute: body.standingExecute } : {}),
      ...(body.agentType ? { agentType: body.agentType } : {}),
      ...(body.trustWindow ? { trustWindow: body.trustWindow } : {}),
      ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    }),
  /**
   * Re-fetch the copy-able one-command install. Does NOT de-enroll an already-active agent (its
   * live PAT keeps working); pass `{ reissue: true }` for the explicit "re-issue a one-time code"
   * action, which resets the row + INVALIDATES the current credential (the agent must re-install).
   */
  integration: (agentId: string, opts: { reissue?: boolean; as?: string } = {}) =>
    getIntegration(agentId, opts),
  /**
   * Per-agent ENROLLMENT lifecycle (pending/active/revoked) — the dimension the Agents tab
   * merges onto its grants-derived rows to distinguish a provisioned-but-not-yet-enrolled
   * agent from a connected one. Secret-free (no code/PAT hashes).
   */
  agentEnrollments: () => getJson<AgentEnrollmentsResponse>("/agents/enrollments"),
  /**
   * An agent's CURRENT authorized subset (authorized-subset §3.2) — for RE-CONNECT: the wizard
   * pre-checks these so re-connecting edits the full set instead of silently narrowing it.
   * Derives from live standing grants for a legacy agent with no subset record.
   */
  agentSubset: (agentId: string) =>
    getJson<{ agentId: string; capabilities: string[]; standingExecute: string[] }>(
      `/agents/${encodeURIComponent(agentId)}/subset`,
    ),
  /** Revoke an agent completely — enrollment + live sessions + standing grants + tokens. */
  revokeAgent: (agentId: string, opts?: { delete?: boolean }) =>
    sendJson<AgentRevokeResult>("/agents/revoke", "POST", {
      agentId,
      ...(opts?.delete ? { delete: true } : {}),
    }),

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
  /**
   * Toggle a capability's `default-grant` flag (authorized-subset §3.1) — whether it is
   * pre-checked in the connect wizard. Changes no already-connected agent; grants nothing.
   */
  setDefaultGrant: (id: string, defaultGrant: boolean) =>
    sendJson<{ ok: boolean; id: string; defaultGrant: boolean }>(
      `/default-grant/${encodeURIComponent(id)}`,
      "POST",
      { defaultGrant },
    ),

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
        /** The EFFECTIVE sandbox jail root (persisted setting > env > default). */
        authorizedDir: string;
        /** The persisted override, or null when falling back to env/default. */
        authorizedDirPersisted: string | null;
        /** The built-in default (`~/.plexus/workspace/<source>`). */
        authorizedDirDefault: string;
      }[];
    }>("/source-settings"),
  /** Set (true/false) or clear (null → env/default) one source's real-launch knob. Audited. */
  setSourceRealLaunch: (sourceId: string, realLaunch: boolean | null) =>
    sendJson<{ ok: boolean; sourceId: string; realLaunch: boolean; persisted: boolean | null }>(
      `/source-settings/${encodeURIComponent(sourceId)}`,
      "PUT",
      { realLaunch },
    ),
  /**
   * Set (absolute path) or clear (null → env/default) one source's authorized directory
   * — the sandbox jail root the tool is confined to. Audited.
   */
  setSourceAuthorizedDir: (sourceId: string, authorizedDir: string | null) =>
    sendJson<{
      ok: boolean;
      sourceId: string;
      authorizedDir: string;
      authorizedDirPersisted: string | null;
      authorizedDirDefault: string;
    }>(`/source-settings/${encodeURIComponent(sourceId)}`, "PUT", { authorizedDir }),

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
