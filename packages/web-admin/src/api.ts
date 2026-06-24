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
 * The management connection-key — required by every MUTATING admin route (the
 * gateway now verifies `X-Plexus-Connection-Key`, not just the loopback Host). The
 * SPA is served same-origin by the gateway, so it reads the key from the
 * loopback-only `GET /admin/api/connection-key` once and caches it for the session.
 * Read-only GETs do not send it (they stay loopback-only).
 */
let cachedKey: string | null = null;
let cachedKeyInflight: Promise<string> | null = null;
async function managementKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  if (!cachedKeyInflight) {
    cachedKeyInflight = fetch(`${BASE}/connection-key`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`/connection-key → ${res.status}`);
        const body = (await res.json()) as { connectionKey: string };
        cachedKey = body.connectionKey;
        return cachedKey;
      })
      .finally(() => {
        cachedKeyInflight = null;
      });
  }
  return cachedKeyInflight;
}

async function getJson<T>(path: string): Promise<T> {
  // Most admin reads are loopback-only, but some (GET /api/grants, /api/bundles) are
  // management-key gated — and the SPA can't tell which a given path is. So attach the
  // verified connection-key on EVERY read too (harmless on loopback-only routes; required
  // for the gated ones). Same key the mutating `sendJson` uses; cached after the first
  // `/connection-key` bootstrap (which `managementKey` fetches raw, so no recursion).
  const key = await managementKey();
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json", "X-Plexus-Connection-Key": key },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
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

export interface InstallResult {
  ok: boolean;
  available: boolean;
  installed?: string;
  reason?: string;
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

export const api = {
  connectionKey: () => getJson<{ connectionKey: string }>("/connection-key"),
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
  installCcMaster: () => sendJson<InstallResult>("/install-cc-master", "POST", {}),
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
};
