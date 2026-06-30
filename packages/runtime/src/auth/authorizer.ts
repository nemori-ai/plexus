/**
 * The Authorizer seam (§4a, ADR-007 revised). The authorize decision is a
 * PLUGGABLE abstraction; swapping the policy never touches the wire.
 *
 * Two policies ship:
 *   - `AutoApproveAuthorizer` — the permissive stub. Returns "allow" for every
 *     entry's requested verbs. Kept for tests exercising UNRELATED mechanics and
 *     for an explicit "trust everything" deployment.
 *   - `UserConfirmAuthorizer` — THE DEFAULT (M4 security linchpin). Returns
 *     "pending" (→ `grant_pending_user`) for RISKY requests so an agent CANNOT
 *     self-grant execute/write or grant against an extension-sourced capability
 *     without a real human approving in the management client. Only auto-allows
 *     low-risk first-party reads (so shipped first-party read flows + sane UX
 *     survive). The pend boundary is documented + configurable below.
 */

import type {
  Authorizer,
  AuthorizationContext,
  AuthorizationDecision,
  CapabilityEntry,
  GrantVerb,
  Provenance,
  SourceId,
  TrustWindow,
} from "@plexus/protocol";
import {
  RESERVED_SOURCE_IDS,
  provenanceFor,
  sensitivityFor,
  recommendedTrustWindowFor,
} from "../core/capability-registry.ts";
import { deriveSource } from "../core/registry-helpers.ts";
import { DEFAULT_TRUST_WINDOWS, type DefaultTrustWindows } from "../config.ts";

/**
 * v1 permissive stub. Auto-approves the requested verbs for every entry.
 * Intentionally trivial — the SEAM (not this policy) is the contract. Use it ONLY
 * where a test/demo is exercising mechanics OTHER than the human-confirm linchpin,
 * or in an explicit "trust everything" local deployment.
 */
export class AutoApproveAuthorizer implements Authorizer {
  readonly policy = "auto-approve" as const;

  async authorize(ctx: AuthorizationContext): Promise<AuthorizationDecision> {
    return {
      id: ctx.entry.id,
      outcome: "allow",
      verbs: ctx.requestedVerbs,
      reason: "auto-approved (permissive stub authorizer)",
    };
  }
}

/**
 * The pend policy modes (configurable, ADR-007 "pluggable policy"):
 *  - "confirm-risky" (DEFAULT): pend only the risky surface (see `UserConfirmAuthorizer`
 *    doc); auto-allow first-party reads. The boundary that keeps low-risk UX sane.
 *  - "confirm-all": pend EVERY grant (the stricter "confirm everything" mode). Even a
 *    first-party read awaits a human. Nothing auto-allows except a re-use of an
 *    already-human-approved grant (`hasPriorApproval`).
 */
export type ConfirmMode = "confirm-risky" | "confirm-all";

export interface UserConfirmOptions {
  /** Pend policy mode. Default "confirm-risky". */
  mode?: ConfirmMode;
  /**
   * The set of source ids considered FIRST-PARTY (non-extension). Defaults to the
   * registry's `RESERVED_SOURCE_IDS` (the compile-time MODULES + obsidian/mock).
   * A capability whose source is NOT in this set is treated as extension-sourced,
   * and ANY verb on it pends (the extension ecosystem is the self-grant RCE path
   * the linchpin closes).
   */
  firstPartySources?: ReadonlySet<SourceId>;
  /**
   * Provider of the LIVE managed-source-id set (ADR-018 `managed` class — sources the
   * user added through the trusted admin UI). A `managed` source shares first-party
   * READ posture (auto-allow) but its write/exec still pends. Absent ⇒ no managed
   * sources (every non-first-party source is `extension`).
   */
  managedSources?: () => ReadonlySet<SourceId>;
  /** The default-trust-window table (ADR-018 D-window). Defaults to the ratified table. */
  defaultTrustWindows?: DefaultTrustWindows;
}

/** Is this capability first-party (i.e. NOT an extension-registered source)? */
export function isFirstPartyEntry(
  entry: CapabilityEntry,
  firstParty: ReadonlySet<SourceId>,
): boolean {
  const source = entry.source || deriveSource(entry.id);
  return firstParty.has(source);
}

/** Resolve the 3-class provenance for an entry (first-party / managed / extension). */
function provenanceOfEntry(
  entry: CapabilityEntry,
  managed: ReadonlySet<SourceId>,
): Provenance {
  const source = entry.source || deriveSource(entry.id);
  return entry.provenance ?? provenanceFor(source, managed);
}

/**
 * Classify a single grant request as risky (must pend) or low-risk (may auto-allow)
 * under "confirm-risky", 3-class (ADR-018). PURE — also used by the register-confirm
 * prompt builder to explain WHY something pends. Returns a reason string when it pends,
 * else undefined.
 *
 * PENDS when ANY of:
 *  - the requested verbs include `write` or `execute` (a mutating / side-effecting grant) —
 *    pends regardless of provenance (write/exec is a different risk class);
 *  - the capability is EXTENSION-sourced — ANY verb pends (incl. read), because a
 *    runtime-registered extension is exactly the self-grant attack surface.
 * AUTO-ALLOWS otherwise: `read` (only) on a FIRST-PARTY or MANAGED capability (a
 * managed source was human-vetted at add-time, so it shares first-party read posture).
 */
export function riskyGrantReason(
  entry: CapabilityEntry,
  verbs: GrantVerb[],
  firstParty: ReadonlySet<SourceId>,
  managed?: ReadonlySet<SourceId>,
): string | undefined {
  const provenance = provenanceOfEntry(entry, managed ?? new Set<SourceId>());
  // Re-derive provenance against the supplied first-party set when it differs from the
  // registry default (tests inject a custom first-party set): a source in `firstParty`
  // is first-party even if the registry's reserved set disagrees.
  const effectiveProvenance: Provenance = isFirstPartyEntry(entry, firstParty)
    ? "first-party"
    : provenance;
  if (effectiveProvenance === "extension") {
    return `granting ${verbs.join("/") || "access"} on extension-sourced capability ${entry.id} (non-first-party) requires a human decision`;
  }
  if (verbs.includes("write") || verbs.includes("execute")) {
    return `granting ${verbs.filter((v) => v === "write" || v === "execute").join("/")} on ${entry.id} is a mutating/side-effecting grant and requires a human decision`;
  }
  return undefined;
}

/**
 * THE HUMAN-IN-THE-LOOP authorizer (M4 security linchpin). With this as the default
 * policy an agent that holds a connection-key CANNOT self-grant execute/write nor
 * grant against an extension-sourced capability: the grant returns "pending" →
 * `grant_pending_user`, no token is minted, and invoke stays default-denied until a
 * human approves in the management client.
 *
 * PEND vs AUTO-ALLOW (documented policy):
 *   PENDS (mode "confirm-risky", the default):
 *     • granting `write` or `execute` on ANY capability;
 *     • granting ANY verb on an EXTENSION-sourced (non-first-party) capability;
 *     (register-confirm for a transport-backed extension is enforced separately at the
 *      `POST /extensions` endpoint via the same approve/deny channel.)
 *   AUTO-ALLOWS:
 *     • granting `read` on a FIRST-PARTY capability (e.g. obsidian.vault.read) — keeps
 *       low-risk UX sane and does not break shipped first-party read flows;
 *     • re-using a grant a human already approved for (agentId, id) (`hasPriorApproval`).
 *   EXCEPT — a low-risk read that would otherwise auto-allow PENDS when (agentId, id) carries a
 *   live REVOCATION TOMBSTONE (`ctx.revokedTombstone`, Fix 1): a just-revoked capability must not
 *   silently re-acquire; a fresh human approval lifts the tombstone.
 *   "confirm-all" mode tightens this to pend EVERYTHING except a `hasPriorApproval` re-use.
 *
 * This authorizer is STATELESS about the pending records themselves — it only renders
 * the decision. The GrantService owns the pending lifecycle (track → human approve/deny
 * → mint), which is also the surface the admin approve/deny endpoints drive. That keeps
 * one source of truth for "what is awaiting a human".
 */
export class UserConfirmAuthorizer implements Authorizer {
  readonly policy = "user-confirm" as const;
  private readonly mode: ConfirmMode;
  private readonly firstParty: ReadonlySet<SourceId>;
  private readonly managed: () => ReadonlySet<SourceId>;
  private readonly defaultWindows: DefaultTrustWindows;

  constructor(opts?: UserConfirmOptions) {
    this.mode = opts?.mode ?? "confirm-risky";
    this.firstParty = opts?.firstPartySources ?? RESERVED_SOURCE_IDS;
    this.managed = opts?.managedSources ?? (() => new Set<SourceId>());
    this.defaultWindows = opts?.defaultTrustWindows ?? DEFAULT_TRUST_WINDOWS;
  }

  /** Whether an agent id is anonymous (session-only, no durable standing grant). */
  private isAnon(agentId?: string): boolean {
    return !agentId || agentId.startsWith("anon:");
  }

  /** Resolve the 3-class provenance for a context's entry. */
  private provenanceOf(ctx: AuthorizationContext): Provenance {
    const managed = this.managed();
    return isFirstPartyEntry(ctx.entry, this.firstParty)
      ? "first-party"
      : provenanceOfEntry(ctx.entry, managed);
  }

  /**
   * The recommended default trust-window for a decision (ADR-018, per class+verb).
   * An `anon:*` identity is CAPPED to `once` — never a durable standing grant.
   */
  private recommendedWindow(ctx: AuthorizationContext, provenance: Provenance): TrustWindow {
    if (this.isAnon(ctx.agentId)) return { kind: "once" };
    return recommendedTrustWindowFor(provenance, ctx.requestedVerbs, this.defaultWindows);
  }

  async authorize(ctx: AuthorizationContext): Promise<AuthorizationDecision> {
    const provenance = this.provenanceOf(ctx);
    const sensitivity = sensitivityFor({ ...ctx.entry, provenance }, ctx.requestedVerbs);
    const recommendedTrustWindow = this.recommendedWindow(ctx, provenance);
    const posture = { provenance, sensitivity, recommendedTrustWindow };

    // A grant a human ALREADY approved for this (agent, capability) never re-prompts —
    // but ONLY when it is STANDING and unexpired (a "once"/expired grant must NOT
    // short-circuit). The GrantService computes `hasPriorApproval` with that check.
    if (ctx.hasPriorApproval) {
      return {
        id: ctx.entry.id,
        outcome: "allow",
        verbs: ctx.requestedVerbs,
        reason: "re-using a previously human-approved standing grant",
        ...posture,
      };
    }

    if (this.mode === "confirm-all") {
      return {
        id: ctx.entry.id,
        outcome: "pending",
        reason: `confirm-all policy: granting ${ctx.requestedVerbs.join("/") || "access"} on ${ctx.entry.id} awaits a human decision`,
        ...posture,
      };
    }

    const reason = riskyGrantReason(ctx.entry, ctx.requestedVerbs, this.firstParty, this.managed());
    if (reason) {
      return { id: ctx.entry.id, outcome: "pending", reason, ...posture };
    }
    // REVOCATION TOMBSTONE (Fix 1) — checked BEFORE the low-risk auto-allow. A just-revoked
    // (agentId, capability) must NOT silently re-auto-allow on re-request: "Revoke is the complete
    // stop." Pend it so a human re-confirms; that fresh approval lifts the tombstone (GrantService).
    if (ctx.revokedTombstone) {
      return {
        id: ctx.entry.id,
        outcome: "pending",
        reason: `re-acquiring just-revoked ${ctx.entry.id} requires a human decision (revocation tombstone)`,
        ...posture,
      };
    }
    return {
      id: ctx.entry.id,
      outcome: "allow",
      verbs: ctx.requestedVerbs,
      reason: `low-risk ${provenance} read auto-allowed (confirm-risky policy)`,
      ...posture,
    };
  }
}

/**
 * The Authorizer the gateway uses by DEFAULT (M4): the human-in-the-loop
 * `UserConfirmAuthorizer`. This is the linchpin — the extension ecosystem and any
 * write/execute grant now require a real human approval. Tests/demos that exercise
 * unrelated mechanics inject `AutoApproveAuthorizer` explicitly.
 */
export function defaultAuthorizer(opts?: UserConfirmOptions): Authorizer {
  return new UserConfirmAuthorizer(opts);
}
