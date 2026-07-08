/**
 * `default-grant` policy store — the owner's per-capability "pre-check this at connect"
 * flag (`docs/design/agent-authorized-subset.md` §3.1).
 *
 * ORTHOGONAL to exposure (`exposure.ts`): exposure is "is this capability enabled at
 * all"; default-grant is "when I connect a NEW agent, pre-tick this capability in its
 * authorized subset." It is ONLY a default for the connect UI — never a runtime
 * authorization by itself. An agent is authorized a capability solely by the connect
 * selection (the subset, `agent-subset.ts`), never by this flag; toggling it changes
 * no already-connected agent.
 *
 * Persisted to `~/.plexus/default-grants.json` as a flat id list, mirroring the
 * exposure/grant store pattern (in-memory record-of-truth + best-effort atomic write).
 * Default is OFF: a capability with no entry is not pre-checked, so an absent/empty
 * file changes nothing.
 */

import type { CapabilityId } from "@plexus/protocol";
import { homePath, readFileBestEffort, atomicWrite } from "./paths.ts";

const DEFAULT_GRANTS_FILE = "default-grants.json";

export interface DefaultGrantStore {
  /** Whether the owner marked this capability to be pre-checked at connect. */
  isDefaultGrant(id: CapabilityId): boolean;
  /** Set (and persist) a capability's default-grant flag. Setting OFF drops the key. */
  setDefaultGrant(id: CapabilityId, on: boolean): void;
  /** The capability ids currently marked default-grant. */
  ids(): CapabilityId[];
}

class FileDefaultGrantStore implements DefaultGrantStore {
  private readonly marked = new Set<CapabilityId>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    const raw = readFileBestEffort(path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const id of parsed) if (typeof id === "string" && id.length > 0) this.marked.add(id);
        }
      } catch {
        /* corrupt file — start empty (nothing pre-checked) */
      }
    }
  }

  isDefaultGrant(id: CapabilityId): boolean {
    return this.marked.has(id);
  }

  setDefaultGrant(id: CapabilityId, on: boolean): void {
    if (typeof id !== "string" || id.length === 0) return;
    const had = this.marked.has(id);
    if (on === had) return; // no-op
    if (on) this.marked.add(id);
    else this.marked.delete(id);
    this.persist();
  }

  ids(): CapabilityId[] {
    return [...this.marked];
  }

  private persist(): void {
    try {
      atomicWrite(this.path, JSON.stringify([...this.marked]));
    } catch {
      /* best-effort — authoritative state stays in memory */
    }
  }
}

export function createDefaultGrantStore(): DefaultGrantStore {
  return new FileDefaultGrantStore(homePath(DEFAULT_GRANTS_FILE));
}
