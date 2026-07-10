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
 *   - GRANTS (`grants.ts`) carry the live authority a token is minted from. For a
 *     read/write capability the connect flow also persists a STANDING grant, so the
 *     subset and the standing grant agree. But an EXECUTE capability sits in the subset
 *     WITHOUT a standing grant (it is per-use by default, ADR-5) — which is exactly why
 *     the subset must be its own record and cannot be derived from the grant store.
 *
 * MIGRATION (opt-in, safe): an agent with NO subset record is UN-SCOPED — the legacy
 * behavior is preserved unchanged (full exposed manifest, authorizer decides grants).
 * Every NEW connect writes a record, enrolling that agent into the subset model; an
 * already-connected agent stays legacy until the owner re-connects it. So shipping this
 * changes NO existing agent's behavior until a deliberate re-connect. `isScoped` is the
 * predicate the readers gate on.
 *
 * `standingExecute` is the owner's per-agent opt-in for a specific EXECUTE capability to
 * ride a STANDING grant (default-off; the ADR-5 relaxation, `docs/design/…` §4). It is a
 * SUBSET of `capabilities`. Persisted here but only consulted once the opt-in path ships.
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
   * The subset of `capabilities` the owner opted into a STANDING execute grant
   * (default-off, per-agent, per-capability — the ADR-5 relaxation). Empty for the
   * default posture (execute stays per-use).
   */
  standingExecute: CapabilityId[];
}

/** The on-disk shape. */
interface PersistedSubsets {
  version: number;
  agents: Record<string, { capabilities: CapabilityId[]; standingExecute?: CapabilityId[] }>;
}

export interface AgentSubsetStore {
  /** The authorized subset for an agent, or undefined if it was never connected under this model. */
  get(agentId: string): AgentSubset | undefined;
  /** Whether an agent has an explicit authorized subset (⇒ the readers ENFORCE scoping). */
  isScoped(agentId: string): boolean;
  /** Whether `capabilityId` is within the agent's authorized subset. False for an un-scoped agent. */
  isAuthorized(agentId: string, capabilityId: CapabilityId): boolean;
  /** Whether the owner opted this (agent, execute-cap) into a STANDING grant (default-off). */
  isStandingExecute(agentId: string, capabilityId: CapabilityId): boolean;
  /**
   * Set (REPLACE) an agent's authorized subset. `standingExecute` is intersected with
   * `capabilities` (an opt-in only makes sense for a capability in the subset). Persisted.
   */
  set(agentId: string, capabilities: CapabilityId[], standingExecute?: CapabilityId[]): void;
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
            // standingExecute only means anything for a cap that is IN the subset.
            const standingExecute = cleanIds(rec.standingExecute).filter((id) =>
              capabilities.includes(id),
            );
            this.subsets.set(agentId, { capabilities, standingExecute });
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

  isStandingExecute(agentId: string, capabilityId: CapabilityId): boolean {
    const rec = this.subsets.get(agentId);
    return rec ? rec.standingExecute.includes(capabilityId) : false;
  }

  set(agentId: string, capabilities: CapabilityId[], standingExecute?: CapabilityId[]): void {
    if (typeof agentId !== "string" || agentId.length === 0) return;
    const caps = cleanIds(capabilities);
    const standing = cleanIds(standingExecute).filter((id) => caps.includes(id));
    this.subsets.set(agentId, { capabilities: caps, standingExecute: standing });
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
        { capabilities: [...rec.capabilities], standingExecute: [...rec.standingExecute] },
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
              ...(rec.standingExecute.length ? { standingExecute: rec.standingExecute } : {}),
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
