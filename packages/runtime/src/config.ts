/**
 * Gateway runtime configuration. Loopback-only bind, default port 7077.
 * Pure data + helpers; no business logic.
 */

import { PLEXUS_PROTOCOL_VERSION } from "@plexus/protocol";
import type { TrustWindowKind } from "@plexus/protocol";
import { homePath, readFileBestEffort, atomicWrite } from "./core/paths.ts";

/** Gateway implementation version (package version). */
export const PLEXUS_VERSION = "0.1.0";

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
  /** Loopback host — NEVER 0.0.0.0 (§5 security model). */
  readonly host: "127.0.0.1";
  /** Bound port. */
  readonly port: number;
  /** Optional friendly instance name set by the user. */
  readonly instance?: string;
  /** The unified-trust-model config block (ADR-018). */
  readonly auth: AuthConfig;
}

const DEFAULT_PORT = 7077;

const AUTH_CONFIG_FILE = "auth-config.json";

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

/** Resolve config from env, defaulting to loopback:7077. */
export function loadConfig(): GatewayConfig {
  const portEnv = process.env.PLEXUS_PORT;
  const port = portEnv ? Number.parseInt(portEnv, 10) : DEFAULT_PORT;
  const instance = process.env.PLEXUS_INSTANCE;
  return {
    host: "127.0.0.1",
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
