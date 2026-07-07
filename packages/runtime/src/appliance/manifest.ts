/**
 * Plexus Capability-Appliance MANIFEST — the declarative allowlist that turns the
 * stock gateway into a single-purpose, least-privilege appliance.
 *
 * WHY THIS EXISTS (the "expose a capability, not a system" track):
 *   The general `docker/Dockerfile` image is a full gateway — on Linux it auto-gates
 *   to the portable module allowlist `{workspace, sysinfo}` and exposes whatever the
 *   operator wires via env. The APPLIANCE goes one step stricter: the OPERATOR hands a
 *   declarative manifest that names EXACTLY which curated sources + capabilities to
 *   expose and which host folder(s) back them. Anything not named is DEFAULT-DENIED.
 *
 *   This module is SELF-CONTAINED on purpose (no edits to `config.ts`, `core/registry.ts`,
 *   `core/exposure.ts`, `sources/index.ts`, `mesh/*`, `platform/*` — those are owned by
 *   other tracks). It is a pure schema + parser + validator + a small set of total
 *   predicates. The thin boot wrapper (`appliance/boot.ts`) is the ONLY consumer that
 *   touches process env / runtime state, and it does so through PUBLIC seams only:
 *     1. it translates the manifest into the env vars the STOCK gateway already reads
 *        (`PLEXUS_WORKSPACE_DIR`, `PLEXUS_MODE`, `PLEXUS_UPSTREAM_URL`, …), and
 *     2. after boot it walks the public `ExposureStore` and DISABLES every advertised
 *        capability the manifest does not name (default-deny made real at runtime).
 *
 * The deeper integration (gating the source REGISTRY itself, so a non-curated source is
 * never even scanned/instantiated) is a documented follow-up — see
 * `docs/design/capability-appliance.md` §"Follow-ups". Until then, the registry-level
 * Linux portable gate (P3-1) + this exposure-level default-deny are defense in depth.
 */

import { posix as pathPosix } from "node:path";
import type { SourceId, CapabilityId } from "@plexus/protocol";

/** The allowed top-level manifest keys — anything else is a typo / smuggled field (rejected). */
const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "version",
  "instance",
  "tenant",
  "workload",
  "sources",
  "upstream",
]);

/** The allowed per-source keys. A typo here (e.g. `capabilites`) is rejected — NOT silently
 *  treated as "no filter ⇒ expose the whole source", which would defeat the allowlist. */
const ALLOWED_SOURCE_KEYS: ReadonlySet<string> = new Set(["source", "capabilities", "path"]);

/** The allowed `upstream` keys. */
const ALLOWED_UPSTREAM_KEYS: ReadonlySet<string> = new Set(["url", "pubkey"]);

/**
 * Sensitive CONTAINER directories a source `path` must never point at. A `path` equal to or
 * inside one of these would mount the gateway's own private state into the exposed surface —
 * `/state` (= the appliance's `PLEXUS_HOME`) holds the connection-key, the token-signing
 * secret, and the Ed25519 mesh identity; `/app` is the source tree; `/etc/plexus` the manifest
 * itself. The real `PLEXUS_HOME` (when the operator overrides the default) is added at runtime.
 */
const SENSITIVE_CONTAINER_DIRS: readonly string[] = ["/state", "/app", "/etc/plexus"];

/** Normalize an absolute posix path: collapse `.`/`..`/`//` and strip a trailing slash. */
function normalizeAbsPath(p: string): string {
  const n = pathPosix.normalize(p.trim());
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/**
 * If `p` equals or is INSIDE a sensitive container dir, return the offending dir (else
 * `undefined`). Honors a runtime `PLEXUS_HOME` override in addition to the static set.
 */
function sensitiveContainerDirFor(p: string): string | undefined {
  const target = normalizeAbsPath(p);
  const home = process.env.PLEXUS_HOME?.trim();
  const sensitive = home ? [...SENSITIVE_CONTAINER_DIRS, home] : SENSITIVE_CONTAINER_DIRS;
  for (const dir of sensitive) {
    const d = normalizeAbsPath(dir);
    if (target === d || target.startsWith(`${d}/`)) return d;
  }
  return undefined;
}

/** The only supported manifest schema version. Bumped only on a breaking shape change. */
export const APPLIANCE_MANIFEST_VERSION = 1 as const;

/**
 * The env var the appliance boot wrapper reads to locate the manifest FILE (a path).
 * A NEW var owned entirely by this track — it does not collide with any stock env.
 */
export const APPLIANCE_MANIFEST_ENV = "PLEXUS_APPLIANCE_MANIFEST";

/**
 * A single curated source the appliance exposes. The source must be one the host
 * platform can actually run (on Linux: the portable `{workspace, sysinfo}` set).
 */
export interface ApplianceSourceSpec {
  /** The first-party source id to expose, e.g. `"workspace"`. */
  readonly source: SourceId;
  /**
   * Optional capability allowlist (exact ids or `*` globs, matched against the FULL
   * capability id, e.g. `"workspace.read"` or `"workspace.*"`). ABSENT/empty ⇒ every
   * capability the source contributes is exposed. Present ⇒ ONLY matching ids are
   * exposed; all others under the same source are DENIED.
   */
  readonly capabilities?: readonly string[];
  /**
   * The host data path this source is confined to. For `workspace` this becomes
   * `PLEXUS_WORKSPACE_DIR` (the single authorized, path-confined directory). The
   * operator mounts ONLY this path into the container — it is the confinement boundary.
   */
  readonly path?: string;
}

/** Optional mesh upstream — when present the appliance boots as a mesh PROXY (dials out). */
export interface ApplianceUpstream {
  /** The primary's tunnel endpoint, e.g. `wss://primary.example:8443`. → `PLEXUS_UPSTREAM_URL`. */
  readonly url: string;
  /** The primary's PINNED Ed25519 public key (mandatory — no bare-TOFU). → `PLEXUS_UPSTREAM_PUBKEY`. */
  readonly pubkey: string;
}

/** The validated appliance manifest — the curated, default-deny exposure declaration. */
export interface ApplianceManifest {
  /** Schema version. MUST equal {@link APPLIANCE_MANIFEST_VERSION}. */
  readonly version: typeof APPLIANCE_MANIFEST_VERSION;
  /** Optional friendly instance name. → `PLEXUS_INSTANCE`. */
  readonly instance?: string;
  /** Optional org/ownership coordinate. → `PLEXUS_TENANT`. */
  readonly tenant?: string;
  /** Optional workload identity (the addressing segment). → `PLEXUS_WORKLOAD`. */
  readonly workload?: string;
  /** The curated source allowlist — MUST be non-empty (an appliance exposing nothing is a misconfig). */
  readonly sources: readonly ApplianceSourceSpec[];
  /** Optional mesh upstream — present ⇒ boot as a proxy; absent ⇒ standalone primary. */
  readonly upstream?: ApplianceUpstream;
}

/** Thrown by the parser/validator on any malformed manifest; carries every collected reason. */
export class ApplianceManifestError extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`invalid appliance manifest:\n  - ${errors.join("\n  - ")}`);
    this.name = "ApplianceManifestError";
    this.errors = errors;
  }
}

/** True for a non-empty trimmed string. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Glob match: supports `*` (any run of chars, including none) anywhere in the pattern;
 * everything else is literal. An exact id is just a pattern with no `*`. Total — never throws.
 */
export function matchCapabilityGlob(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  // Escape regex metachars, then turn `\*` back into `.*`.
  const rx = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${rx}$`).test(value);
}

/**
 * Validate an already-parsed value into an {@link ApplianceManifest}. Collects ALL
 * structural problems and throws a single {@link ApplianceManifestError} (fail-closed:
 * any defect rejects the whole manifest — an appliance must never boot half-curated).
 */
export function validateApplianceManifest(value: unknown): ApplianceManifest {
  const errors: string[] = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplianceManifestError(["manifest must be a JSON object"]);
  }
  const obj = value as Record<string, unknown>;

  // STRICT unknown-key rejection (fail-closed): a typo'd top-level field (e.g. `"sourcse"`)
  // must be a loud error, never silently ignored.
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(
        `unknown top-level field ${JSON.stringify(key)} (allowed: ${[...ALLOWED_TOP_LEVEL_KEYS].join(", ")})`,
      );
    }
  }

  if (obj.version !== APPLIANCE_MANIFEST_VERSION) {
    errors.push(`"version" must be ${APPLIANCE_MANIFEST_VERSION} (got ${JSON.stringify(obj.version)})`);
  }

  for (const key of ["instance", "tenant", "workload"] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== "string") {
      errors.push(`"${key}" must be a string when present`);
    }
  }

  // ── sources — the curated allowlist (REQUIRED, non-empty) ───────────────────
  const sources: ApplianceSourceSpec[] = [];
  if (!Array.isArray(obj.sources) || obj.sources.length === 0) {
    errors.push(`"sources" must be a non-empty array (an appliance must expose at least one curated source)`);
  } else {
    const seen = new Set<string>();
    obj.sources.forEach((raw, i) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`sources[${i}] must be an object`);
        return;
      }
      const s = raw as Record<string, unknown>;

      // STRICT unknown-key rejection. A typo like `"capabilites"` would otherwise leave
      // `capabilities` undefined ⇒ the WHOLE source exposed (match-all) — a silent allowlist
      // bypass. Reject it instead, with a hint.
      for (const key of Object.keys(s)) {
        if (!ALLOWED_SOURCE_KEYS.has(key)) {
          errors.push(
            `sources[${i}]: unknown field ${JSON.stringify(key)} (allowed: ${[...ALLOWED_SOURCE_KEYS].join(", ")}) — ` +
              `a typo'd "capabilities" would silently expose the whole source`,
          );
        }
      }

      if (!isNonEmptyString(s.source)) {
        errors.push(`sources[${i}].source must be a non-empty string`);
        return;
      }
      const sourceId = s.source.trim();
      if (seen.has(sourceId)) errors.push(`sources[${i}].source "${sourceId}" is declared more than once`);
      seen.add(sourceId);

      let capabilities: string[] | undefined;
      if (s.capabilities !== undefined) {
        if (
          !Array.isArray(s.capabilities) ||
          !s.capabilities.every((c) => isNonEmptyString(c))
        ) {
          errors.push(`sources[${i}].capabilities must be an array of non-empty strings when present`);
        } else {
          capabilities = (s.capabilities as string[]).map((c) => c.trim());
        }
      }

      if (s.path !== undefined && !isNonEmptyString(s.path)) {
        errors.push(`sources[${i}].path must be a non-empty string when present`);
      } else if (isNonEmptyString(s.path)) {
        // A `path` is the confinement boundary (it becomes a host→container mount). It must
        // NOT point at the gateway's own private state: a `path:/state` would mount the
        // connection-key + token-signing secret + mesh identity into the exposed surface.
        const offending = sensitiveContainerDirFor(s.path);
        if (offending) {
          errors.push(
            `sources[${i}].path ${JSON.stringify(s.path.trim())} is inside the sensitive container dir ` +
              `"${offending}" — that would expose the gateway's connection-key / token-signing secret / ` +
              `mesh identity. Mount a SEPARATE data directory (e.g. /data/exposed) instead.`,
          );
        }
      }

      sources.push({
        source: sourceId,
        ...(capabilities ? { capabilities } : {}),
        ...(isNonEmptyString(s.path) ? { path: s.path.trim() } : {}),
      });
    });
  }

  // ── upstream — optional mesh proxy target ───────────────────────────────────
  let upstream: ApplianceUpstream | undefined;
  if (obj.upstream !== undefined) {
    const u = obj.upstream;
    if (u === null || typeof u !== "object" || Array.isArray(u)) {
      errors.push(`"upstream" must be an object when present`);
    } else {
      const up = u as Record<string, unknown>;
      if (!isNonEmptyString(up.url)) errors.push(`upstream.url must be a non-empty string`);
      if (!isNonEmptyString(up.pubkey)) {
        errors.push(`upstream.pubkey must be a non-empty string (the primary's pinned key — no bare-TOFU)`);
      }
      if (isNonEmptyString(up.url) && isNonEmptyString(up.pubkey)) {
        upstream = { url: up.url.trim(), pubkey: up.pubkey.trim() };
      }
    }
  }

  if (errors.length > 0) throw new ApplianceManifestError(errors);

  return {
    version: APPLIANCE_MANIFEST_VERSION,
    ...(isNonEmptyString(obj.instance) ? { instance: (obj.instance as string).trim() } : {}),
    ...(isNonEmptyString(obj.tenant) ? { tenant: (obj.tenant as string).trim() } : {}),
    ...(isNonEmptyString(obj.workload) ? { workload: (obj.workload as string).trim() } : {}),
    sources,
    ...(upstream ? { upstream } : {}),
  };
}

/** Parse + validate a manifest from raw JSON text. Throws {@link ApplianceManifestError} on any defect. */
export function parseApplianceManifest(rawJson: string): ApplianceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new ApplianceManifestError([`not valid JSON: ${(e as Error).message}`]);
  }
  return validateApplianceManifest(parsed);
}

/** The set of source ids this manifest curates (for registry-level follow-up gating). */
export function curatedSourceIds(manifest: ApplianceManifest): ReadonlySet<SourceId> {
  return new Set(manifest.sources.map((s) => s.source));
}

/**
 * THE DEFAULT-DENY PREDICATE. Returns true iff a capability is exposed by this manifest:
 * its source must be curated AND (the source has no capability filter ⇒ all allowed, OR
 * some glob in the filter matches the capability id). Anything unlisted ⇒ false (denied).
 */
export function isCapabilityExposed(
  manifest: ApplianceManifest,
  ref: { readonly source: SourceId; readonly id: CapabilityId },
): boolean {
  const spec = manifest.sources.find((s) => s.source === ref.source);
  if (!spec) return false; // source not curated → denied
  if (!spec.capabilities || spec.capabilities.length === 0) return true; // whole source curated
  return spec.capabilities.some((pat) => matchCapabilityGlob(pat, ref.id));
}

/**
 * Translate a manifest into the STOCK gateway env vars (the public boot contract). The
 * appliance boot wrapper applies these to `process.env` BEFORE `loadConfig()`, so the
 * existing config/source paths produce the curated surface with ZERO edits to owned files.
 *
 * v1 path mapping: a `workspace` source's `path` becomes `PLEXUS_WORKSPACE_DIR` (the one
 * authorized, path-confined directory). Other sources' `path` is reserved for follow-up
 * (no portable source consumes a second path today) and is surfaced to the operator as
 * a warning by the boot wrapper rather than silently dropped.
 */
export function manifestToEnv(manifest: ApplianceManifest): Record<string, string> {
  const env: Record<string, string> = {};
  if (manifest.instance) env.PLEXUS_INSTANCE = manifest.instance;
  if (manifest.tenant) env.PLEXUS_TENANT = manifest.tenant;
  if (manifest.workload) env.PLEXUS_WORKLOAD = manifest.workload;

  const workspace = manifest.sources.find((s) => s.source === "workspace");
  if (workspace?.path) env.PLEXUS_WORKSPACE_DIR = workspace.path;

  if (manifest.upstream) {
    env.PLEXUS_MODE = "proxy";
    env.PLEXUS_UPSTREAM_URL = manifest.upstream.url;
    env.PLEXUS_UPSTREAM_PUBKEY = manifest.upstream.pubkey;
  }
  return env;
}
