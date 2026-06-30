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
 * capability re-enabled to the default drops its key to keep the file minimal.
 */

import type { CapabilityId } from "@plexus/protocol";
import { homePath, readFileBestEffort, atomicWrite } from "./paths.ts";

const EXPOSURE_FILE = "exposure.json";

export interface ExposureStore {
  /** Whether a capability is currently exposed (default true when no explicit policy). */
  isEnabled(id: CapabilityId): boolean;
  /** Convenience inverse of `isEnabled` (the enforcement hot-path predicate). */
  isDisabled(id: CapabilityId): boolean;
  /** Set (and persist) a capability's exposure. `true` returns it to the default. */
  setEnabled(id: CapabilityId, enabled: boolean): void;
  /** The capability ids EXPLICITLY disabled (the only persisted "off" entries). */
  disabledIds(): CapabilityId[];
  /** The explicit policy map (id → enabled). Absent ids default to enabled. */
  all(): Record<CapabilityId, boolean>;
}

class FileExposureStore implements ExposureStore {
  /** Explicit per-capability decisions. Absent ⇒ default-exposed (enabled). */
  private readonly policy = new Map<CapabilityId, boolean>();
  private readonly path: string;

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

  isEnabled(id: CapabilityId): boolean {
    // Default-exposed: only an explicit `false` disables.
    return this.policy.get(id) !== false;
  }

  isDisabled(id: CapabilityId): boolean {
    return this.policy.get(id) === false;
  }

  setEnabled(id: CapabilityId, enabled: boolean): void {
    if (enabled) {
      // Returning to the default ⇒ drop the key so the persisted file stays minimal
      // and "absent = exposed" stays the single rule.
      const had = this.policy.delete(id);
      if (had) this.persist();
      return;
    }
    if (this.policy.get(id) === false) return; // no-op, already disabled
    this.policy.set(id, false);
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
