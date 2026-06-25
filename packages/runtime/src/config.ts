/**
 * Gateway runtime configuration. Loopback-only bind, default port 7077.
 * Pure data + helpers; no business logic.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { PLEXUS_PROTOCOL_VERSION } from "@plexus/protocol";
import type { TrustWindowKind } from "@plexus/protocol";
import { homePath, readFileBestEffort, atomicWrite } from "./core/paths.ts";

/**
 * The SOFTWARE / product version — the gateway + desktop app RELEASE version,
 * shown in the admin UI as "running · v<this>". Keep in lockstep with the
 * workspace `package.json` versions.
 *
 * SOFTWARE version vs PROTOCOL version are DECOUPLED by design — they answer
 * different questions and move on different clocks:
 *   • PLEXUS_VERSION (this)            = the PRODUCT release. Moves fast: every
 *     feature/fix/UI change bumps it (0.6 → 0.7 → 1.0 …). It is informational —
 *     nothing on the wire depends on it.
 *   • PLEXUS_PROTOCOL_VERSION ("0.1.2")= the agent-facing WIRE CONTRACT. Frozen
 *     and ADDITIVE-ONLY; it bumps RARELY (only when the self-describe / handshake
 *     / grant / invoke shapes gain a backward-compatible field). AGENTS integrate
 *     against THIS, never the software version.
 * So the app can ship many releases while the protocol stays 0.1.x — a stable
 * wire under a fast-moving product. The admin UI shows both, distinctly.
 */
export const PLEXUS_VERSION = "0.6.0-rc.1";

/** Self-describe protocol version advertised in `.well-known` (e.g. "0.1"). */
export const PLEXUS_PROTOCOL = PLEXUS_PROTOCOL_VERSION.split(".").slice(0, 2).join(".");

// ── Auth config defaults + clamps (ADR-018) ──────────────────────────────────

/** Fallback default scoped-token lifetime — 15 min (ADR-006). */
export const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
/** Clamp floor for a configured token lifetime — short token = security invariant. */
export const TOKEN_LIFETIME_MIN_MS = 60_000; // 1 min
/** Clamp ceiling for a configured token lifetime. */
export const TOKEN_LIFETIME_MAX_MS = 3_600_000; // 60 min
/** Default 30-day cap on a `custom` trust-window (the `until-revoked` sentinel is NOT capped by this). */
export const DEFAULT_MAX_TRUST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A `${provenance}:${read|write}` key into the default trust-window table. */
export type TrustWindowClassKey =
  | "first-party:read"
  | "first-party:write"
  | "managed:read"
  | "managed:write"
  | "extension:read"
  | "extension:write";

/** The default-trust-window table by class+verb (the user-ratified D-window table). */
export type DefaultTrustWindows = Record<TrustWindowClassKey, TrustWindowKind>;

/** The ratified contextual defaults (read 7d/7d/1d; write 1d/1d/once). */
export const DEFAULT_TRUST_WINDOWS: DefaultTrustWindows = {
  "first-party:read": "7d",
  "first-party:write": "1d",
  "managed:read": "7d",
  "managed:write": "1d",
  "extension:read": "1d",
  "extension:write": "once",
};

/**
 * The unified-trust-model config block (ADR-018). Holds the DEFAULTS and BOUNDS;
 * the per-approval chosen window lives per-grant. Loaded from
 * `~/.plexus/auth-config.json` (all fields optional) with the clamps below.
 */
export interface AuthConfig {
  /** Scoped-token lifetime (ms). CLAMPED to [TOKEN_LIFETIME_MIN_MS, TOKEN_LIFETIME_MAX_MS]. */
  readonly tokenLifetimeMs: number;
  /** Cap on a `custom` trust-window (ms). The `until-revoked` sentinel is NOT clamped by this. */
  readonly maxTrustWindowMs: number;
  /** Whether the `until-revoked` window kind is offered at all. */
  readonly allowUntilRevoked: boolean;
  /** Default trust-window by `${provenance}:${read|write}`. */
  readonly defaultTrustWindows: DefaultTrustWindows;
}

export interface GatewayConfig {
  /**
   * The PRIMARY loopback host used to build the advertised base URL + the
   * `expectedHost` the Host guard always accepts. ALWAYS a loopback literal
   * (`127.0.0.1`) — opening the gateway to the LAN is expressed via
   * `bindAddresses`, NEVER by changing this. Kept as the canonical self-URL.
   */
  readonly host: "127.0.0.1";
  /**
   * The set of interface addresses the gateway BINDS its listener to (FEAT
   * configurable-binding). DEFAULT `["127.0.0.1"]` = today's loopback-only
   * behavior, exactly. May ALSO include user-selected interface IPs, or the
   * single sentinel `"0.0.0.0"` to bind all IPv4 interfaces. Loaded from
   * `~/.plexus/network.json`; loopback is always implied/accepted by the guard.
   */
  readonly bindAddresses: readonly string[];
  /** Bound port. */
  readonly port: number;
  /** Optional friendly instance name set by the user. */
  readonly instance?: string;
  /** The unified-trust-model config block (ADR-018). */
  readonly auth: AuthConfig;
}

const DEFAULT_PORT = 7077;

const AUTH_CONFIG_FILE = "auth-config.json";

/** The `~/.plexus/network.json` file persisting the user's chosen bind addresses. */
const NETWORK_CONFIG_FILE = "network.json";

/** The loopback-only default — identical to the gateway's historical behavior. */
export const DEFAULT_BIND_ADDRESSES: readonly string[] = ["127.0.0.1"];

/** The IPv4 loopback literal the gateway always binds + the guard always accepts. */
export const LOOPBACK_BIND_ADDRESS = "127.0.0.1";

/** The "bind every IPv4 interface" sentinel (only valid as a sole bind address). */
export const BIND_ALL_IPV4 = "0.0.0.0";

const VALID_WINDOW_KINDS: ReadonlySet<string> = new Set<string>([
  "once",
  "1h",
  "1d",
  "7d",
  "until-revoked",
  "custom",
]);

/** Clamp `n` into `[lo, hi]`; fall back to `def` when `n` is not a finite number. */
function clampNumber(n: unknown, lo: number, hi: number, def: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return def;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Load + clamp the auth config from `~/.plexus/auth-config.json` (ADR-018). The
 * file is OPTIONAL and every field is optional; missing/invalid values fall back
 * to the ratified defaults. `tokenLifetimeMs` is clamped to [1m, 60m];
 * `maxTrustWindowMs` floors at one day; the default-window table is merged on top
 * of `DEFAULT_TRUST_WINDOWS` (only valid kinds are accepted).
 */
export function loadAuthConfig(): AuthConfig {
  let parsed: Record<string, unknown> = {};
  const raw = readFileBestEffort(homePath(AUTH_CONFIG_FILE));
  if (raw) {
    try {
      const obj = JSON.parse(raw) as unknown;
      if (obj && typeof obj === "object") parsed = obj as Record<string, unknown>;
    } catch {
      /* corrupt file — fall back entirely to defaults */
    }
  }

  const defaults: DefaultTrustWindows = { ...DEFAULT_TRUST_WINDOWS };
  const table = parsed.defaultTrustWindows;
  if (table && typeof table === "object") {
    for (const key of Object.keys(defaults) as TrustWindowClassKey[]) {
      const v = (table as Record<string, unknown>)[key];
      if (typeof v === "string" && VALID_WINDOW_KINDS.has(v)) {
        defaults[key] = v as TrustWindowKind;
      }
    }
  }

  return {
    tokenLifetimeMs: clampNumber(
      parsed.tokenLifetimeMs,
      TOKEN_LIFETIME_MIN_MS,
      TOKEN_LIFETIME_MAX_MS,
      DEFAULT_TOKEN_LIFETIME_MS,
    ),
    maxTrustWindowMs: clampNumber(
      parsed.maxTrustWindowMs,
      24 * 60 * 60 * 1000,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_TRUST_WINDOW_MS,
    ),
    allowUntilRevoked: typeof parsed.allowUntilRevoked === "boolean" ? parsed.allowUntilRevoked : true,
    defaultTrustWindows: defaults,
  };
}

/**
 * The writable subset of the auth-config (LRA `PUT /v1/config`, REDESIGN §2.2).
 * Every field optional + partial — a patch merges over the persisted file. Values
 * are validated/clamped on write by `writeAuthConfig` (NEVER trusted raw).
 */
export interface AuthConfigPatch {
  tokenLifetimeMs?: number;
  maxTrustWindowMs?: number;
  allowUntilRevoked?: boolean;
  defaultTrustWindows?: Partial<DefaultTrustWindows>;
}

/**
 * Persist a validated/clamped patch to `~/.plexus/auth-config.json` (LRA
 * `PUT /v1/config`). Reads the current persisted file, merges the supplied fields
 * (clamping `tokenLifetimeMs`/`maxTrustWindowMs`, accepting only VALID window kinds
 * for the table), atomic-writes the merged JSON, and returns the resulting effective
 * `AuthConfig`. Unknown/invalid fields are ignored (fail-safe, never throws on input).
 */
export function writeAuthConfig(patch: AuthConfigPatch): AuthConfig {
  // Start from the current persisted-on-disk shape (so unspecified fields survive).
  let onDisk: Record<string, unknown> = {};
  const raw = readFileBestEffort(homePath(AUTH_CONFIG_FILE));
  if (raw) {
    try {
      const obj = JSON.parse(raw) as unknown;
      if (obj && typeof obj === "object") onDisk = obj as Record<string, unknown>;
    } catch {
      /* corrupt file → start clean */
    }
  }

  const next: Record<string, unknown> = { ...onDisk };

  if (patch && typeof patch === "object") {
    if (patch.tokenLifetimeMs !== undefined) {
      next.tokenLifetimeMs = clampNumber(
        patch.tokenLifetimeMs,
        TOKEN_LIFETIME_MIN_MS,
        TOKEN_LIFETIME_MAX_MS,
        DEFAULT_TOKEN_LIFETIME_MS,
      );
    }
    if (patch.maxTrustWindowMs !== undefined) {
      next.maxTrustWindowMs = clampNumber(
        patch.maxTrustWindowMs,
        24 * 60 * 60 * 1000,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_MAX_TRUST_WINDOW_MS,
      );
    }
    if (typeof patch.allowUntilRevoked === "boolean") {
      next.allowUntilRevoked = patch.allowUntilRevoked;
    }
    if (patch.defaultTrustWindows && typeof patch.defaultTrustWindows === "object") {
      const table = (typeof next.defaultTrustWindows === "object" && next.defaultTrustWindows
        ? { ...(next.defaultTrustWindows as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      for (const key of Object.keys(DEFAULT_TRUST_WINDOWS) as TrustWindowClassKey[]) {
        const v = patch.defaultTrustWindows[key];
        if (typeof v === "string" && VALID_WINDOW_KINDS.has(v)) {
          table[key] = v;
        }
      }
      next.defaultTrustWindows = table;
    }
  }

  try {
    atomicWrite(homePath(AUTH_CONFIG_FILE), JSON.stringify(next, null, 2) + "\n");
  } catch {
    /* best-effort durability — the returned effective config still reflects the merge */
  }

  // Re-load through the canonical clamp path so the returned shape is authoritative.
  return loadAuthConfig();
}

// ── Network bind config (FEAT configurable-binding) ──────────────────────────

/** A scanned local network interface address (from `os.networkInterfaces()`). */
export interface NetworkInterfaceAddress {
  /** The interface name (e.g. "en0", "lo0"). */
  readonly name: string;
  /** The address (IPv4 or IPv6, without a CIDR suffix). */
  readonly address: string;
  /** "IPv4" | "IPv6". */
  readonly family: string;
  /** True for loopback / link-local internal interfaces. */
  readonly internal: boolean;
}

/**
 * Scan the machine's network interfaces (IPv4 + IPv6). This is the source of
 * truth for which addresses a user may legitimately bind to — `validateBindAddresses`
 * checks chosen non-loopback IPs against this list so a request can never bind (or
 * the guard accept) an address that isn't actually a local interface.
 */
export function scanNetworkInterfaces(): NetworkInterfaceAddress[] {
  const out: NetworkInterfaceAddress[] = [];
  const nics = networkInterfaces();
  for (const [name, addrs] of Object.entries(nics) as [string, NetworkInterfaceInfo[] | undefined][]) {
    if (!addrs) continue;
    for (const a of addrs) {
      // Node ≥18 typings report `family` as the string "IPv4"/"IPv6"; older runtimes
      // emitted the number 4/6. Normalize defensively to the "IPv4"/"IPv6" string.
      const rawFamily = a.family as unknown;
      const family = typeof rawFamily === "number" ? `IPv${rawFamily}` : String(rawFamily);
      out.push({ name, address: a.address, family, internal: Boolean(a.internal) });
    }
  }
  return out;
}

/** True for the two recognized loopback bind literals. */
function isLoopbackBindLiteral(addr: string): boolean {
  return addr === LOOPBACK_BIND_ADDRESS || addr === "::1";
}

/** The set of real local interface addresses (for validating a chosen IP). */
function localInterfaceAddressSet(): Set<string> {
  return new Set(scanNetworkInterfaces().map((i) => i.address));
}

/**
 * Validate + normalize a requested bind-address list (SECURITY-CRITICAL). Each
 * entry must be: a loopback literal (`127.0.0.1` / `::1`), the `0.0.0.0`
 * bind-all sentinel, OR an address that is ACTUALLY one of this machine's
 * interfaces (per `scanNetworkInterfaces`). `0.0.0.0`, when chosen, must be the
 * SOLE entry (mixing it with specific IPs is meaningless + ambiguous). Empty /
 * all-invalid input falls back to the loopback-only default (fail-safe). De-dupes.
 * Returns `{ ok, bindAddresses, rejected }`.
 */
export function validateBindAddresses(
  requested: readonly string[],
  localAddresses?: ReadonlySet<string>,
): { ok: boolean; bindAddresses: string[]; rejected: string[] } {
  const local = localAddresses ?? localInterfaceAddressSet();
  if (!Array.isArray(requested)) {
    return { ok: false, bindAddresses: [...DEFAULT_BIND_ADDRESSES], rejected: [] };
  }
  const cleaned = requested
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  // 0.0.0.0 must be the sole entry.
  if (cleaned.includes(BIND_ALL_IPV4)) {
    if (cleaned.some((a) => a !== BIND_ALL_IPV4)) {
      return {
        ok: false,
        bindAddresses: [...DEFAULT_BIND_ADDRESSES],
        rejected: cleaned.filter((a) => a !== BIND_ALL_IPV4),
      };
    }
    return { ok: true, bindAddresses: [BIND_ALL_IPV4], rejected: [] };
  }

  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const addr of cleaned) {
    if (isLoopbackBindLiteral(addr) || local.has(addr)) {
      if (!accepted.includes(addr)) accepted.push(addr);
    } else {
      rejected.push(addr);
    }
  }
  if (accepted.length === 0) {
    // Nothing valid requested → loopback-only fallback, flag not-ok if anything
    // was rejected so a caller (the POST route) can surface a 400.
    return { ok: rejected.length === 0, bindAddresses: [...DEFAULT_BIND_ADDRESSES], rejected };
  }
  return { ok: rejected.length === 0, bindAddresses: accepted, rejected };
}

/**
 * Load the persisted bind-address choice from `~/.plexus/network.json`. The file
 * is OPTIONAL `{ version:1, bindAddresses:[...] }`; absent / corrupt / invalid
 * falls back to the loopback-only default (fail-safe — never widens by accident).
 * Each persisted entry is re-validated against the CURRENT interfaces on load, so
 * a previously-chosen IP that no longer exists silently drops back to loopback.
 */
export function loadNetworkConfig(): { bindAddresses: string[] } {
  const raw = readFileBestEffort(homePath(NETWORK_CONFIG_FILE));
  if (!raw) return { bindAddresses: [...DEFAULT_BIND_ADDRESSES] };
  let parsed: Record<string, unknown> = {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object") parsed = obj as Record<string, unknown>;
  } catch {
    return { bindAddresses: [...DEFAULT_BIND_ADDRESSES] };
  }
  const requested = Array.isArray(parsed.bindAddresses)
    ? (parsed.bindAddresses as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  // Re-validate against current interfaces; invalid entries are dropped fail-safe.
  const { bindAddresses } = validateBindAddresses(requested);
  return { bindAddresses };
}

/**
 * Persist a validated bind-address choice to `~/.plexus/network.json`. Validates
 * via `validateBindAddresses` (rejecting any address that isn't loopback,
 * `0.0.0.0`, or a real local interface). Returns the effective result; on
 * validation failure NOTHING is written and `ok:false` + `rejected` is returned.
 */
export function writeNetworkConfig(
  requested: readonly string[],
): { ok: boolean; bindAddresses: string[]; rejected: string[] } {
  const result = validateBindAddresses(requested);
  if (!result.ok) return result;
  try {
    atomicWrite(
      homePath(NETWORK_CONFIG_FILE),
      JSON.stringify({ version: 1, bindAddresses: result.bindAddresses }, null, 2) + "\n",
    );
  } catch {
    /* best-effort durability — caller still gets the effective set back */
  }
  return result;
}

/** Resolve config from env + persisted network.json, defaulting to loopback:7077. */
export function loadConfig(): GatewayConfig {
  const portEnv = process.env.PLEXUS_PORT;
  const port = portEnv ? Number.parseInt(portEnv, 10) : DEFAULT_PORT;
  const instance = process.env.PLEXUS_INSTANCE;
  const { bindAddresses } = loadNetworkConfig();
  return {
    host: "127.0.0.1",
    bindAddresses,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    ...(instance ? { instance } : {}),
    auth: loadAuthConfig(),
  };
}

/** The loopback base URL the gateway binds to, e.g. "http://127.0.0.1:7077". */
export function baseUrl(config: GatewayConfig): string {
  return `http://${config.host}:${config.port}`;
}

/** The exact loopback authority the Host header must match (§5b HostOriginPolicy). */
export function expectedHost(config: GatewayConfig): string {
  return `${config.host}:${config.port}`;
}
