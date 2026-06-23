/**
 * Managed sources — SCAN / DETECT framework (Task 4).
 *
 * A pluggable, REACHABILITY-ONLY probe framework. The gateway uses it to discover
 * capability sources that are present on the machine (e.g. a running Obsidian Local
 * REST API) and OFFER them in the Sources panel / CLI — so the user does not have to
 * know the URL/flags. (DESIGN §5.)
 *
 * HARD INVARIANTS (every detector + `detectSources` must preserve them):
 *   - NON-MUTATING. A detector PROBES; it NEVER adds a source, never persists to
 *     `sources.json`, never registers a capability, never stores or reads a secret
 *     value, never reads/writes the underlying app's data. The UI/CLI later calls
 *     `manage.add` with the user-supplied secret — detection only pre-fills the form.
 *   - LOOPBACK-ENFORCED. Reachability rides the platform's `locateLocalService`,
 *     which probes 127.0.0.1 only. The resulting `baseUrl` is still re-validated
 *     (loopback / allow-list) by the `local-rest` transport at dispatch time.
 *   - BEST-EFFORT + BOUNDED. A single detector throwing must never abort the scan;
 *     `detectSources` isolates each detector.
 *
 * Pluggability: a new source kind ships a `detector` on its `SourceKindAdapter`
 * (`kinds.ts`); `DETECTORS` is auto-collected from `SOURCE_KINDS` (plus first-party
 * detectors with no kind adapter, like cc-master). No core branching.
 */

import type { PlatformServices } from "../../protocol/index.ts";
import { readCcMasterState } from "../cc-master/install.ts";
import type { ConfiguredSource, ConfiguredSourceKind, SourceKindAdapter } from "./types.ts";

/**
 * A source the scan found REACHABLE on the machine and the gateway can OFFER to add.
 * Pure advisory data — adding it is a separate, human-approved `manage.add` call.
 */
export interface DetectedSource {
  kind: ConfiguredSourceKind;
  /** Suggested id + label + route to pre-fill the "Add" form (no secret VALUE). */
  suggested: Pick<
    ConfiguredSource,
    "id" | "label" | "kind" | "transport" | "route" | "secretRef"
  >;
  /** Human-readable evidence ("reachable at https://127.0.0.1:27124"). */
  evidence: string;
  /** True if a same-id source is already configured (UI shows "configured"). */
  alreadyConfigured: boolean;
  /** Always true — a `DetectedSource` is only surfaced when reachable/available. */
  reachable: true;
  /** Set when adding/enabling still needs a secret the user must provide by NAME. */
  needsSecret?: { name: string };
}

/** A read-only view of the live config a detector consults for `alreadyConfigured`. */
export interface DetectConfigView {
  /** True when a source with this id is already configured. */
  has(id: string): boolean;
}

/** Build a `DetectConfigView` from the configured-source list (in-memory mirror). */
export function detectConfigView(sources: readonly ConfiguredSource[]): DetectConfigView {
  const ids = new Set(sources.map((s) => s.id));
  return { has: (id) => ids.has(id) };
}

/** A pluggable, NON-MUTATING reachability probe for one source kind. */
export interface SourceDetector {
  kind: ConfiguredSourceKind;
  /**
   * NON-MUTATING probe. Returns 0+ candidates. Bounded + best-effort. MUST NOT add,
   * persist, register, or touch any secret value. `config` is read-only (for the
   * `alreadyConfigured` flag).
   */
  detect(platform: PlatformServices, config: DetectConfigView): Promise<DetectedSource[]>;
}

/** The secret name the Obsidian Local REST detector suggests (NAME only). */
export const OBSIDIAN_REST_SECRET_NAME = "obsidian-local-rest-api-key" as const;
/** The suggested source id for a detected Obsidian Local REST endpoint. */
export const OBSIDIAN_REST_SOURCE_ID = "obsidian-rest" as const;

/**
 * v1 detector — Obsidian Local REST API (DESIGN §5.1).
 *
 * Wraps the EXISTING loopback primitive `platform.locateLocalService({ app:"obsidian",
 * defaultPort:27124 })`, which probes 127.0.0.1:27124/27123 and returns the reachable
 * loopback `address`. REACHABILITY ONLY: if reachable, suggest an `obsidian-rest`
 * source (baseUrl + needsSecret). NEVER auto-adds, never stores a secret, never reads
 * the vault. Loopback enforcement from `locateLocalService` is preserved.
 */
export const obsidianRestDetector: SourceDetector = {
  kind: "obsidian-rest",
  async detect(platform, config): Promise<DetectedSource[]> {
    const loc = await platform.locateLocalService({ app: "obsidian", defaultPort: 27124 });
    if (!loc) return [];
    const secretName = loc.secretRef ?? OBSIDIAN_REST_SECRET_NAME;
    return [
      {
        kind: "obsidian-rest",
        suggested: {
          id: OBSIDIAN_REST_SOURCE_ID,
          kind: "obsidian-rest",
          transport: "local-rest",
          label: "Obsidian vault (Local REST API)",
          route: { baseUrl: loc.address },
          secretRef: secretName,
        },
        evidence: `Obsidian Local REST API reachable at ${loc.address}`,
        alreadyConfigured: config.has(OBSIDIAN_REST_SOURCE_ID),
        reachable: true,
        needsSecret: { name: secretName },
      },
    ];
  },
};

/** The detected-source id cc-master is surfaced under (informational). */
export const CC_MASTER_SOURCE_ID = "cc-master" as const;

/**
 * cc-master availability detector (DESIGN §5.2). cc-master is a first-party
 * compile-time MODULE with its own install action; this detector just SURFACES its
 * install/enable state uniformly so the Sources panel shows one consistent
 * "available / installed" view. It reads `readCcMasterState()` (a pure read) and
 * does NOT rebuild or trigger the install. No platform probe, no secret.
 */
export const ccMasterDetector: SourceDetector = {
  kind: "cc-master",
  async detect(_platform, config): Promise<DetectedSource[]> {
    let state;
    try {
      state = readCcMasterState();
    } catch {
      return [];
    }
    // Surface availability: present when the cc-master plugin is installed OR enabled
    // OR its marketplace is known (any signal that the first-party source is usable).
    const available = state.installed || state.enabled || state.marketplaceKnown;
    if (!available) return [];
    const status = state.enabled
      ? "installed + enabled"
      : state.installed
        ? "installed"
        : "marketplace known";
    return [
      {
        kind: "cc-master",
        suggested: {
          id: CC_MASTER_SOURCE_ID,
          kind: "cc-master",
          transport: "cli",
          label: "cc-master (orchestration)",
        },
        evidence: `cc-master ${status} (~/.claude)`,
        alreadyConfigured: config.has(CC_MASTER_SOURCE_ID),
        reachable: true,
      },
    ];
  },
};

/**
 * The kind-adapter table the detector registry collects `detector` hooks from. This
 * is a ONE-DIRECTIONAL registration seam (`kinds.ts` → `detect.ts`): `kinds.ts`
 * imports `detect.ts` (for `obsidianRestDetector`) and registers `SOURCE_KINDS` here
 * at its module-init, so `detect.ts` NEVER statically imports `kinds.ts`. That breaks
 * the would-be `kinds.ts ⇄ detect.ts` import cycle (which otherwise reorders module
 * evaluation and trips a TDZ on unrelated classes downstream).
 */
const REGISTERED_KIND_ADAPTERS: SourceKindAdapter[] = [];

/** Called once by `kinds.ts` to register its `SOURCE_KINDS` for detector collection. */
export function registerKindAdaptersForDetect(adapters: readonly SourceKindAdapter[]): void {
  for (const a of adapters) {
    if (!REGISTERED_KIND_ADAPTERS.includes(a)) REGISTERED_KIND_ADAPTERS.push(a);
  }
}

/**
 * Collect the active detector set: every registered kind adapter that ships a
 * `detector`, PLUS first-party detectors with no kind adapter (cc-master is a
 * compile-time MODULE, not a managed kind). De-duplicated by kind (kind-adapter
 * detector wins). Same registry discipline as `MODULES` — no core branching.
 */
export function collectDetectors(): SourceDetector[] {
  const out: SourceDetector[] = [];
  const seen = new Set<string>();
  for (const adapter of REGISTERED_KIND_ADAPTERS) {
    const d = adapter.detector;
    if (isSourceDetector(d) && !seen.has(d.kind)) {
      out.push(d);
      seen.add(d.kind);
    }
  }
  // First-party, non-kind detectors (no SourceKindAdapter).
  for (const d of [ccMasterDetector]) {
    if (!seen.has(d.kind)) {
      out.push(d);
      seen.add(d.kind);
    }
  }
  return out;
}

/** The detector registry (lazily collected on first access — see `collectDetectors`). */
export const DETECTORS: readonly SourceDetector[] = new Proxy([] as SourceDetector[], {
  get(_target, prop, receiver) {
    return Reflect.get(collectDetectors(), prop, receiver);
  },
});

/** Narrow the adapter's `detector: unknown` hook to a `SourceDetector`. */
function isSourceDetector(d: unknown): d is SourceDetector {
  return (
    typeof d === "object" &&
    d !== null &&
    typeof (d as SourceDetector).kind === "string" &&
    typeof (d as SourceDetector).detect === "function"
  );
}

/**
 * Run every detector, aggregate the reachable candidates, and mark
 * `alreadyConfigured` against the live config. NON-MUTATING: it only PROBES and
 * REPORTS — it never adds/persists/registers anything. Each detector is isolated so
 * one failing never aborts the scan.
 */
export async function detectSources(
  platform: PlatformServices,
  sources: readonly ConfiguredSource[],
  detectors: readonly SourceDetector[] = collectDetectors(),
): Promise<DetectedSource[]> {
  const config = detectConfigView(sources);
  const results = await Promise.all(
    detectors.map(async (det) => {
      try {
        return await det.detect(platform, config);
      } catch {
        // Best-effort: a single detector failing must never abort the scan.
        return [] as DetectedSource[];
      }
    }),
  );
  return results.flat();
}
