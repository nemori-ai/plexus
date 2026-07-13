/**
 * Per-agent AUTHORIZED-SUBSET store (`docs/design/agent-authorized-subset.md`).
 *
 * The owner declares, at connect, the exact set of capabilities ONE agent may access.
 * That selection IS the agent's world: the manifest it discovers is scoped to this
 * subset, and a `PUT /grants` for anything OUTSIDE it is DENIED (not pended) — an
 * agent never learns Plexus has more than what it was granted. This store is the
 * single source of truth for "what did the owner authorize this agent to access."
 *
 * Relationship to the other stores:
 *   - EXPOSURE (`exposure.ts`) is owner-wide ("what is enabled at all"); the subset is
 *     per-agent ("what THIS agent may reach"). Effective discovery = subset ∩ exposed.
 *   - GRANTS (`grants.ts`) carry the live authority a token is minted from. For a READ
 *     capability the connect flow also persists a STANDING grant, so the subset and the
 *     standing grant agree. A SIDE-EFFECTING capability (write/execute verbs) sits in the
 *     subset WITHOUT a standing grant by default — each use pends for the owner — which
 *     is exactly why the subset must be its own record and cannot be derived from the
 *     grant store. The owner lifts that default explicitly: the per-cap `standing` opt-in
 *     below (at connect), or an approval/grant that names the capability itself.
 *
 * NO LEGACY FALLBACK (fail closed): an agent with NO subset record is authorized
 * NOTHING — empty manifest, every grant request denied (an owner-issued standing grant
 * is the one exception; it is itself an explicit owner act). The owner re-connects the
 * agent to authorize it. Every connect writes a record (even an empty selection). The
 * earlier migration affordance (no record ⇒ full legacy visibility) is removed — it let
 * a pre-subset agent see the whole exposure and auto-acquire first-party reads.
 *
 * `standing` is the owner's per-agent opt-in for a specific SIDE-EFFECTING capability
 * (write/execute verbs) to ride a STANDING grant from connect (default-off; for execute
 * this is the ADR-5 relaxation, `docs/design/…` §4). It is a SUBSET of `capabilities`.
 * (Persisted files written before the generalization used the key `standingExecute`;
 * the loader accepts both.)
 *
 * Persisted to `~/.plexus/agent-subsets.json`, mirroring the exposure/grant store pattern
 * (in-memory record-of-truth + best-effort atomic write). A corrupt/absent file starts
 * empty ⇒ every agent is un-scoped (legacy) — no regression.
 */

import type { CapabilityId } from "@plexus/protocol";
import { homePath, readFileBestEffort, atomicWrite } from "./paths.ts";

const AGENT_SUBSETS_FILE = "agent-subsets.json";
/** Bump if the persisted shape changes incompatibly. */
const SUBSETS_VERSION = 1;

/** One agent's authorized subset — the capabilities the owner let it reach. */
export interface AgentSubset {
  /** The full authorized capability-id subset (read/write/execute alike). */
  capabilities: CapabilityId[];
  /**
   * The subset of `capabilities` the owner opted into a STANDING grant despite being
   * side-effecting (write/execute — default-off, per-agent, per-capability). Empty for
   * the default posture (every side-effecting use pends).
   */
  standing: CapabilityId[];
}

/** The on-disk shape (`standingExecute` is the pre-generalization legacy key). */
interface PersistedSubsets {
  version: number;
  agents: Record<
    string,
    { capabilities: CapabilityId[]; standing?: CapabilityId[]; standingExecute?: CapabilityId[] }
  >;
}

export interface AgentSubsetStore {
  /** The authorized subset for an agent, or undefined if it was never connected. */
  get(agentId: string): AgentSubset | undefined;
  /** Whether an agent has an explicit subset record (diagnostic — enforcement no longer keys on this). */
  isScoped(agentId: string): boolean;
  /** Whether `capabilityId` is within the agent's authorized subset. False when there is no record (fail closed). */
  isAuthorized(agentId: string, capabilityId: CapabilityId): boolean;
  /** Whether the owner opted this (agent, side-effecting cap) into a STANDING grant (default-off). */
  isStanding(agentId: string, capabilityId: CapabilityId): boolean;
  /**
   * Set (REPLACE) an agent's authorized subset. `standing` is intersected with
   * `capabilities` (an opt-in only makes sense for a capability in the subset). Persisted.
   */
  set(agentId: string, capabilities: CapabilityId[], standing?: CapabilityId[]): void;
  /** Remove an agent's subset record entirely (revoke & delete). Returns whether one existed. */
  remove(agentId: string): boolean;
  /** Every agent's subset (for the admin read side). */
  all(): Record<string, AgentSubset>;
}

/** De-dupe + drop empties from a capability-id list (defensive against caller input). */
function cleanIds(ids: readonly CapabilityId[] | undefined): CapabilityId[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<CapabilityId>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) seen.add(id);
  }
  return [...seen];
}

class FileAgentSubsetStore implements AgentSubsetStore {
  private readonly subsets = new Map<string, AgentSubset>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    const raw = readFileBestEffort(path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<PersistedSubsets>;
        const agents = parsed?.agents;
        if (agents && typeof agents === "object") {
          for (const [agentId, rec] of Object.entries(agents)) {
            if (!agentId || !rec || typeof rec !== "object") continue;
            const capabilities = cleanIds(rec.capabilities);
            // standing only means anything for a cap that is IN the subset. Files written
            // before the generalization carry the opt-ins under `standingExecute`.
            const standing = cleanIds([
              ...(rec.standing ?? []),
              ...(rec.standingExecute ?? []),
            ]).filter((id) => capabilities.includes(id));
            this.subsets.set(agentId, { capabilities, standing });
          }
        }
      } catch {
        /* corrupt file — start empty (every agent un-scoped / legacy) */
      }
    }
  }

  get(agentId: string): AgentSubset | undefined {
    return this.subsets.get(agentId);
  }

  isScoped(agentId: string): boolean {
    return this.subsets.has(agentId);
  }

  isAuthorized(agentId: string, capabilityId: CapabilityId): boolean {
    const rec = this.subsets.get(agentId);
    return rec ? rec.capabilities.includes(capabilityId) : false;
  }

  isStanding(agentId: string, capabilityId: CapabilityId): boolean {
    const rec = this.subsets.get(agentId);
    return rec ? rec.standing.includes(capabilityId) : false;
  }

  set(agentId: string, capabilities: CapabilityId[], standing?: CapabilityId[]): void {
    if (typeof agentId !== "string" || agentId.length === 0) return;
    const caps = cleanIds(capabilities);
    const opted = cleanIds(standing).filter((id) => caps.includes(id));
    this.subsets.set(agentId, { capabilities: caps, standing: opted });
    this.persist();
  }

  remove(agentId: string): boolean {
    const had = this.subsets.delete(agentId);
    if (had) this.persist();
    return had;
  }

  all(): Record<string, AgentSubset> {
    return Object.fromEntries(
      [...this.subsets.entries()].map(([id, rec]) => [
        id,
        { capabilities: [...rec.capabilities], standing: [...rec.standing] },
      ]),
    );
  }

  private persist(): void {
    try {
      const ledger: PersistedSubsets = {
        version: SUBSETS_VERSION,
        agents: Object.fromEntries(
          [...this.subsets.entries()].map(([id, rec]) => [
            id,
            {
              capabilities: rec.capabilities,
              ...(rec.standing.length ? { standing: rec.standing } : {}),
            },
          ]),
        ),
      };
      atomicWrite(this.path, JSON.stringify(ledger, null, 2));
    } catch {
      /* best-effort — authoritative state stays in memory */
    }
  }
}

export function createAgentSubsetStore(): AgentSubsetStore {
  return new FileAgentSubsetStore(homePath(AGENT_SUBSETS_FILE));
}
