/**
 * Grant service (§4, §4a, §4b, §4c) — the grant→authorizer→token pipeline and the
 * pending-grant tracker, sitting between the endpoint handlers and the stores.
 *
 * Responsibilities:
 *  - run each requested grant through the pluggable `Authorizer` (ADR-007),
 *  - on allow: persist the grant + synthesize workflow transitive scopes (ADR-012),
 *  - mint a scoped-token covering the approved scopes (signToken),
 *  - on pending: track it for `GET /grants/status` resolution (ADR-014),
 *  - refresh: re-mint from the persisted grant, bounded by grant validity (ADR-011),
 *  - revoke: by jti or by (agentId, capabilityId) (ADR-010),
 *  - audit every grant change + token lifecycle event.
 */

import type {
  Authorizer,
  BundleView,
  BundleContextResponse,
  CapabilityEntry,
  CapabilityId,
  GrantContextRef,
  GrantRequest,
  GrantResponse,
  GrantPendingResponse,
  GrantStatusResponse,
  PendingNarration,
  Provenance,
  ScopeConstraint,
  ScopedToken,
  Sensitivity,
  StandingGrant,
  TokenScope,
  TransitiveGrant,
  TrustWindow,
  RefreshResponse,
  RevokeResponse,
  GrantVerb,
  SourceId,
  ExtensionManifest,
  ExtensionRegisterResponse,
} from "@plexus/protocol";
import { MAX_SKILL_BODY_BYTES } from "../sources/extension.ts";
import { randomUUID } from "node:crypto";
import type { GatewayState } from "./state.ts";
import type { Session } from "./sessions.ts";
import { signToken, getInstanceId } from "../auth/index.ts";
import { TOKEN_LIFETIME_MS } from "../auth/index.ts";
import {
  normalizeDecision,
  resolveVerbs,
  synthesizeTransitive,
  resolveWindowExpiry,
  isStandingAndUnexpired,
  viewOfGrant,
  type PersistedGrant,
} from "./grants.ts";
import {
  provenanceFor,
  sensitivityFor,
  recommendedTrustWindowFor,
} from "./capability-registry.ts";
import { authAdvertisement } from "./well-known.ts";

/** The two kinds of thing a human approves: a deferred grant, or an extension register. */
export type PendingKind = "grant" | "register";

/** Approximate ms a window kind stands (for SHORTEN comparison; `once`=0, sentinels=∞). */
function windowRank(w: TrustWindow): number {
  switch (w.kind) {
    case "once":
      return 0;
    case "1h":
      return 60 * 60 * 1000;
    case "1d":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "custom":
      return typeof w.ms === "number" && Number.isFinite(w.ms) ? w.ms : 7 * 24 * 60 * 60 * 1000;
    case "until-revoked":
      return Number.POSITIVE_INFINITY;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}

/** The SHORTER of a requested vs the per-class ceiling (agent advisory path, ADR-018). */
function shorterWindow(requested: TrustWindow, ceiling: TrustWindow): TrustWindow {
  return windowRank(requested) <= windowRank(ceiling) ? requested : ceiling;
}

/** A user-legible phrase for a trust-window (for the gateway-authored narration). */
function windowPhraseOf(w: TrustWindow): string {
  switch (w.kind) {
    case "once":
      return "for this one request only";
    case "1h":
      return "for up to 1 hour";
    case "1d":
      return "for up to 1 day";
    case "7d":
      return "for up to 7 days";
    case "until-revoked":
      return "until you revoke it";
    case "custom":
      return "for the chosen duration";
    default:
      return "for the chosen duration";
  }
}

/**
 * Server-side cap on the agent-declared `purpose` free-text (AUTHZ-UX §2.N1). NEVER
 * trust client length — `sanitizePurpose` truncates to this regardless of input.
 */
export const MAX_AGENT_PURPOSE_CHARS = 280;

/**
 * Render-safe the agent's `purpose` (AUTHZ-UX §2.N1, anti-abuse): strip control chars
 * (including newlines/tabs — it's a one-block claim, not multi-line markup), collapse
 * whitespace, and HARD-truncate to `MAX_AGENT_PURPOSE_CHARS` server-side. Returns
 * undefined for empty/whitespace-only input so an absent purpose stays absent. The UI
 * renders the result as PLAIN TEXT in a block labeled "the agent says:" — never merged
 * with the gateway narration (anti-injection).
 */
export function sanitizePurpose(raw: unknown, max = MAX_AGENT_PURPOSE_CHARS): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Strip C0/C1 control chars (newlines, tabs, escapes...) by mapping each to a space,
  // then collapse whitespace runs. Render-safe: the result is one plain-text line that
  // can NEVER inject newlines or escape sequences into the approval UI.
  let stripped = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    stripped += isControl ? " " : ch;
  }
  const cleaned = stripped.replace(/\s+/g, " ").trim();
  if (cleaned === "") return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/**
 * Deep-equal two scope constraints (AUTHZ-UX §3). Used to decide whether a prior STANDING
 * grant's constraint MATCHES a new request's constraint — a constrained prior grant must not
 * short-circuit a broader/differently-constrained re-request (a constraint only narrows). Both
 * absent ⇒ equal; otherwise a stable JSON compare (the shapes are small, flat, JSON-clean).
 */
function constraintsEqual(a: ScopeConstraint | undefined, b: ScopeConstraint | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Shorter cap for the agent purpose when embedded in the one-line notification (AUTHZ-UX §2.N2). */
const NOTIFICATION_PURPOSE_CHARS = 48;
/** Overall cap on the gateway-authored `notificationLine` (~120 chars, AUTHZ-UX §2.N2). */
const NOTIFICATION_LINE_CHARS = 120;

/**
 * A pending GRANT request awaiting a human decision (ADR-014 — the `GET /grants/status`
 * channel). On approval the recorded scopes are persisted + a token minted into the
 * record; the polling agent collects it.
 */
interface PendingGrantRecord {
  pendingId: string;
  kind: "grant";
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  sessionId: string;
  agentId: string;
  capabilities: CapabilityId[];
  /** The scopes the user is approving, captured at request time (id → verbs). */
  scopes: TokenScope[];
  /** Workflow ids among `scopes` whose transitive members must be synthesized on approve. */
  workflowIds: CapabilityId[];
  /** Human-facing risk reasons surfaced in the approval UI. */
  reasons: string[];
  /**
   * The trust-window the AGENT proposed on `PUT /grants` (ADR-018). ADVISORY — the
   * admin/human approve path may override it (and may SHORTEN, never lengthen past
   * the per-class ceiling). Undefined ⇒ the gateway uses the per-class default.
   */
  requestedTrustWindow?: TrustWindow;
  /** Gateway-authored narration the agent relays to the user (ADR-018). */
  pendingNarration: PendingNarration[];
  /**
   * The AGENT-declared free-text purpose (AUTHZ-UX §2.N1) — already sanitized + truncated
   * server-side. Shown to the human labeled "the agent says:", NEVER merged into the
   * gateway-authored narration. Undefined ⇒ the UI shows "(agent gave no reason)".
   */
  agentPurpose?: string;
  /** The requesting client's name/version (from the Session) for the approval-UI chip (AUTHZ-UX §2.N2). */
  client?: { name?: string; version?: string };
  /**
   * AUTHZ-UX §2.N3 / D4: when an agent requested a NAMED task bundle (`GrantRequest.bundle`),
   * the bundle metadata so its risky members PEND AS ONE grouped item. On approval, every
   * member grant is tagged with `bundle.bundleId` (+ the live key-epoch). The anti-self-grant
   * linchpin is preserved — the bundle still pends; it never auto-approves risky members.
   */
  bundle?: { bundleId: string; name: string; context?: GrantContextRef[] };
  token?: ScopedToken;
}

/**
 * A pending EXTENSION REGISTRATION awaiting a human decision (m4sec-auth register-confirm).
 * An UNAPPROVED register does NOT activate the extension; commit (`registerExtension`)
 * runs ONLY after a human approves. Carries the SECURITY-SENSITIVE surface (cli bins /
 * rest hosts / cross-source attaches / verbs) the user is approving.
 */
interface PendingRegisterRecord {
  pendingId: string;
  kind: "register";
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  sessionId: string;
  source: SourceId;
  /** The full register surface the user is approving (security-sensitive details). */
  surface: RegisterApprovalSurface;
  /** Run on approval: actually commit the registration. Returns the register response. */
  commit: () => Promise<ExtensionRegisterResponse>;
  result?: ExtensionRegisterResponse;
}

type PendingRecord = PendingGrantRecord | PendingRegisterRecord;

/**
 * The durable index entry for a task bundle (AUTHZ-UX §2.N3). Holds the human-facing
 * metadata + resolved context; the authority lives entirely in the bundleId-tagged grants.
 */
interface BundleIndexEntry {
  bundleId: string;
  name: string;
  agentId: string;
  createdAt: string;
  /** The attached context, resolved to skill ids (existing skill OR a materialized inline blob). */
  context: { id: CapabilityId; label: string; kind: "skill" | "inline" }[];
}

/** Spec of one member grant when creating a bundle via the admin one-shot path. */
export interface BundleMemberSpec {
  id: CapabilityId;
  verbs?: GrantVerb[];
  constraint?: ScopeConstraint;
}

/** Body of the admin one-shot bundle create (AUTHZ-UX §2.N3, mapped from `POST /admin/api/bundles`). */
export interface CreateBundleInput {
  name: string;
  agentId: string;
  grants: BundleMemberSpec[];
  trustWindow?: TrustWindow;
  context?: GrantContextRef[];
}

/** The security-sensitive detail of a pending registration, for the approval UI. */
export interface RegisterApprovalSurface {
  source: SourceId;
  label: string;
  /** Each capability the extension contributes + the verbs it would require. */
  capabilities: { id: string; label: string; kind: string; transport: string; verbs: GrantVerb[] }[];
  /** cli binaries the extension wants to spawn (security-sensitive). */
  cliBins: string[];
  /** non-loopback rest hosts the extension wants to reach (security-sensitive). */
  restHosts: string[];
  /** Cross-source skill attaches (workflow/skill → foreign source). */
  crossSource: { id: string; sources: SourceId[] }[];
  /** Whether the extension uses a transport-backed (cli/local-rest/stdio/ipc) capability. */
  transportBacked: boolean;
}

/** A pending item projected for the admin approval panel (union of both kinds). */
export interface PendingView {
  pendingId: string;
  kind: PendingKind;
  state: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  /** For grants: the agent requesting. */
  agentId?: string;
  /** For grants: the capability ids + their requested scopes + risk reasons. */
  capabilities?: CapabilityId[];
  scopes?: TokenScope[];
  reasons?: string[];
  /** For grants: gateway-authored narration (ADR-018) for the approve UI. */
  pendingNarration?: PendingNarration[];
  /** For grants: the agent-proposed (advisory) trust-window, if any. */
  requestedTrustWindow?: TrustWindow;
  /**
   * For grants: the AGENT-declared free-text purpose (AUTHZ-UX §2.N1) — sanitized +
   * truncated. Rendered "the agent says:", separate from the gateway narration. Absent
   * ⇒ UI shows "(agent gave no reason)".
   */
  agentPurpose?: string;
  /** For grants: the requesting client's name/version for the approval-UI chip (AUTHZ-UX §2.N2). */
  client?: { name?: string; version?: string };
  /**
   * For agent-requested BUNDLES (AUTHZ-UX §2.N3 / D4): the bundle name + its member rows
   * (id + verbs + optional constraint), so the admin UI renders ONE grouped pending card the
   * human approves in a single action. Present only for an agent-requested task bundle.
   */
  bundle?: { name: string; members: { id: CapabilityId; verbs: GrantVerb[]; constraint?: ScopeConstraint }[] };
  /** For registers: the security-sensitive surface. */
  register?: RegisterApprovalSurface;
}

/**
 * A malformed task-bundle REQUEST (e.g. an agent-proposed bundle containing a member that
 * can never be standing). The `/grants` handler maps this to a clean 400 with the reason,
 * mirroring the admin `createBundle`'s `{ok:false, reason}`. Distinct from a per-cap
 * authorizer denial (which is a normal in-band outcome, not a request-level error).
 */
export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleValidationError";
  }
}

export class GrantService {
  /**
   * The pending store is PROCESS-WIDE (static) so the protocol-endpoint GrantService
   * and the admin GrantService — distinct instances over the same GatewayState — share
   * ONE source of truth for what awaits a human. The agent PUTs a grant through the
   * protocol instance (pending), and the user approves it through the admin instance;
   * both must see the same record. Keyed by GatewayState so parallel test gateways
   * don't cross-talk.
   */
  private get pending(): Map<string, PendingRecord> {
    let map = GrantService.pendingByState.get(this.state);
    if (!map) {
      map = new Map<string, PendingRecord>();
      GrantService.pendingByState.set(this.state, map);
    }
    return map;
  }
  private static readonly pendingByState = new WeakMap<GatewayState, Map<string, PendingRecord>>();

  /**
   * The bundle INDEX (AUTHZ-UX §2.N3) — durable metadata (name, agent, createdAt, attached
   * context) keyed by bundleId. The grant MEMBERS live in the normal grant store tagged with
   * `bundleId` (a bundle adds no new authority store); this index only holds the human-facing
   * grouping + context refs. Process-wide (static, keyed by state) so the admin instance and
   * the protocol instance see the same bundles — same discipline as the pending store.
   */
  private get bundles(): Map<string, BundleIndexEntry> {
    let map = GrantService.bundlesByState.get(this.state);
    if (!map) {
      map = new Map<string, BundleIndexEntry>();
      GrantService.bundlesByState.set(this.state, map);
    }
    return map;
  }
  private static readonly bundlesByState = new WeakMap<GatewayState, Map<string, BundleIndexEntry>>();

  constructor(
    private readonly state: GatewayState,
    private readonly authorizer: Authorizer,
  ) {}

  /** Resolve the agent identity for a session (audit + grant keying). */
  private agentIdFor(session: Session): string {
    return session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
  }

  /** Whether an agent id is anonymous (session-only; capped at `once`, no durable standing grant). */
  private isAnon(agentId: string): boolean {
    return agentId.startsWith("anon:");
  }

  /** The LIVE managed-source-id set (ADR-018 `managed` class). */
  private managedSourceIds(): ReadonlySet<SourceId> {
    return new Set(this.state.managedSources.list().map((s) => s.id));
  }

  /**
   * The 3-class provenance for an entry (first-party / managed / extension). Prefers
   * the registry's STAMPED posture (which reads the registry's managed-source provider,
   * the single source of truth wired at state construction) so the grant-service, the
   * manifest, and `.well-known` all agree; falls back to deriving from the source.
   */
  private provenanceOf(entry: CapabilityEntry): Provenance {
    if (entry.provenance) return entry.provenance;
    const stamped =
      typeof this.state.capabilities.stampPosture === "function"
        ? this.state.capabilities.stampPosture(entry)
        : entry;
    return stamped.provenance ?? provenanceFor(entry.source, this.managedSourceIds());
  }

  /**
   * Whether a prior STANDING + UNEXPIRED grant exists for (agentId, capabilityId) —
   * the ONLY thing that short-circuits `hasPriorApproval` (ADR-018). A "once" or
   * expired grant does NOT qualify.
   */
  private hasPriorApproval(
    agentId: string,
    capabilityId: CapabilityId,
    requestedConstraint?: ScopeConstraint,
  ): boolean {
    const g = this.state.grants.get(agentId, capabilityId);
    // D6 (AUTHZ-UX §2.N3): pass the live connection-key epoch so a bundle grant stamped
    // under a rotated-away key no longer short-circuits a re-prompt (the bundle is dropped).
    if (!g || !isStandingAndUnexpired(g, Date.now(), this.state.connectionKey.epoch())) return false;
    // CONSTRAINT-AWARE short-circuit (AUTHZ-UX §3 — a constraint only narrows). The Mode-2
    // contract: a pre-authorized (constrained) standing grant lets the agent work WITHIN scope
    // with NO re-prompts. A real agent's `plexus call` sends a BARE request (it does not know
    // the human-set constraint), so an ABSENT requested constraint INHERITS the standing grant's
    // constraint and short-circuits (frictionless in-scope). An EXPLICIT requested constraint
    // short-circuits ONLY when it deep-equals the standing grant's; a DIFFERENT/broader explicit
    // constraint (e.g. a new Finances/ ask) falls through → the authorizer re-evaluates → Mode-1
    // pend. NEVER widens: on the short-circuit path the caller mints the STANDING grant's
    // constraint (see `grant()`), so a bare request yields a CONSTRAINED token, not an
    // unconstrained one.
    if (requestedConstraint !== undefined && !constraintsEqual(g.constraint, requestedConstraint)) {
      return false;
    }
    return true;
  }

  /**
   * The constraint a granted scope should actually CARRY (AUTHZ-UX §3 — never widen). When a
   * prior STANDING grant short-circuits the authorizer for (agentId, id), the minted/persisted
   * scope MUST carry the STANDING grant's constraint, NOT the request's — so a BARE in-scope
   * request mints a CONSTRAINED token (the granted authority), and a request can never mint a
   * constraint broader than the standing grant's. Returns the standing grant's constraint when a
   * standing grant exists and the request did not pin a DIFFERENT (deep-unequal) one; else the
   * request's own constraint (the normal first-grant path).
   */
  private effectiveConstraint(
    agentId: string,
    capabilityId: CapabilityId,
    requestedConstraint?: ScopeConstraint,
  ): ScopeConstraint | undefined {
    const g = this.state.grants.get(agentId, capabilityId);
    if (!g || !isStandingAndUnexpired(g, Date.now(), this.state.connectionKey.epoch())) {
      return requestedConstraint; // no live prior grant → first-grant path, honor the request.
    }
    // A live standing grant exists. A bare (absent) or matching request inherits its constraint;
    // a DIFFERENT explicit request does not short-circuit (handled in `hasPriorApproval`) and is
    // a fresh authorization whose own constraint applies.
    if (requestedConstraint === undefined || constraintsEqual(g.constraint, requestedConstraint)) {
      return g.constraint;
    }
    return requestedConstraint;
  }

  /**
   * Choose the trust-window for a grant (ADR-018): an explicit window (admin
   * authoritative, or agent advisory) is honored but for the agent path is SHORTENED
   * to the per-class default when it would exceed it (never self-extend past the
   * ceiling). `anon:*` is capped at `once`. Falls back to the per-class default.
   *
   * GENUINELY-PER-USE CEILING (ADR-5, now DEFAULT-with-owner-override / ADR-023): when a
   * cap's own SENSITIVITY recommends per-use approval — `recommendedTrustWindowFor` returns
   * `{kind:"once"}`, EXACTLY the `execute` (running code) case, origin-independent — `once`
   * is the DEFAULT ceiling. It stays a hard floor UNLESS the owner has explicitly opted THIS
   * (agent, capability) into a standing execute grant at connect (`agentSubsets.isStandingExecute`,
   * default-off, double-confirm — `docs/design/agent-authorized-subset.md` §4). An un-opted
   * execute can still NEVER ride a standing grant, admin window or not. read/write caps never
   * have a `once` default, so this clause never fires for them.
   */
  private chooseTrustWindow(opts: {
    agentId: string;
    provenance: Provenance;
    verbs: GrantVerb[];
    requested?: TrustWindow;
    authoritative: boolean;
    /** The capability id — consulted for the per-agent standing-execute opt-in (ADR-023). */
    capabilityId?: CapabilityId;
  }): TrustWindow {
    const def = recommendedTrustWindowFor(
      opts.provenance,
      opts.verbs,
      this.state.config.auth.defaultTrustWindows,
    );
    // anon:* never gets a durable standing grant — cap at once.
    if (this.isAnon(opts.agentId)) return { kind: "once" };
    // GENUINELY-PER-USE ceiling (execute): `def.kind === "once"` means the cap's sensitivity
    // makes per-use the DEFAULT (ADR-5). The owner may lift it for a SPECIFIC (agent, cap) via
    // the standing-execute opt-in (ADR-023, default-off + double-confirm at connect); absent that
    // opt-in the `once` floor holds regardless of any requested/authoritative window.
    const optedStandingExecute =
      !!opts.capabilityId &&
      this.state.agentSubsets?.isStandingExecute(opts.agentId, opts.capabilityId) === true;
    if (def.kind === "once") {
      if (!optedStandingExecute) return { kind: "once" };
      // Opted in: honor the admin's authoritative window; absent → stand until the owner revokes
      // (the "unlimited use, until you revoke" the opt-in promises), subject to allowUntilRevoked.
      if (!opts.requested) {
        return this.state.config.auth.allowUntilRevoked ? { kind: "until-revoked" } : { kind: "7d" };
      }
      if (opts.requested.kind === "until-revoked" && !this.state.config.auth.allowUntilRevoked) {
        return { kind: "7d" };
      }
      return opts.requested;
    }
    if (!opts.requested) return def;
    if (opts.authoritative) {
      // Admin/human pick is authoritative — honor it (clamped at persist time).
      if (opts.requested.kind === "until-revoked" && !this.state.config.auth.allowUntilRevoked) {
        return def;
      }
      return opts.requested;
    }
    // Agent path: advisory — may SHORTEN, never lengthen past the per-class ceiling.
    return shorterWindow(opts.requested, def);
  }

  /**
   * Build the gateway-authored narration for a pending capability (ADR-018). The
   * `summary` is gateway-authored and NEVER contains the agent's `purpose` text. The
   * optional `agentPurpose` (already sanitized) is folded ONLY into the separate
   * gateway-authored `notificationLine` (AUTHZ-UX §2.N2), quoted + truncated, never into
   * `summary` — keeping the agent's claim and the gateway's truth distinct.
   */
  private narrationFor(
    agentId: string,
    entry: CapabilityEntry,
    verbs: GrantVerb[],
    window: TrustWindow,
    agentPurpose?: string,
  ): PendingNarration {
    const provenance = this.provenanceOf(entry);
    const sensitivity: Sensitivity = sensitivityFor({ ...entry, provenance }, verbs);
    const verbList = verbs.length ? verbs.map((v) => v.toUpperCase()).join("/") : "USE";
    const windowPhrase = windowPhraseOf(window);
    const summary =
      `Approving lets ${agentId} ${verbList} ${entry.label} (${provenance}, ${sensitivity}-sensitivity) ${windowPhrase}; revoke anytime in Plexus → Grants.`;
    const notificationLine = this.notificationLineFor(agentId, entry, verbs, agentPurpose);
    return {
      id: entry.id,
      verbs,
      provenance,
      sensitivity,
      defaultTrustWindow: window,
      summary,
      notificationLine,
    };
  }

  /**
   * Build the one-line, GATEWAY-AUTHORED notification form (AUTHZ-UX §2.N2 / D7):
   * `"{agentLabel} wants to {VERBS} {capabilityLabel}{ — “purpose”}"`, the agent purpose
   * quoted + truncated, the whole line capped ~120 chars. Gateway-authored so a future
   * tray's notification can't be spoofed by agent text; web ignores it.
   */
  private notificationLineFor(
    agentId: string,
    entry: CapabilityEntry,
    verbs: GrantVerb[],
    agentPurpose?: string,
  ): string {
    const verbList = verbs.length ? verbs.map((v) => v.toUpperCase()).join("/") : "USE";
    let line = `${agentId} wants to ${verbList} ${entry.label}`;
    if (agentPurpose) {
      const p =
        agentPurpose.length > NOTIFICATION_PURPOSE_CHARS
          ? `${agentPurpose.slice(0, NOTIFICATION_PURPOSE_CHARS - 1)}…`
          : agentPurpose;
      line += ` — “${p}”`;
    }
    return line.length > NOTIFICATION_LINE_CHARS
      ? `${line.slice(0, NOTIFICATION_LINE_CHARS - 1)}…`
      : line;
  }

  /**
   * `PUT /grants`: run each requested grant through the authorizer; mint a token
   * for the approved scopes; track any pending decisions. Returns a `ScopedToken`
   * (possibly with a partial set) or a `GrantPendingResponse`.
   */
  async grant(req: GrantRequest, session: Session): Promise<GrantResponse> {
    const agentId = this.agentIdFor(session);
    // AUTHZ-UX §2.N3 / D4: an agent-requested NAMED task bundle. Allocate the bundleId up
    // front so (a) any pending record carries it (group-pend as one item) and (b) approval
    // tags every member grant with it + the live key-epoch. Context is materialized on
    // APPROVE (so a denied/never-approved bundle leaves no synthetic skill behind).
    const bundleMeta = req.bundle
      ? { bundleId: `bnd_${randomUUID()}`, name: req.bundle.name, context: req.bundle.context }
      : undefined;
    // The admin auto-approve path is authoritative on the trust-window; the agent
    // wire path is advisory (may shorten, never lengthen past the per-class ceiling).
    const authoritative = this.authorizer.policy === "auto-approve";
    const approvedScopes: TokenScope[] = [];
    const transitive: TransitiveGrant[] = [];
    /** The minimum grant expiry across the approved scopes → the token's grantExpiresAt. */
    let minApprovedExpiry = Number.POSITIVE_INFINITY;
    let approvedWindow: TrustWindow | undefined;
    const pendingIds: CapabilityId[] = [];
    const pendingScopes: TokenScope[] = [];
    const pendingReasons: string[] = [];
    const pendingNarration: PendingNarration[] = [];
    const pendingWindows = new Map<CapabilityId, TrustWindow>();
    // AUTHZ-UX §2.N1: the agent's declared purpose for this request, sanitized + truncated
    // server-side (NEVER trust client length). Record-level "first non-empty wins".
    let recordPurpose: string | undefined;

    for (const [id, rawDecision] of Object.entries(req.grants)) {
      const entry = this.state.capabilities.get(id);
      if (!entry) continue; // unknown id — skip (manifest likely stale)
      // EXPOSURE gate: a top-level-DISABLED capability is NOT grantable — reject the
      // request (neither allowed nor pended). It is invisible in discovery, so this is a
      // stale-manifest / probe path; audit a deny and skip so no token/grant is minted.
      if (this.state.exposure?.isDisabled(id)) {
        await this.state.audit.write({
          type: "grant.deny",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          detail: { reason: "capability is disabled at the top level (not exposed)" },
        });
        continue;
      }
      // AUTHORIZED-SUBSET gate (`docs/design/agent-authorized-subset.md` §3.5) — agent path only.
      // A SCOPED agent may only grant WITHIN the owner-declared subset. A request for a capability
      // OUTSIDE it (which the agent also can't see in its manifest) is DENIED, not pended: no owner
      // card, no auto-grant — the silent-read-acquisition + scanning-attack defense. The
      // AUTHORITATIVE admin path (auto-approve — the flow that DEFINES the subset at connect) is
      // exempt, so it is never blocked by a pre-existing or in-flight subset record.
      if (
        !authoritative &&
        this.state.agentSubsets?.isScoped(agentId) === true &&
        !this.state.agentSubsets.isAuthorized(agentId, id)
      ) {
        await this.state.audit.write({
          type: "grant.deny",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          detail: {
            reason: "capability is outside the agent's authorized subset",
            policy: this.authorizer.policy,
          },
        });
        continue;
      }
      const decision = normalizeDecision(rawDecision);
      const purpose = sanitizePurpose(decision.purpose);
      if (purpose && !recordPurpose) recordPurpose = purpose;
      // AUTHZ-UX §3.1: the requested scope constraint (validated/enforced at invoke, fail-closed).
      const constraint = decision.constraint;

      if (decision.decision === "deny") {
        await this.state.audit.write({
          type: "grant.deny",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          detail: { reason: "explicit deny in grant request" },
        });
        continue;
      }

      const requestedVerbs = resolveVerbs(entry, decision);
      const provenance = this.provenanceOf(entry);
      const window = this.chooseTrustWindow({
        agentId,
        provenance,
        verbs: requestedVerbs,
        ...(decision.trustWindow ? { requested: decision.trustWindow } : {}),
        authoritative,
        capabilityId: entry.id,
      });
      // A TASK BUNDLE groups STANDING grants only. A member whose sensitivity caps
      // approvals at `once` (execute, ADR-5/ADR-018) can never stand, so pending it inside
      // a bundle would compose a ticket with an invisible hole — the member never persists
      // on approval and vanishes from the bundle card (the same defect createBundle rejects
      // with `ok:false`). Reject the WHOLE bundle request up front (before anything pends)
      // via BundleValidationError, which the /grants handler maps to a clean 400.
      if (bundleMeta) {
        const wouldStand = resolveWindowExpiry(window, Date.now(), this.state.config.auth.maxTrustWindowMs).standing;
        if (!wouldStand) {
          throw new BundleValidationError(
            `capability "${id}" can never be STANDING (its sensitivity caps approvals at 'once') — ` +
              `a task bundle groups standing grants only; request this capability on its own so it is approved per call`,
          );
        }
      }
      // AUTHZ-UX §3 — Mode-2 in-scope short-circuit + no-widen: a bare (or matching) request
      // against a CONSTRAINED standing grant short-circuits AND inherits that grant's constraint,
      // so a real agent's `plexus call` (which sends no constraint) works in-scope with no pend
      // yet mints a CONSTRAINED token. A DIFFERENT explicit constraint does NOT short-circuit and
      // applies its own constraint (Mode-1 escalation).
      const priorApproval = this.hasPriorApproval(agentId, id, constraint);
      const effectiveConstraint = this.effectiveConstraint(agentId, id, constraint);
      // Fix 1: surface a live revocation tombstone for this pair so the authorizer pends a
      // just-revoked low-risk read instead of silently re-auto-allowing it.
      const revokedTombstone = agentId ? this.state.grants.hasTombstone(agentId, id) : false;
      const outcome = await this.authorizer.authorize({
        sessionId: session.id,
        ...(agentId ? { agentId } : {}),
        entry,
        requestedVerbs,
        hasPriorApproval: priorApproval,
        revokedTombstone,
      });

      if (outcome.outcome === "deny") {
        await this.state.audit.write({
          type: "grant.deny",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          verbs: requestedVerbs,
          detail: { reason: outcome.reason ?? "authorizer denied", policy: this.authorizer.policy },
        });
        continue;
      }

      if (outcome.outcome === "pending") {
        pendingIds.push(id);
        // Capture the EXACT scope the user is approving so approval mints precisely
        // what was requested (no re-derivation drift). The authorizer never widens.
        // The constraint (if any) rides with the captured scope so approval persists it.
        pendingScopes.push({ id: entry.id, verbs: requestedVerbs, ...(constraint ? { constraint } : {}) });
        pendingWindows.set(entry.id, window);
        pendingNarration.push(this.narrationFor(agentId, entry, requestedVerbs, window, purpose));
        if (outcome.reason) pendingReasons.push(outcome.reason);
        await this.state.audit.write({
          type: "grant.pending",
          agentId,
          sessionId: session.id,
          capabilityId: id,
          verbs: requestedVerbs,
          detail: {
            reason: outcome.reason ?? "awaiting user decision",
            policy: this.authorizer.policy,
            trustWindow: window.kind,
            ...(purpose ? { agentPurpose: purpose } : {}),
            ...(constraint ? { constrained: true } : {}),
            ...(bundleMeta ? { bundleId: bundleMeta.bundleId, bundleName: bundleMeta.name } : {}),
          },
        });
        continue;
      }

      // allow → the authorizer may narrow the verbs. The minted+persisted scope carries the
      // EFFECTIVE constraint (the standing grant's on a short-circuit; the request's on a first
      // grant) — NEVER broader than a prior constrained grant (no-widen invariant).
      const verbs = (outcome.verbs ?? requestedVerbs) as GrantVerb[];
      // Preserve the prior grant's bundle tag on a re-mint so a bundle member re-granted by a
      // bare in-scope request stays grouped + epoch-stamped (don't silently un-bundle it).
      const priorGrant = priorApproval ? this.state.grants.get(agentId, id) : undefined;
      const bundleTag =
        priorGrant?.bundleId && typeof priorGrant.keyEpoch === "number"
          ? { bundleId: priorGrant.bundleId, keyEpoch: priorGrant.keyEpoch }
          : undefined;
      const { expiresAt } = this.persistGrant(agentId, entry, verbs, window, undefined, effectiveConstraint, bundleTag);
      minApprovedExpiry = Math.min(minApprovedExpiry, Date.parse(expiresAt));
      approvedWindow = approvedWindow ?? window;
      approvedScopes.push({ id: entry.id, verbs, ...(effectiveConstraint ? { constraint: effectiveConstraint } : {}) });
      await this.state.audit.write({
        type: "grant.allow",
        agentId,
        sessionId: session.id,
        capabilityId: entry.id,
        verbs,
        detail: {
          policy: this.authorizer.policy,
          trustWindow: window.kind,
          ...(purpose ? { agentPurpose: purpose } : {}),
          ...(effectiveConstraint ? { constrained: true } : {}),
          // Audit is the durable side of the bundle join (the grant row dies on revoke) —
          // a bundle member's re-mint must carry its bundleId or the ledger story breaks.
          ...(bundleTag ? { bundleId: bundleTag.bundleId } : {}),
        },
      });

      // Workflow transitive member scopes (ADR-012).
      if (entry.kind === "workflow" && entry.members?.length) {
        const { memberScopes, transitive: tg } = synthesizeTransitive(entry, (mid) =>
          this.state.capabilities.get(mid),
        );
        for (const ms of memberScopes) {
          approvedScopes.push(ms);
          const { expiresAt: mExp } = this.persistGrant(
            agentId,
            this.state.capabilities.get(ms.id)!,
            ms.verbs,
            window,
            entry.id,
          );
          minApprovedExpiry = Math.min(minApprovedExpiry, Date.parse(mExp));
        }
        if (tg.memberScopes.length) transitive.push(tg);
      }
    }

    // If nothing was approved but something is pending → a pure pending response.
    if (approvedScopes.length === 0 && pendingIds.length > 0) {
      return this.makePending(session, agentId, pendingIds, pendingScopes, pendingReasons, pendingNarration, pendingWindows, recordPurpose, bundleMeta);
    }

    const grantExpiresAt = Number.isFinite(minApprovedExpiry)
      ? new Date(minApprovedExpiry).toISOString()
      : undefined;
    const token = this.mintToken(session, agentId, approvedScopes, grantExpiresAt, transitive, approvedWindow);

    if (pendingIds.length > 0) {
      // Partial: some approved (token), some pending.
      const pending = this.makePending(session, agentId, pendingIds, pendingScopes, pendingReasons, pendingNarration, pendingWindows, recordPurpose, bundleMeta);
      pending.partialToken = token;
      return pending;
    }
    return token;
  }

  /** Persist a grant under a chosen trust-window; returns the resolved expiry/standing. */
  private persistGrant(
    agentId: string,
    entry: CapabilityEntry,
    verbs: GrantVerb[],
    window: TrustWindow,
    synthesizedFor?: CapabilityId,
    constraint?: ScopeConstraint,
    bundle?: { bundleId: string; keyEpoch: number },
  ): { expiresAt: string; standing: boolean } {
    const grantedAtMs = Date.now();
    const { expiresAt, standing } = resolveWindowExpiry(
      window,
      grantedAtMs,
      this.state.config.auth.maxTrustWindowMs,
    );
    const grant: PersistedGrant = {
      agentId,
      capabilityId: entry.id,
      verbs,
      grantedAt: new Date(grantedAtMs).toISOString(),
      expiresAt,
      trustWindow: window,
      standing,
      ...(synthesizedFor ? { synthesizedFor } : {}),
      ...(constraint ? { constraint } : {}),
      // AUTHZ-UX §2.N3: a bundle member carries its bundleId + the live key-epoch (D6).
      ...(bundle ? { bundleId: bundle.bundleId, keyEpoch: bundle.keyEpoch } : {}),
    };
    if (standing) {
      // A STANDING grant is the durable record refresh re-mints from — persist it.
      this.state.grants.put(grant);
      // Fix 1 (revocation tombstone): (re)establishing a standing grant for this pair is a fresh
      // human approval (this path is only reached via approve()/admin/bundle when a tombstone could
      // exist — a tombstoned low-risk read now PENDS upstream, so it never auto-allows to here).
      // Lift any tombstone so the restored access is frictionless going forward.
      this.state.grants.clearTombstone(agentId, entry.id);
    }
    // Fix 2: a "once"/non-standing grant is NOT written to the durable ledger. The single-use
    // token is already minted by the caller; `expiresAt === grantedAt` blocks refresh re-mint and
    // `isStandingAndUnexpired` already returns false — so a durable record would only linger in the
    // Grants tab looking permanent. (Protocol intent: single-use ⇒ no durable standing grant.)
    return { expiresAt, standing };
  }

  private mintToken(
    session: Session,
    agentId: string,
    scopes: TokenScope[],
    grantExpiresAt: string | undefined,
    transitive: TransitiveGrant[],
    trustWindow?: TrustWindow,
  ): ScopedToken {
    const { token, claims } = signToken({
      sub: agentId,
      iss: getInstanceId(),
      sessionId: session.id,
      scopes,
      ...(grantExpiresAt ? { grantExpiresAtMs: Date.parse(grantExpiresAt) } : {}),
    });
    this.state.sessions.trackJti(session.id, claims.jti);
    void this.state.audit.write({
      type: "token.issue",
      agentId,
      jti: claims.jti,
      sessionId: session.id,
      detail: { scopeCount: scopes.length, ...(grantExpiresAt ? { grantExpiresAt } : {}) },
    });
    return {
      token,
      scopes,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      ...(transitive.length ? { transitive } : {}),
      ...(grantExpiresAt ? { grantExpiresAt } : {}),
      ...(trustWindow ? { trustWindow } : {}),
    };
  }

  private makePending(
    session: Session,
    agentId: string,
    ids: CapabilityId[],
    scopes: TokenScope[],
    reasons: string[],
    pendingNarration: PendingNarration[],
    windows: Map<CapabilityId, TrustWindow>,
    agentPurpose?: string,
    bundle?: { bundleId: string; name: string; context?: GrantContextRef[] },
  ): GrantPendingResponse {
    const pendingId = `pend_${randomUUID()}`;
    // The pending record carries the proposed window per id (first wins for the record).
    const firstWindow = ids.map((id) => windows.get(id)).find((w): w is TrustWindow => !!w);
    // The requesting client's name/version (AUTHZ-UX §2.N2) — for the approval-UI chip.
    const client =
      session.client && (session.client.name || session.client.version)
        ? {
            ...(session.client.name ? { name: session.client.name } : {}),
            ...(session.client.version ? { version: session.client.version } : {}),
          }
        : undefined;
    const record: PendingGrantRecord = {
      pendingId,
      kind: "grant",
      state: "pending",
      createdAt: new Date().toISOString(),
      sessionId: session.id,
      agentId,
      capabilities: ids,
      scopes,
      workflowIds: scopes
        .map((s) => this.state.capabilities.get(s.id))
        .filter((e): e is CapabilityEntry => !!e && e.kind === "workflow" && !!e.members?.length)
        .map((e) => e.id),
      reasons,
      pendingNarration,
      ...(firstWindow ? { requestedTrustWindow: firstWindow } : {}),
      ...(agentPurpose ? { agentPurpose } : {}),
      ...(client ? { client } : {}),
      ...(bundle ? { bundle } : {}),
    };
    this.pending.set(pendingId, record);
    // Management push (REDESIGN-ARCHITECTURE §2.3): a new pending GRANT arrived —
    // drives the tray badge + the native "Agent X wants to WRITE…" notification.
    this.state.events.publish({
      type: "pending_added",
      item: {
        pendingId,
        kind: "grant",
        createdAt: record.createdAt,
        agentId,
        capabilities: ids,
        ...(pendingNarration.length ? { pendingNarration } : {}),
      },
    });
    const adv = authAdvertisement(this.state.config);
    return {
      status: "grant_pending_user",
      pendingId,
      pending: ids,
      statusUrl: `${adv.grantStatusUrl}?pendingId=${pendingId}`,
      ...(adv.consoleUrl ? { approvalUrl: adv.consoleUrl } : {}),
      ...(pendingNarration.length ? { pendingNarration } : {}),
    };
  }

  /** `GET /grants/status?pendingId=…`. */
  status(pendingId: string): GrantStatusResponse | undefined {
    const record = this.pending.get(pendingId);
    if (!record || record.kind !== "grant") return undefined;
    return {
      pendingId,
      state: record.state,
      capabilities: record.capabilities,
      ...(record.token ? { token: record.token } : {}),
      ...(record.pendingNarration?.length ? { pendingNarration: record.pendingNarration } : {}),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // PENDING LIFECYCLE — the human approve/deny channel (m4sec-auth). Driven by the
  // management session (connection-key authenticated). Agents poll GET /grants/status.
  // ──────────────────────────────────────────────────────────────────────────────

  /** List every pending item (grants + registrations) for the admin approval panel. */
  listPending(): PendingView[] {
    const out: PendingView[] = [];
    for (const rec of this.pending.values()) {
      if (rec.state !== "pending") continue;
      if (rec.kind === "grant") {
        out.push({
          pendingId: rec.pendingId,
          kind: "grant",
          state: rec.state,
          createdAt: rec.createdAt,
          agentId: rec.agentId,
          capabilities: rec.capabilities,
          scopes: rec.scopes,
          reasons: rec.reasons,
          ...(rec.pendingNarration?.length ? { pendingNarration: rec.pendingNarration } : {}),
          ...(rec.requestedTrustWindow ? { requestedTrustWindow: rec.requestedTrustWindow } : {}),
          ...(rec.agentPurpose ? { agentPurpose: rec.agentPurpose } : {}),
          ...(rec.client ? { client: rec.client } : {}),
          // AUTHZ-UX §2.N3 / D4: a grouped bundle pending card — name + member rows.
          ...(rec.bundle
            ? {
                bundle: {
                  name: rec.bundle.name,
                  members: rec.scopes.map((s) => ({
                    id: s.id,
                    verbs: s.verbs,
                    ...(s.constraint ? { constraint: s.constraint } : {}),
                  })),
                },
              }
            : {}),
        });
      } else {
        out.push({
          pendingId: rec.pendingId,
          kind: "register",
          state: rec.state,
          createdAt: rec.createdAt,
          register: rec.surface,
        });
      }
    }
    // Newest first.
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Track a pending EXTENSION REGISTRATION awaiting a human decision. The commit
   * (`registerExtension`) runs ONLY on approve. Returns the pendingId + statusUrl so
   * the agent can poll the SAME `GET /grants/status` channel for the outcome.
   */
  makeRegisterPending(
    sessionId: string,
    source: SourceId,
    surface: RegisterApprovalSurface,
    commit: () => Promise<ExtensionRegisterResponse>,
  ): GrantPendingResponse {
    const pendingId = `pend_${randomUUID()}`;
    const record: PendingRegisterRecord = {
      pendingId,
      kind: "register",
      state: "pending",
      createdAt: new Date().toISOString(),
      sessionId,
      source,
      surface,
      commit,
    };
    this.pending.set(pendingId, record);
    // Management push (REDESIGN-ARCHITECTURE §2.3): a new pending REGISTER arrived.
    this.state.events.publish({
      type: "pending_added",
      item: {
        pendingId,
        kind: "register",
        createdAt: record.createdAt,
        source,
      },
    });
    const adv = authAdvertisement(this.state.config);
    return {
      status: "grant_pending_user",
      pendingId,
      pending: [source],
      statusUrl: `${adv.grantStatusUrl}?pendingId=${pendingId}`,
      ...(adv.consoleUrl ? { approvalUrl: adv.consoleUrl } : {}),
    };
  }

  /** A pending register's terminal result (for the `POST /extensions` poll, if needed). */
  registerResult(pendingId: string):
    | { state: "pending" | "denied" | "expired" }
    | { state: "approved"; result: ExtensionRegisterResponse }
    | undefined {
    const rec = this.pending.get(pendingId);
    if (!rec || rec.kind !== "register") return undefined;
    if (rec.state === "approved" && rec.result) return { state: "approved", result: rec.result };
    return { state: rec.state === "approved" ? "pending" : rec.state };
  }

  /**
   * APPROVE a pending item (the user's "approve" action in the management client).
   *  - grant: persist the captured scopes (+ synthesize workflow transitive scopes),
   *    mint the token INTO the record, publish a `grant_resolved` event, audit allow.
   *  - register: run the deferred commit (`registerExtension`); audit the activation.
   * Returns the resolved view (or undefined if no such pending item / already terminal).
   */
  async approve(
    pendingId: string,
    opts?: { trustWindow?: TrustWindow; agentId?: string },
  ): Promise<{ ok: boolean; kind?: PendingKind; reason?: string }> {
    const rec = this.pending.get(pendingId);
    if (!rec || rec.state !== "pending") return { ok: false, reason: "no such pending item (or already resolved)" };

    if (rec.kind === "grant") {
      // DECOY FIX (ADR-018): an admin approve may RE-TARGET the grant to a REAL agentId
      // (the picker) so the real agent's next request hits `hasPriorApproval`. Default:
      // the agent that requested it. `plexus-admin` is never a grant subject when a
      // real target is supplied.
      const targetAgentId = opts?.agentId ?? rec.agentId;
      const approvedScopes: TokenScope[] = [];
      const transitive: TransitiveGrant[] = [];
      let minExpiry = Number.POSITIVE_INFINITY;
      let approvedWindow: TrustWindow | undefined;
      // AUTHZ-UX §2.N3 / D4: if this pending was a NAMED task bundle, every approved member
      // is tagged with the bundleId + the live key-epoch (D6) so the ledger groups them and
      // a key rotation drops the whole bundle. Context is materialized below on approve.
      const bundleTag = rec.bundle
        ? { bundleId: rec.bundle.bundleId, keyEpoch: this.state.connectionKey.epoch() }
        : undefined;
      for (const scope of rec.scopes) {
        const entry = this.state.capabilities.get(scope.id);
        if (!entry) continue; // unregistered between request + approve — skip.
        // The human's pick (opts.trustWindow) is AUTHORITATIVE; else the agent's
        // advisory proposal on the record; else the per-class default. `anon:*` capped.
        const provenance = this.provenanceOf(entry);
        const window = this.chooseTrustWindow({
          agentId: targetAgentId,
          provenance,
          verbs: scope.verbs,
          ...(opts?.trustWindow ?? rec.requestedTrustWindow
            ? { requested: opts?.trustWindow ?? rec.requestedTrustWindow }
            : {}),
          authoritative: true,
          capabilityId: entry.id,
        });
        approvedWindow = approvedWindow ?? window;
        // The scope's CONSTRAINT (captured at request time, AUTHZ-UX §3.1) is enforced —
        // persist it + carry it onto the minted token scope so invoke checks it.
        const constraint = scope.constraint;
        const { expiresAt } = this.persistGrant(targetAgentId, entry, scope.verbs, window, undefined, constraint, bundleTag);
        minExpiry = Math.min(minExpiry, Date.parse(expiresAt));
        approvedScopes.push({ id: entry.id, verbs: scope.verbs, ...(constraint ? { constraint } : {}) });
        await this.state.audit.write({
          type: "grant.allow",
          agentId: targetAgentId,
          sessionId: rec.sessionId,
          capabilityId: entry.id,
          verbs: scope.verbs,
          detail: {
            policy: this.authorizer.policy,
            viaApproval: pendingId,
            trustWindow: window.kind,
            ...(rec.agentPurpose ? { agentPurpose: rec.agentPurpose } : {}),
            ...(constraint ? { constrained: true } : {}),
            ...(rec.bundle ? { bundleId: rec.bundle.bundleId, bundleName: rec.bundle.name } : {}),
          },
        });
        if (entry.kind === "workflow" && entry.members?.length) {
          const { memberScopes, transitive: tg } = synthesizeTransitive(entry, (mid) =>
            this.state.capabilities.get(mid),
          );
          for (const ms of memberScopes) {
            approvedScopes.push(ms);
            const { expiresAt: mExp } = this.persistGrant(
              targetAgentId,
              this.state.capabilities.get(ms.id)!,
              ms.verbs,
              window,
              entry.id,
            );
            minExpiry = Math.min(minExpiry, Date.parse(mExp));
          }
          if (tg.memberScopes.length) transitive.push(tg);
        }
      }
      // AUTHZ-UX §2.N3 / D3: materialize the agent-requested bundle's context now that it is
      // approved — attach existing skills + materialize inline blobs as synthetic-source skills
      // (the registerExtension/materialize path), recorded in the bundle index for grouping.
      if (rec.bundle) {
        await this.materializeBundleContext(
          rec.bundle.bundleId,
          rec.bundle.name,
          targetAgentId,
          rec.bundle.context ?? [],
        );
      }
      const grantExpiresAt = Number.isFinite(minExpiry) ? new Date(minExpiry).toISOString() : undefined;
      const session = this.state.sessions.get(rec.sessionId);
      // Mint the token even if the session has since expired? No — token is bound to a
      // live session for invoke. If the session died, the grant is persisted; the agent
      // re-handshakes + the prior-approval short-circuits re-prompt. A re-targeted grant
      // (different agentId) does NOT mint a token for the requesting session (the token's
      // sub would mismatch the persisted grant's agentId); the real agent re-requests.
      const sameAgent = targetAgentId === rec.agentId;
      if (sameAgent && session && this.state.sessions.liveness(rec.sessionId).live && approvedScopes.length > 0) {
        const token = this.mintToken(session, rec.agentId, approvedScopes, grantExpiresAt, transitive, approvedWindow);
        rec.token = token;
        this.state.events.publish({ type: "grant_resolved", pendingId, decision: "approved", token });
      } else {
        this.state.events.publish({ type: "grant_resolved", pendingId, decision: "approved" });
      }
      rec.state = "approved";
      // Management push (§2.3): clear this item from the tray inbox.
      this.state.events.publish({ type: "pending_resolved", pendingId, kind: "grant", decision: "approved" });
      return { ok: true, kind: "grant" };
    }

    // register
    const result = await rec.commit();
    rec.result = result;
    rec.state = "approved";
    await this.state.audit.write({
      type: "source.install",
      sessionId: rec.sessionId,
      detail: {
        source: rec.source,
        kind: "extension",
        outcome: result.ok ? "approved+committed" : "approved-but-failed",
        viaApproval: pendingId,
        registered: result.registered.length,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });
    this.state.events.publish({
      type: "manifest_changed",
      revision: this.state.capabilities.revision(),
    });
    // Management push (§2.3): clear this register from the tray inbox.
    this.state.events.publish({ type: "pending_resolved", pendingId, kind: "register", decision: "approved" });
    return { ok: result.ok, kind: "register", ...(result.reason ? { reason: result.reason } : {}) };
  }

  /** DENY a pending item (the user's "deny" action). Nothing is persisted/activated. */
  async deny(pendingId: string, reason?: string): Promise<{ ok: boolean; kind?: PendingKind; reason?: string }> {
    const rec = this.pending.get(pendingId);
    if (!rec || rec.state !== "pending") return { ok: false };
    rec.state = "denied";
    if (rec.kind === "grant") {
      for (const id of rec.capabilities) {
        await this.state.audit.write({
          type: "grant.deny",
          agentId: rec.agentId,
          sessionId: rec.sessionId,
          capabilityId: id,
          detail: { reason: reason ?? "denied by user", policy: this.authorizer.policy, viaApproval: pendingId },
        });
      }
      this.state.events.publish({ type: "grant_resolved", pendingId, decision: "denied" });
    } else {
      await this.state.audit.write({
        type: "source.install",
        sessionId: rec.sessionId,
        detail: { source: rec.source, kind: "extension", outcome: "denied", viaApproval: pendingId, reason: reason ?? "denied by user" },
      });
    }
    // Management push (§2.3): clear this item from the tray inbox.
    this.state.events.publish({ type: "pending_resolved", pendingId, kind: rec.kind, decision: "denied" });
    return { ok: true, kind: rec.kind };
  }

  /**
   * `POST /grants/refresh`: re-mint a fresh token with the SAME scopes from the
   * persisted grant(s), bounded by grant validity (ADR-011). Caller has already
   * verified the presented (possibly just-expired) token's signature + session
   * liveness. The old jti is revoked.
   */
  refresh(
    session: Session,
    agentId: string,
    oldJti: string,
    scopes: TokenScope[],
  ): RefreshResponse | { error: "grant_required" | "token_revoked" } {
    // Re-derive the live scopes from persisted grants; any scope whose grant was
    // removed/expired is dropped. If none survive → refresh fails (re-grant).
    const now = Date.now();
    const liveScopes: TokenScope[] = [];
    let minGrantExpiry = Number.POSITIVE_INFINITY;
    for (const scope of scopes) {
      const grant = this.state.grants.get(agentId, scope.id);
      if (!grant) continue;
      // A "once"/expired grant does not survive refresh (expiresAt = grantedAt for once).
      // D6: a bundle grant stamped under a rotated-away key is also dropped here.
      if (!isStandingAndUnexpired(grant, now, this.state.connectionKey.epoch())) continue;
      minGrantExpiry = Math.min(minGrantExpiry, Date.parse(grant.expiresAt));
      liveScopes.push({
        id: scope.id,
        verbs: grant.verbs,
        ...(grant.synthesizedFor ? { synthesizedFor: grant.synthesizedFor } : {}),
        // Re-mint the ENFORCED constraint from the persisted grant (AUTHZ-UX §3.1) so a
        // refreshed token confines exactly as the original (a constraint only narrows).
        ...(grant.constraint ? { constraint: grant.constraint } : {}),
      });
    }
    if (liveScopes.length === 0) {
      return { error: "grant_required" };
    }

    // Revoke the old jti, mint a fresh one.
    this.state.revocation.revoke(oldJti, "refreshed");
    const grantExpiresAt = new Date(minGrantExpiry).toISOString();
    const { token, claims } = signToken({
      sub: agentId,
      iss: getInstanceId(),
      sessionId: session.id,
      scopes: liveScopes,
      grantExpiresAtMs: minGrantExpiry,
    });
    this.state.sessions.trackJti(session.id, claims.jti);
    void this.state.audit.write({
      type: "token.refresh",
      agentId,
      jti: claims.jti,
      sessionId: session.id,
      detail: { previousJti: oldJti, scopeCount: liveScopes.length },
    });
    return {
      token,
      scopes: liveScopes,
      jti: claims.jti,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      grantExpiresAt,
    };
  }

  /**
   * `POST /grants/revoke`: by jti (one token) or by (agentId, capabilityId) (all
   * tokens carrying that scope + remove the persisted grant). Returns the audited
   * result (ADR-010). Since tokens are stateless JWTs we cannot enumerate every
   * outstanding jti for a scope; we revoke the jtis tracked per session for the
   * agent AND remove the grant so refresh can't re-mint.
   */
  async revoke(opts: {
    jti?: string;
    agentId?: string;
    capabilityId?: CapabilityId;
    reason?: string;
  }): Promise<RevokeResponse> {
    const revokedJtis: string[] = [];
    let grantRemoved = false;
    // Capture the bundle tag BEFORE removal — the grant row is the only place it lives,
    // and the audit event below is what keeps the bundle join replayable after deletion.
    const priorBundleId =
      opts.agentId && opts.capabilityId
        ? this.state.grants.get(opts.agentId, opts.capabilityId)?.bundleId
        : undefined;

    if (opts.jti) {
      this.state.revocation.revoke(opts.jti, opts.reason);
      revokedJtis.push(opts.jti);
      this.state.events.publish({ type: "token_revoked", jti: opts.jti, ...(opts.reason ? { reason: opts.reason } : {}) });
    }

    if (opts.agentId && opts.capabilityId) {
      grantRemoved = this.state.grants.remove(opts.agentId, opts.capabilityId);
      // Fix 1 (revocation tombstone): removing + persisting-out the standing grant is not enough —
      // under the default `confirm-risky` policy a still-running agent re-requesting the same
      // low-risk first-party/managed READ would silently re-auto-allow (authorizer.ts), making
      // revoke look useless. Tombstone the pair so the next request PENDS (human re-confirm)
      // instead of auto-allowing; a fresh human approval lifts it (see persistGrant).
      this.state.grants.addTombstone(opts.agentId, opts.capabilityId);
      // Revoke every tracked jti issued under the agent's sessions (best-effort
      // enumeration of outstanding tokens — stateless JWTs aren't otherwise listable).
      for (const session of this.state.sessions.all()) {
        const sAgent = session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
        if (sAgent !== opts.agentId) continue;
        for (const jti of session.issuedJtis) {
          if (this.state.revocation.isRevoked(jti)) continue;
          this.state.revocation.revoke(jti, opts.reason ?? "scope revoked");
          revokedJtis.push(jti);
          this.state.events.publish({ type: "token_revoked", jti, ...(opts.reason ? { reason: opts.reason } : {}) });
        }
      }
    }

    const audit = await this.state.audit.write({
      type: "grant.revoke",
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.capabilityId ? { capabilityId: opts.capabilityId } : {}),
      detail: {
        revokedCount: revokedJtis.length,
        grantRemoved,
        ...(opts.jti ? { byJti: true } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(priorBundleId ? { bundleId: priorBundleId } : {}),
      },
    });

    return { ok: revokedJtis.length > 0 || grantRemoved, revokedJtis, grantRemoved, auditId: audit.id };
  }

  /**
   * REVOKE EVERY standing grant belonging to ONE agent (agent-skill-compile Inv III /
   * ADR-3 — "revoke an agent" = ALL that agent's access dies). For each of the agent's
   * persisted grants: remove the durable record (so refresh can't re-mint) AND tombstone
   * the pair (so a still-running agent's bare re-request re-confirms with a human instead
   * of silently auto-allowing a low-risk read). Then revoke every still-live tracked jti
   * under the agent's sessions. ONLY this agent is touched — other agents' grants + tokens
   * are untouched (per-agent blast radius). Returns the audited `RevokeResponse`.
   *
   * This is the GRANT half of an agent revoke; the caller (admin.ts) also kills the
   * agent's enrollment/PAT and invalidates its live sessions so revoke is IMMEDIATE.
   */
  async revokeAllForAgent(agentId: string, reason?: string): Promise<RevokeResponse> {
    const grants = this.state.grants.forAgent(agentId);
    // Distinct bundle tags across the removed grants — captured before removal so the
    // audit event keeps the bundle join replayable after the rows are gone.
    const bundleIds = [...new Set(grants.map((g) => g.bundleId).filter((b): b is string => !!b))];
    let grantRemoved = false;
    for (const g of grants) {
      if (this.state.grants.remove(agentId, g.capabilityId)) grantRemoved = true;
      // Tombstone the pair so a still-running agent re-requesting the same low-risk read
      // PENDS (human re-confirm) instead of silently re-auto-allowing (see grant-service revoke()).
      this.state.grants.addTombstone(agentId, g.capabilityId);
    }
    // Revoke every tracked jti issued under this agent's sessions (best-effort enumeration —
    // stateless JWTs aren't otherwise listable). Already-revoked jtis (e.g. revoked by the
    // caller's session-invalidation pass) are skipped, so this is idempotent.
    const revokedJtis: string[] = [];
    for (const session of this.state.sessions.all()) {
      const sAgent = session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
      if (sAgent !== agentId) continue;
      for (const jti of session.issuedJtis) {
        if (this.state.revocation.isRevoked(jti)) continue;
        this.state.revocation.revoke(jti, reason ?? "agent revoked");
        revokedJtis.push(jti);
        this.state.events.publish({ type: "token_revoked", jti, ...(reason ? { reason } : {}) });
      }
    }
    const audit = await this.state.audit.write({
      type: "grant.revoke",
      agentId,
      detail: {
        agentRevoke: true,
        revokedCount: revokedJtis.length,
        grantsRemoved: grants.length,
        ...(reason ? { reason } : {}),
        ...(bundleIds.length ? { bundleIds } : {}),
      },
    });
    return { ok: grantRemoved || revokedJtis.length > 0, revokedJtis, grantRemoved, auditId: audit.id };
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // MODE-2 TASK BUNDLES (AUTHZ-UX §2.N3) — a named, human-approved group of standing
  // grants (+ constraints) to ONE agent, plus attached in-scope context. A bundle adds
  // NO new authority class: it is N normal `PersistedGrant`s tagged with a shared
  // `bundleId` (+ keyEpoch, D6) + context materialized through the existing skill path.
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Admin one-shot bundle create (D4 primary path — human is the approver, auto-approve like
   * `POST /admin/api/grants`). Persists each member as a normal grant tagged `bundleId`
   * (+ live keyEpoch), carrying its constraint + the authoritative trust-window, and
   * materializes the attached context. ONE transaction: on ANY failure it rolls back every
   * grant + context already written, so a partial bundle never lingers. Returns the BundleView.
   */
  async createBundle(input: CreateBundleInput): Promise<{ ok: true; bundle: BundleView } | { ok: false; reason: string }> {
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, reason: "bundle name is required" };
    if (!input.agentId || input.agentId === "plexus-admin") {
      return { ok: false, reason: "bundle requires a real target agentId (not plexus-admin)" };
    }
    if (!Array.isArray(input.grants) || input.grants.length === 0) {
      return { ok: false, reason: "bundle requires at least one grant" };
    }
    const bundleId = `bnd_${randomUUID()}`;
    const agentId = input.agentId;
    const keyEpoch = this.state.connectionKey.epoch();
    const window = input.trustWindow ?? { kind: "1d" as const };
    // Track what we wrote so we can roll back on partial failure.
    const writtenGrants: CapabilityId[] = [];
    let contextMaterialized = false;
    try {
      for (const member of input.grants) {
        const entry = this.state.capabilities.get(member.id);
        if (!entry) throw new Error(`unknown capability "${member.id}"`);
        // EXPOSURE gate: a bundle may not include a top-level-disabled capability (it is
        // ungrantable). Throw so the whole bundle rolls back (all-or-nothing semantics).
        if (this.state.exposure?.isDisabled(member.id)) {
          throw new Error(`capability "${member.id}" is disabled at the top level (not exposed)`);
        }
        const verbs = resolveVerbs(entry, { decision: "allow", ...(member.verbs ? { verbs: member.verbs } : {}) });
        const chosen = this.chooseTrustWindow({
          agentId,
          provenance: this.provenanceOf(entry),
          verbs,
          requested: window,
          authoritative: true,
        });
        const { standing } = this.persistGrant(agentId, entry, verbs, chosen, undefined, member.constraint, {
          bundleId,
          keyEpoch,
        });
        // A bundle is a group of STANDING grants — a member whose sensitivity caps
        // approvals at `once` (execute, ADR-5/ADR-018) can never stand, so accepting it
        // here would compose a ticket with an invisible hole (the member never persists
        // and silently vanishes from the bundle card). REJECT loudly instead; the throw
        // rolls back the whole bundle (all-or-nothing semantics).
        if (!standing) {
          throw new Error(
            `capability "${member.id}" can never be STANDING (its sensitivity caps approvals at 'once') — ` +
              `a task grant bundles standing grants only; approve this capability per call instead`,
          );
        }
        writtenGrants.push(member.id);
        await this.state.audit.write({
          type: "grant.allow",
          agentId,
          capabilityId: entry.id,
          verbs,
          detail: {
            policy: "auto-approve",
            bundleId,
            bundleName: name,
            trustWindow: chosen.kind,
            ...(member.constraint ? { constrained: true } : {}),
          },
        });
      }
      await this.materializeBundleContext(bundleId, name, agentId, input.context ?? []);
      contextMaterialized = true;
    } catch (e) {
      // Roll back: remove every grant + context written for this bundle.
      this.state.grants.removeForBundle(bundleId);
      if (contextMaterialized && typeof this.state.capabilities.unregister === "function") {
        try {
          await this.state.capabilities.unregister(`bundle:${bundleId}`);
        } catch {
          /* best-effort */
        }
      }
      this.bundles.delete(bundleId);
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const view = this.bundleView(bundleId);
    if (!view) {
      this.state.grants.removeForBundle(bundleId);
      return { ok: false, reason: "bundle persisted no members" };
    }
    void writtenGrants;
    return { ok: true, bundle: view };
  }

  /**
   * Materialize a bundle's `GrantContextRef[]` (D3). For each ref:
   *  - kind:"skill"  → reference the existing `kind:"skill"` entry by id (record it).
   *  - kind:"inline" → materialize the capped markdown as a `kind:"skill"` entry under a
   *                    synthetic `bundle:<id>` source via the existing registerExtension path.
   * Records the bundle index entry (name, agent, createdAt, resolved context) for grouping.
   */
  private async materializeBundleContext(
    bundleId: string,
    name: string,
    agentId: string,
    refs: GrantContextRef[],
  ): Promise<void> {
    const context: { id: CapabilityId; label: string; kind: "skill" | "inline" }[] = [];
    const inlineDecls: { name: string; label: string; markdown: string }[] = [];
    let inlineSeq = 0;
    for (const ref of refs) {
      if (ref.kind === "skill" && ref.skillId) {
        const entry = this.state.capabilities.get(ref.skillId);
        const label = ref.label ?? entry?.label ?? ref.skillId;
        context.push({ id: ref.skillId, label, kind: "skill" });
      } else if (ref.kind === "inline" && typeof ref.markdown === "string") {
        // Cap at MAX_SKILL_BODY_BYTES (the same guard skill bodies carry).
        let md = ref.markdown;
        const enc = new TextEncoder();
        if (enc.encode(md).length > MAX_SKILL_BODY_BYTES) {
          // Truncate by bytes (UTF-8 safe slice via successive trim).
          while (enc.encode(md).length > MAX_SKILL_BODY_BYTES) md = md.slice(0, Math.floor(md.length * 0.95));
        }
        const declName = `context.note-${++inlineSeq}`;
        inlineDecls.push({ name: declName, label: ref.label ?? "Task context", markdown: md });
      }
    }
    // Materialize inline blobs as a single synthetic-source skill extension (D3).
    if (inlineDecls.length > 0 && typeof this.state.capabilities.registerExtension === "function") {
      const source = `bundle:${bundleId}`;
      const manifest: ExtensionManifest = {
        manifest: "plexus-extension/0.1",
        source,
        label: `Task bundle context: ${name}`,
        transport: "skill",
        capabilities: inlineDecls.map((d) => ({
          name: d.name,
          kind: "skill" as const,
          label: d.label,
          describe: `In-scope task context for bundle "${name}".`,
          grants: [] as GrantVerb[],
          transport: "skill" as const,
          body: { format: "markdown" as const, markdown: d.markdown },
        })),
      };
      // trusted:true — gateway-owned synthetic source, exempt from first-party-id reservation.
      const res = await this.state.capabilities.registerExtension(manifest, { trusted: true });
      for (let i = 0; i < res.registered.length; i++) {
        const id = res.registered[i]!;
        const decl = inlineDecls[i];
        context.push({ id, label: decl?.label ?? "Task context", kind: "inline" });
      }
    }
    this.bundles.set(bundleId, {
      bundleId,
      name,
      agentId,
      createdAt: new Date().toISOString(),
      context,
    });
  }

  /** Project one bundle to its `BundleView` (members from the grant store + index metadata). */
  private bundleView(bundleId: string): BundleView | undefined {
    const idx = this.bundles.get(bundleId);
    const members = this.state.grants
      .forBundle(bundleId)
      .map((g) => viewOfGrant(g, (cid) => this.provenanceForCapability(cid)));
    if (members.length === 0 && !idx) return undefined;
    const agentId = idx?.agentId ?? members[0]?.agentId ?? "";
    return {
      bundleId,
      name: idx?.name ?? bundleId,
      agentId,
      createdAt: idx?.createdAt ?? members[0]?.grantedAt ?? new Date().toISOString(),
      members,
      context: idx?.context ?? [],
    };
  }

  /** `GET /admin/api/bundles`: every task bundle (grouped standing grants + context). */
  listBundles(): BundleView[] {
    // Union of indexed bundles + any bundleId present on grants (covers a restart with
    // persisted grants but a fresh in-memory index — members still group correctly).
    const ids = new Set<string>(this.bundles.keys());
    for (const g of this.state.grants.all()) if (g.bundleId) ids.add(g.bundleId);
    const out: BundleView[] = [];
    for (const id of ids) {
      const v = this.bundleView(id);
      if (v) out.push(v);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * `GET /grants/context?bundle=<id>`: resolve a bundle's attached context to skill bodies so
   * the agent reads its task context in one call (D3). Returns the markdown of each context skill.
   */
  bundleContext(bundleId: string): BundleContextResponse | undefined {
    const idx = this.bundles.get(bundleId);
    const refs =
      idx?.context ??
      // Fallback: derive context from any materialized `bundle:<id>` skills in the registry.
      this.state.capabilities
        .all()
        .filter((e) => e.source === `bundle:${bundleId}` && e.kind === "skill")
        .map((e) => ({ id: e.id, label: e.label, kind: "inline" as const }));
    if (!idx && refs.length === 0) return undefined;
    const context: { id: CapabilityId; label: string; markdown: string }[] = [];
    for (const ref of refs) {
      const entry = this.state.capabilities.get(ref.id);
      const markdown =
        entry?.body?.format === "markdown" && typeof entry.body.markdown === "string"
          ? entry.body.markdown
          : "";
      context.push({ id: ref.id, label: ref.label, markdown });
    }
    return { bundleId, name: idx?.name ?? bundleId, context };
  }

  /**
   * Revoke an entire task bundle (AUTHZ-UX §2.N3): remove every member grant + revoke their
   * tokens + drop any materialized context source + the index entry. Leaves NO orphan grant.
   */
  async revokeBundle(bundleId: string, reason?: string): Promise<RevokeResponse> {
    const removed = this.state.grants.removeForBundle(bundleId);
    const revokedJtis: string[] = [];
    // Revoke every tracked jti for the agents whose grants we removed (best-effort enumeration).
    const affectedAgents = new Set(removed.map((r) => r.agentId));
    for (const session of this.state.sessions.all()) {
      const sAgent = session.agentId ?? session.client?.agentId ?? `anon:${session.id}`;
      if (!affectedAgents.has(sAgent)) continue;
      for (const jti of session.issuedJtis) {
        if (this.state.revocation.isRevoked(jti)) continue;
        this.state.revocation.revoke(jti, reason ?? "bundle revoked");
        revokedJtis.push(jti);
        this.state.events.publish({ type: "token_revoked", jti, ...(reason ? { reason } : {}) });
      }
    }
    // Drop the materialized synthetic context source (no orphan skill left behind).
    if (typeof this.state.capabilities.unregister === "function") {
      try {
        await this.state.capabilities.unregister(`bundle:${bundleId}`);
      } catch {
        /* best-effort */
      }
    }
    this.bundles.delete(bundleId);
    const audit = await this.state.audit.write({
      type: "grant.revoke",
      detail: {
        bundleId,
        revokedCount: revokedJtis.length,
        grantsRemoved: removed.length,
        ...(reason ? { reason } : {}),
      },
    });
    return {
      ok: removed.length > 0 || revokedJtis.length > 0,
      revokedJtis,
      grantRemoved: removed.length > 0,
      auditId: audit.id,
    };
  }

  /** Provenance resolver for a capability id (shared by bundle views + listGrants). */
  private provenanceForCapability(capabilityId: CapabilityId): Provenance {
    const entry = this.state.capabilities.get(capabilityId);
    if (entry) return this.provenanceOf(entry);
    return provenanceFor(
      capabilityId.split(".").slice(0, -2).join(".") || capabilityId,
      this.managedSourceIds(),
    );
  }

  /**
   * `GET /grants`: the standing-grant ledger (ADR-018). Projects every persisted
   * grant to its `StandingGrant` view, resolving each capability's source-class via
   * the registry so the row carries the right provenance badge. When `agentId` is
   * supplied (session-auth), only that agent's grants are returned; management auth
   * lists all.
   */
  listGrants(agentId?: string): StandingGrant[] {
    const provenanceOf = (capabilityId: CapabilityId): Provenance => {
      const entry = this.state.capabilities.get(capabilityId);
      if (entry) return this.provenanceOf(entry);
      // Grant for an unregistered capability (e.g. a removed extension): derive from id.
      return provenanceFor(
        capabilityId.split(".").slice(0, -2).join(".") || capabilityId,
        this.managedSourceIds(),
      );
    };
    const all = this.state.grants.allForView(provenanceOf);
    // EXPOSURE flag (additive): stamp `topLevelDisabled:true` onto any grant whose
    // capability is currently top-level-disabled, so the admin Grants view can render
    // "granted but disabled (invisible)" distinctly. The grant record itself is unchanged.
    const flagged = all.map((g) =>
      this.state.exposure?.isDisabled(g.capabilityId) ? { ...g, topLevelDisabled: true } : g,
    );
    return agentId ? flagged.filter((g) => g.agentId === agentId) : flagged;
  }

  /** Lifetime constant (exposed for tests/diagnostics). */
  readonly tokenLifetimeMs = TOKEN_LIFETIME_MS;
}
