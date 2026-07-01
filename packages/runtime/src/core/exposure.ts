/**
 * Top-level capability EXPOSURE policy store ("What I expose").
 *
 * The OWNER decides, per capability, whether it is exposed at all. This is the
 * outermost gate — orthogonal to (and intersected with) the per-agent grant model:
 *
 *     effective access = granted ∧ exposed
 *
 * A DISABLED (unexposed) capability is:
 *   1. INVISIBLE   — excluded from `.well-known` summaries + the manifest entry set.
 *   2. NOT GRANTABLE — a `PUT /grants` request for it is rejected (not pended).
 *   3. NOT INVOKABLE — even a still-valid standing token is DENIED at the pipeline
 *      (ErrorCode `capability_unexposed`), audited. The grant RECORD is preserved so
 *      re-enabling restores access (the intersection, not a revocation).
 *
 * Persisted to `~/.plexus/exposure.json`, mirroring the grant-store pattern
 * (in-memory map of record-of-truth + best-effort atomic write). Default is
 * EXPOSED: a capability with no explicit policy entry is enabled, so an empty/absent
 * file changes nothing (no regression). Only EXPLICIT decisions are persisted; a
 * capability re-enabled to ITS default drops its key to keep the file minimal.
 *
 * ZERO-EXPOSURE FOR MESH (phase-1 plan risk #4, §7 Q3): the "absent = enabled" default
 * is INVERTED per-id for mesh-mounted addresses via an injected `DefaultExposureResolver`
 * — a mounted address with no explicit policy defaults HIDDEN (invisible in discovery
 * until the owner enables it). The resolver is the ONLY coupling to mesh provenance; the
 * persistence stays minimal in BOTH directions (a hidden-by-default mesh id needs no entry;
 * an OWNER-ENABLED one stores an explicit `true` since its default is `false`), and local
 * sources are untouched (the resolver returns `undefined` for them ⇒ the old default-enabled).
 */

import type { CapabilityId } from "@plexus/protocol";
import { homePath, readFileBestEffort, atomicWrite } from "./paths.ts";

const EXPOSURE_FILE = "exposure.json";

/**
 * Per-id DEFAULT-exposure hook. Returns `"hidden"` when an id with no explicit policy must
 * default DISABLED (mesh zero-exposure), or `undefined` to keep the built-in default-ENABLED
 * (local-source semantics). Injected so `ExposureStore` stays decoupled from the registry.
 */
export type DefaultExposureResolver = (id: CapabilityId) => "hidden" | undefined;

export interface ExposureStore {
  /** Whether a capability is currently exposed (default per `setDefaultResolver`; else true). */
  isEnabled(id: CapabilityId): boolean;
  /** Convenience inverse of `isEnabled` (the enforcement hot-path predicate). */
  isDisabled(id: CapabilityId): boolean;
  /** Set (and persist) a capability's exposure. Setting it to ITS default drops the key. */
  setEnabled(id: CapabilityId, enabled: boolean): void;
  /** The capability ids EXPLICITLY disabled (the only persisted "off" entries). */
  disabledIds(): CapabilityId[];
  /** The explicit policy map (id → enabled). Absent ids default per the resolver. */
  all(): Record<CapabilityId, boolean>;
  /**
   * Inject the per-id default resolver (phase-1 plan risk #4). Wired at state construction
   * to the capability registry's `exposureDefaultFor`, so a mesh-mounted address defaults
   * HIDDEN without an explicit `exposure.json` entry. Idempotent (last writer wins).
   */
  setDefaultResolver(resolver: DefaultExposureResolver): void;
}

class FileExposureStore implements ExposureStore {
  /** Explicit per-capability decisions. Absent ⇒ the resolved default (enabled unless hidden). */
  private readonly policy = new Map<CapabilityId, boolean>();
  private readonly path: string;
  /** Per-id default hook (mesh zero-exposure). `undefined` resolver ⇒ everything default-enabled. */
  private defaultResolver: DefaultExposureResolver = () => undefined;

  constructor(path: string) {
    this.path = path;
    const raw = readFileBestEffort(path);
    if (raw) {
      try {
        const records = JSON.parse(raw) as Record<string, boolean>;
        for (const [id, enabled] of Object.entries(records)) {
          if (typeof enabled === "boolean") this.policy.set(id, enabled);
        }
      } catch {
        /* corrupt file — start with everything default-exposed */
      }
    }
  }

  setDefaultResolver(resolver: DefaultExposureResolver): void {
    this.defaultResolver = resolver;
  }

  /** The default exposure for an id with no explicit policy: `false` iff the resolver hides it. */
  private defaultEnabled(id: CapabilityId): boolean {
    return this.defaultResolver(id) !== "hidden";
  }

  isEnabled(id: CapabilityId): boolean {
    const explicit = this.policy.get(id);
    // An explicit decision wins; otherwise fall to the per-id default (mesh ⇒ hidden).
    return explicit !== undefined ? explicit : this.defaultEnabled(id);
  }

  isDisabled(id: CapabilityId): boolean {
    return !this.isEnabled(id);
  }

  setEnabled(id: CapabilityId, enabled: boolean): void {
    // Setting an id to ITS default drops the key — keeping the file minimal in BOTH
    // directions: a default-exposed local cap toggled back on, AND a default-hidden mesh
    // address toggled back off, both vanish from disk; only an OFF-of-default decision persists
    // (a local cap hidden ⇒ `false`; a mesh address owner-enabled ⇒ `true`).
    if (enabled === this.defaultEnabled(id)) {
      const had = this.policy.delete(id);
      if (had) this.persist();
      return;
    }
    if (this.policy.get(id) === enabled) return; // no-op, already in this explicit state
    this.policy.set(id, enabled);
    this.persist();
  }

  disabledIds(): CapabilityId[] {
    return [...this.policy.entries()].filter(([, on]) => on === false).map(([id]) => id);
  }

  all(): Record<CapabilityId, boolean> {
    return Object.fromEntries(this.policy.entries());
  }

  private persist(): void {
    try {
      atomicWrite(this.path, JSON.stringify(Object.fromEntries(this.policy.entries())));
    } catch {
      /* best-effort — authoritative state stays in memory */
    }
  }
}

export function createExposureStore(): ExposureStore {
  return new FileExposureStore(homePath(EXPOSURE_FILE));
}
