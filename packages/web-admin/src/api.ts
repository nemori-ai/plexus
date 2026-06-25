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
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.text();
}

async function sendJson<T>(path: string, method: string, body: unknown): Promise<T> {
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
  if (!res.ok) {
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

/** The persisted cc-master launch-profile config (the loadCcMaster gate). */
export interface CcMasterConfig {
  version: 1;
  loadCcMaster: boolean;
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

export const api = {
  /**
   * The management connection-key, resolved OUT OF BAND (desktop IPC → cached →
   * human paste) — NEVER fetched over HTTP (F2). Used by the admin page to DISPLAY
   * the key for paste-into-an-agent; the trusted admin world may hold it freely.
   */
  connectionKey: async (): Promise<{ connectionKey: string }> => ({
    connectionKey: await managementKey(),
  }),
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
  /** Every task bundle (grouped standing grants + context) — AUTHZ-UX §2.N3. */
  bundles: () => getJson<BundlesResponse>("/bundles"),
  /** Admin one-shot bundle create (the "New task grant" composer) — D4 primary path. */
  createBundle: (body: CreateBundleBody) => sendJson<BundleView>("/bundles", "POST", body),
  /** Revoke a whole task bundle (members + tokens + context) by id — AUTHZ-UX §2.N3. */
  revokeBundle: (bundleId: string) => sendJson<RevokeResponse>("/revoke", "POST", { bundleId }),
  /** The cc-master launch-profile gate (loadCcMaster). */
  ccMasterConfig: () => getJson<{ config: CcMasterConfig }>("/cc-master/config"),
  /** Persist the loadCcMaster gate — re-gates the orchestration capabilities. */
  setCcMasterConfig: (loadCcMaster: boolean) =>
    sendJson<{ ok: boolean; config: CcMasterConfig }>("/cc-master/config", "POST", { loadCcMaster }),
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

  // ── Connector catalog ("what Plexus can connect to") ────────────────────────
  connectors: () =>
    getJson<{ connectors: ConnectorDescriptor[]; revision: number }>("/connectors"),

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
