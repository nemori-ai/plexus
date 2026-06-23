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
} from "../../src/protocol/index.ts";
import type {
  ConfiguredSource,
  AddResult,
} from "../../src/sources/config/types.ts";

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
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
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
  scopes: { id: string; verbs: string[]; synthesizedFor?: string }[];
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
  scopes?: { id: string; verbs: string[]; synthesizedFor?: string }[];
  reasons?: string[];
  register?: PendingRegisterSurface;
}

/** A configured managed source joined with its live registry status. */
export interface SourceView extends ConfiguredSource {
  live: boolean;
  liveCapabilityCount: number;
}

export const api = {
  connectionKey: () => getJson<{ connectionKey: string }>("/connection-key"),
  capabilities: () => getJson<CapabilitiesResponse>("/capabilities"),
  tokens: () => getJson<{ tokens: ActiveToken[] }>("/tokens"),
  audit: (limit = 200) => getJson<{ events: AuditEvent[] }>(`/audit?limit=${limit}`),
  issueGrants: (grants: Record<CapabilityId, GrantDecision | "allow" | "deny">) =>
    sendJson<GrantResponse>("/grants", "PUT", { grants }),
  revoke: (jti: string) => sendJson<RevokeResponse>("/revoke", "POST", { jti }),
  installCcMaster: () => sendJson<InstallResult>("/install-cc-master", "POST", {}),
  pending: () => getJson<{ pending: PendingItem[] }>("/pending"),
  resolvePending: (id: string, action: "approve" | "deny", reason?: string) =>
    sendJson<{ ok: boolean; action: string; kind?: string; reason?: string }>(
      `/pending/${id}`,
      "POST",
      { action, ...(reason ? { reason } : {}) },
    ),

  // ── Managed sources (msrc-t2) ───────────────────────────────────────────────
  sources: () => getJson<{ sources: SourceView[]; revision: number }>("/sources"),
  detectSources: () => getJson<{ detected: unknown[] }>("/sources/detect"),
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

export type { CapabilityEntry, GatewayInfo, GrantResponse, AuditEvent, ConfiguredSource, AddResult };
