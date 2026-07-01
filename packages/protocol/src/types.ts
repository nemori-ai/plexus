/**
 * ============================================================================
 * PLEXUS — M0 CANONICAL PROTOCOL TYPES (source of truth)
 * ============================================================================
 *
 * Plexus is a user-installed, open-source LOCAL CAPABILITY GATEWAY. It exposes
 * ONE stable, AI-native self-describe endpoint so any AI agent can:
 *
 *     DISCOVER → UNDERSTAND → be GRANTED → CALL
 *
 * the capabilities of software on the user's machine.
 *
 * Framing (user, locked): "MCP = what functions I have; Plexus = how you
 * should use me." MCP is the first-class, privileged INGESTION transport
 * (`transport: "mcp"`). MCP tool/resource/prompt JSON Schemas pass through
 * VERBATIM. The additive layer — `.well-known` self-describe, bundled usage
 * Skills, user-defined extensions, per-capability scoped grants/tokens — lives
 * ABOVE the MCP wire.
 *
 * This file is PURE TYPES (compile-ready, no implementation). The entire
 * gateway codebase types off it. Keep it precise, complete, internally
 * consistent. Stack target: Bun + TypeScript + Hono (HTTP/WS).
 *
 * Wire JSON note: every type here is a flat, JSON-serializable shape — these
 * types describe both the in-process model AND the bytes on the wire, so the
 * `.well-known` document, the handshake manifest, and the entries are the same
 * objects projected at different verbosity levels.
 *
 * @see ./PLEXUS-PROTOCOL.md   for the human-readable contract + worked examples
 * @see ./DECISIONS.md         for the ADRs behind each choice
 */

// ============================================================================
// §0  PRIMITIVE / SHARED ALIASES
// ============================================================================

/**
 * M0 CONTRACT VERSION. This file and its sibling docs are the Plexus protocol
 * contract — the contract everything types off. Bump on any breaking change to a
 * wire-facing type.
 *
 * v0.1.1 (tp2 / ADR-017): /invoke now returns the SINGLE `InvokeResponse` shape
 * for ALL outcomes including auth/pre-dispatch denials (was the `ErrorResponse`
 * envelope in v0.1.0). A non-breaking refinement — the closed `ErrorCode` union and
 * the per-denial HTTP status are unchanged; the denial body merely gains the
 * uniform `{id, ok:false, auditId}` framing around the same `error`.
 *
 * v0.1.2 (ADR-018 — unified trust model): names the previously-implicit trust
 * machinery and surfaces it everywhere — `Provenance` (3-class source-class),
 * `Sensitivity`, `TrustWindow`, the standing-grant ledger (`GET /grants` +
 * `GrantsListResponse`), gateway-authored `PendingNarration`, and the additive
 * optional fields on `CapabilityEntry`/`CapabilitySummary`/`GrantDecision`/
 * `ScopedToken`. ALL additive: every change is a new optional field or a new
 * endpoint; a v0.1.1 client ignores them and the frozen wire is untouched.
 */
export const PLEXUS_PROTOCOL_VERSION = "0.1.2" as const;

/**
 * A globally-unique, stable capability identifier.
 *
 * ID-DERIVATION RULE (review #secondary, locked): an id is ALWAYS
 * `<sourceSlug>.<noun>.<verb>` in lower-kebab/dot, where `<sourceSlug>` is the
 * SourceId with any `:` replaced by `.` (so source `mcp:github` ⇒ slug
 * `mcp.github`, giving id `mcp.github.create_issue`). The source is therefore
 * RECOVERABLE from the id: `deriveSource(id)` re-joins the slug back to the
 * SourceId. This is a contract every adapter MUST honor so routing never needs a
 * separate id→source map. Stability is a contract: an id must not be reused for a
 * different capability across versions. Used as the unit of grant, scope, audit,
 * and invocation routing.
 */
export type CapabilityId = string;

/**
 * Identifier of a capability SOURCE (one adapter-managed origin): a first-party
 * adapter, an ingested MCP server, or a user extension. e.g. `obsidian`,
 * `cc-master`, `mcp:github`. Many entries may share one source. The MCP convention
 * is `mcp:<serverId>`; its id-slug (per the ID-DERIVATION RULE) is `mcp.<serverId>`.
 */
export type SourceId = string;

/** ISO-8601 UTC timestamp string, e.g. "2026-06-23T10:00:00.000Z". */
export type IsoTimestamp = string;

// ============================================================================
// §0c  PER-SOURCE HEALTH (additive — agent-facing + admin)
// ----------------------------------------------------------------------------
// ADDITIVE refinement (HEALTH). A SOURCE reports health; each of its
// capabilities INHERITS that one per-source value (per-source granularity). The
// snapshot is surfaced (a) to AGENTS at discovery (`.well-known` summaries) +
// the handshake/`GET /manifest` entries, (b) to the ADMIN dashboard + admin API,
// and (c) reconciled with the existing `source_unavailable` invoke error.
//
// Health is ADVISORY + TIME-VARYING: the value carried on a summary/entry is a
// SNAPSHOT taken at serialization time from a short-TTL cache (stale-while-
// revalidate). An agent treats it as a hint — `unavailable` means "a call will
// likely fail with `source_unavailable` right now"; it is never a substitute for
// the authoritative per-call result. All fields below are OPTIONAL on the wire;
// a pre-HEALTH client ignores them and the frozen shapes are untouched.
// ============================================================================

/**
 * Per-source health status (4-state, closed). DERIVED from a source's optional
 * `health()` method, or — when that is absent — from its `checkRequirements()`:
 *  - "ok"          = the source is installed + reachable; calls should dispatch.
 *  - "degraded"    = reachable but impaired (only a source's own `health()` can
 *                    report this; the `checkRequirements()` derivation never does).
 *  - "unavailable" = a dependency is missing/unreachable (binary off PATH, REST
 *                    endpoint down, MCP initialize failed) — a call will likely
 *                    fail `source_unavailable`.
 *  - "unknown"     = not yet probed (first-ever read before the first probe
 *                    resolves), OR a source that implements neither `health()`
 *                    nor a meaningful `checkRequirements()` (the connector's
 *                    freedom to no-op the probe, by design).
 */
export type HealthStatus = "ok" | "degraded" | "unavailable" | "unknown";

/**
 * The agent-/admin-facing per-source health SNAPSHOT carried (inherited) onto a
 * `CapabilitySummary` / `CapabilityEntry`. Advisory + time-varying.
 */
export interface CapabilityHealth {
  status: HealthStatus;
  /** Human-readable reason (e.g. the `checkRequirements` reason on "unavailable"). */
  detail?: string;
  /** When this snapshot was probed (the cache stamp). Absent ⇒ never probed yet. */
  checkedAt?: IsoTimestamp;
  /**
   * PROVENANCE MARKER (additive, mesh P6-HEALTH-PROV). `true` iff this health value is a
   * REMOTE SELF-ASSERTION — the home workload of a `mesh:<workload>` cap REPORTED it over the
   * tunnel and the primary is relaying it UNVERIFIED (mesh-health-reporting.md). A
   * LOCALLY-PROBED source's health leaves this ABSENT: absent ⇒ gateway-PROVEN (the gateway
   * itself observed the source), present-true ⇒ "the remote home says so, we did not verify."
   * Lets an agent/console distinguish "gateway proved ok" from "remote claims ok" — the two are
   * otherwise byte-identical at `status:"ok"`. ADVISORY ONLY: like all of `CapabilityHealth`,
   * health gates NOTHING (route/ResolutionTable still gates invoke); this marker never changes
   * an authorization outcome. A pre-marker client ignores it. Only ever set when true.
   */
  reported?: boolean;
}

/**
 * What a source's optional `health()` method returns (the LIFECYCLE-layer shape,
 * per-source). The gateway's health service stamps `checkedAt` when it caches the
 * value; a source need only report `status` (+ optional `detail`). A source that
 * does NOT implement `health()` has its health DERIVED from `checkRequirements()`
 * (ok→"ok", not-ok→"unavailable" with the reason as detail; neither ⇒ "unknown").
 */
export interface SourceHealth {
  status: HealthStatus;
  /** Human-readable reason (surfaced as `CapabilityHealth.detail`). */
  detail?: string;
}

/**
 * A JSON Schema (Draft 2020-12). Intentionally `unknown`-valued and open: MCP
 * tool `inputSchema` / `outputSchema` objects drop in here VERBATIM with zero
 * transformation (lossless subset projection). Plexus never rewrites a schema it
 * ingests; it only wraps it.
 *
 * NOTE (review #secondary): Draft 2020-12 permits the boolean schemas `true`
 * (accept anything) and `false` (accept nothing) anywhere a schema is expected.
 * So the verbatim-faithful type is `boolean | JsonSchemaObject`, not object-only.
 */
export type JsonSchema = boolean | JsonSchemaObject;

/** The object form of a JSON Schema. */
export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  /** Open: any other JSON Schema keyword (oneOf, $ref, format, …) survives. */
  [keyword: string]: unknown;
}

// ============================================================================
// §1  THE UNIFIED SELF-DESCRIBE ENTRY MODEL
// ----------------------------------------------------------------------------
// capability / skill / workflow are ISOMORPHIC entries discriminated by `kind`
// so an agent discovers and reasons over all three UNIFORMLY. One discovery
// loop, one grant surface, one invocation path.
// ============================================================================

/**
 * The three isomorphic entry kinds.
 *  - "capability": a directly callable function/data-access (the leaf unit;
 *                  an ingested MCP tool projects to this).
 *  - "skill":      agent-facing USAGE KNOWLEDGE attached to capabilities —
 *                  "how to use me well": worked examples, gotchas, conventions.
 *                  This is the layer MCP does not have. A skill is discoverable
 *                  but is read-as-context, not "invoked" in the call sense
 *                  (its `transport` is "skill").
 *  - "workflow":   a user/first-party-defined orchestration of multiple
 *                  capabilities exposed as a SINGLE higher-level capability.
 *                  Invoked like a capability; internally fans out.
 */
export type EntryKind = "capability" | "skill" | "workflow";

/**
 * Transport the adapter layer uses to actually reach the underlying software.
 * First batch (locked, see DECISIONS ADR-003). The set is closed-by-default but
 * the `Transport` interface (§6) is the extension seam — adding a transport
 * means implementing the interface and registering it, never editing callers.
 *
 *  - "local-rest": HTTP(S) against a localhost service the app already exposes
 *                  (e.g. Obsidian Local REST API plugin). Plexus = HTTP client.
 *  - "stdio":      spawn a subprocess, talk a line/JSON protocol over its
 *                  stdin/stdout (NDJSON). Generic non-MCP stdio adapters.
 *  - "ipc":        OS IPC — unix domain socket / named pipe / AppleScript-osascript
 *                  bridge. The OS-specific bits live behind the platform seam (§6).
 *  - "mcp":        PRIVILEGED. Plexus runs an MCP CLIENT (stdio or Streamable
 *                  HTTP) against an MCP server: initialize → tools/list →
 *                  re-project. Tool schemas pass through verbatim. This is the
 *                  superset/collector transport.
 *  - "cli":        invoke a CLI binary with argv, capture stdout (optionally
 *                  `--format json`). Binary located via the platform path-resolver.
 *  - "skill":      sentinel for `kind:"skill"` entries — not a callable wire,
 *                  the body is delivered as context at handshake/read time.
 *  - "workflow":   sentinel for `kind:"workflow"` entries — execution is the
 *                  gateway's internal orchestrator fanning out to member
 *                  capabilities; there is no single external wire.
 */
export type TransportKind =
  | "local-rest"
  | "stdio"
  | "ipc"
  | "mcp"
  | "cli"
  | "skill"
  | "workflow"
  // The FEDERATION transport (mesh §3.2 / §7 Q4): a capability MOUNTED from a remote
  // proxy workload. Its `id` is the full `CapabilityAddress` (tenant/workload/source.cap);
  // dispatch forwards the BARE local id down the proxy tunnel (the forward boundary
  // translates address→bare exactly once — Invariant F). The forwarder itself lands in
  // T7; T6 only marks mounted entries with this kind so routing/exposure can distinguish them.
  | "mesh";

/**
 * Permission verbs an entry can REQUIRE. The user grants per-entry (§4/§5).
 * Default policy is default-deny + default-read-only.
 *  - "read":      read data / non-mutating query.
 *  - "write":     mutate state on the user's machine / app data.
 *  - "execute":   run a process / side-effecting action that is neither a pure
 *                 read nor a simple data write (e.g. launch an orchestration).
 */
export type GrantVerb = "read" | "write" | "execute";

// ============================================================================
// §0b  UNIFIED TRUST MODEL — PROVENANCE / SENSITIVITY / TRUST-WINDOW
// ----------------------------------------------------------------------------
// ADDITIVE refinement (v0.1.2, ADR-018). Names the previously-implicit trust
// machinery so every surface (UI / agent / API) reads the SAME facts: a
// capability's source-class (provenance), its derived risk tier (sensitivity),
// and how long a human's approval STANDS (trust-window) — distinct from the
// short token-lifetime (blast radius). All fields below are optional on the wire;
// a v0.1.1 client ignores them.
// ============================================================================

/**
 * SOURCE-CLASS (3-class, ADR-018). Where a capability came from — drives the
 * default authorizer posture and is surfaced verbatim everywhere:
 *  - "first-party" = a reserved/in-process source (cc-master, obsidian(fs), mock).
 *  - "managed"     = a source the user ADDED through the trusted admin UI
 *                    (managedSources, human-vetted at add-time, e.g. obsidian-rest).
 *                    Shares first-party READ posture; write/exec still pends.
 *  - "extension"   = wire-registered by an agent via POST /extensions. Strictest:
 *                    ANY verb pends.
 */
export type Provenance = "first-party" | "managed" | "extension";

/**
 * Derived risk tier for narration (gateway-computed so all surfaces agree, §SENS):
 *  - "low"      = read on first-party/managed.
 *  - "elevated" = write/exec on first-party/managed, OR read on extension.
 *  - "high"     = write/exec on extension, OR any cli/local-rest transport w/ write/exec.
 * Workflows roll up members' sensitivity (max wins).
 */
export type Sensitivity = "low" | "elevated" | "high";

/**
 * The menu of trust-window durations a human may pick at approval (ADR-018).
 *  - "once"          = single-use: NO durable standing grant (expiresAt = grantedAt),
 *                      so refresh can't re-mint and `hasPriorApproval` won't short-circuit.
 *  - "1h"/"1d"/"7d"  = fixed durations.
 *  - "until-revoked" = far-future sentinel; only an explicit revoke ends it.
 *  - "custom"        = a caller-supplied `ms` duration, clamped to `maxTrustWindowMs`.
 */
export type TrustWindowKind = "once" | "1h" | "1d" | "7d" | "until-revoked" | "custom";

/**
 * How long a GRANT stands before re-approval is needed — the lifetime of the
 * human's decision (distinct from the 15-min token-lifetime / blast radius).
 */
export interface TrustWindow {
  kind: TrustWindowKind;
  /** Required when kind==="custom"; informational echo for fixed kinds. Clamped to maxTrustWindowMs. */
  ms?: number;
}

/**
 * One row of the standing-grant ledger (`GET /grants` + the admin Grants view).
 * The durable, human-approved trust made first-class & visible (ADR-018).
 */
export interface StandingGrant {
  agentId: string;
  capabilityId: CapabilityId;
  verbs: GrantVerb[];
  provenance: Provenance;
  sensitivity?: Sensitivity;
  grantedAt: IsoTimestamp;
  /** Trust-window end — the user-legible truth (maps to PersistedGrant.expiresAt). */
  expiresAt: IsoTimestamp;
  trustWindow: TrustWindow;
  /** false for a "once" grant (non-renewable, won't short-circuit hasPriorApproval). */
  standing: boolean;
  /** When a scope was synthesized for a workflow, the granting workflow id. */
  synthesizedFor?: CapabilityId;
  /**
   * NEW (additive, AUTHZ-UX §3.1). The durable scope constraint this standing grant was
   * approved under (so refresh re-mints a token whose scope carries the SAME enforced
   * constraint). Absent ⇒ an unconstrained whole-capability grant.
   */
  constraint?: ScopeConstraint;
  /**
   * NEW (additive, AUTHZ-UX §2.N3). The task-bundle this standing grant belongs to (when
   * it was created as one member of a named Mode-2 bundle). Lets the admin Grants view
   * GROUP members under a bundle header + offer a single "Revoke bundle". Absent ⇒ an
   * ordinary standalone grant. A bundle adds NO new authority — it is grants + constraints
   * + context, grouped under this tag.
   */
  bundleId?: string;
  /**
   * NEW (additive, EXPOSURE policy). True when the granted capability is CURRENTLY disabled
   * at the top level ("What I expose") — the grant RECORD stands, but the capability is
   * invisible + uninvokable until the owner re-enables it (effective access = granted ∧
   * exposed). Lets the admin Grants view render "granted but disabled (invisible)" in a
   * distinct style. Absent/false ⇒ exposed normally. The flag only ever appears when true.
   */
  topLevelDisabled?: boolean;
}

/** Response body of `GET /grants` — the caller's (or, for management auth, all) standing grants. */
export interface GrantsListResponse {
  grants: StandingGrant[];
}

/**
 * NEW (additive, AUTHZ-UX §2.N3). One task-bundle projected for the admin Grants view /
 * `GET /admin/api/bundles` — a named, human-approved group of standing grants (+ their
 * constraints) to ONE agent, plus the attached in-scope context. Purely a GROUPING of
 * `StandingGrant`s sharing a `bundleId`; it confers no authority beyond its members.
 */
export interface BundleView {
  bundleId: string;
  name: string;
  agentId: string;
  createdAt: IsoTimestamp;
  /** The member standing grants (each carries its own verbs + constraint + expiry). */
  members: StandingGrant[];
  /** The attached in-scope context (resolved to label + skill id). */
  context: { id: CapabilityId; label: string; kind: "skill" | "inline" }[];
}

/** Response body of `GET /admin/api/bundles` — every task bundle, grouped. */
export interface BundlesResponse {
  bundles: BundleView[];
}

/**
 * NEW (additive, AUTHZ-UX §2.N3 / D3). Response body of `GET /grants/context?bundle=<id>`
 * (session-authenticated like `/grants`). Resolves a bundle's `GrantContextRef[]` to the
 * actual skill bodies so the agent reads its whole task context in one call. (The same
 * bodies are ALSO discoverable as normal `kind:"skill"` entries via `plexus skills`.)
 */
export interface BundleContextResponse {
  bundleId: string;
  name: string;
  context: { id: CapabilityId; label: string; markdown: string }[];
}

/**
 * Gateway-authored narration for one pending capability so EVERY agent tells the
 * user the same truth (ADR-018 — the honesty contract). The `summary` is authored
 * by the gateway, not the agent, so narration can't drift.
 */
export interface PendingNarration {
  id: CapabilityId;
  verbs: GrantVerb[];
  provenance: Provenance;
  sensitivity: Sensitivity;
  defaultTrustWindow: TrustWindow;
  /** e.g. "Approving lets plexus-cli WRITE your Obsidian vault for up to 1 day; revoke anytime in Plexus → Grants." */
  summary: string;
  /**
   * NEW (additive, AUTHZ-UX §2.N2 / D7). A one-line, GATEWAY-AUTHORED notification form
   * of this pending grant, for a future native tray / `osascript display notification`:
   * `"{agentLabel} wants to {VERBS} {capabilityLabel}{ — “purpose”}"`, capped ~120 chars,
   * the agent's purpose quoted + truncated. Web ignores it (it renders the rich card);
   * the tray reads exactly this field. Gateway-authored (like `summary`) so the
   * notification can't be spoofed by agent text. Optional: a v0.1.2 client ignores it.
   */
  notificationLine?: string;
}

/**
 * Lossless MCP provenance carried on entries ingested via `transport:"mcp"`.
 * Lets the gateway round-trip back to the origin server/tool, and lets a future
 * MCP-server FAÇADE output adapter (DECISIONS ADR-008) re-emit the exact MCP
 * primitive. `undefined` on non-MCP entries.
 */
export interface McpPassthrough {
  /** The MCP server connection this entry was ingested from. */
  serverId: string;
  /** MCP protocol version negotiated at initialize. */
  protocolVersion: string;
  /** Which MCP primitive this entry projects from. Branches the transport (review #1). */
  primitive: "tool" | "resource" | "prompt";
  /**
   * Origin handle used to route calls back to the exact MCP primitive (review #1):
   *  - primitive "tool"     ⇒ the tool NAME      (→ `tools/call`).
   *  - primitive "resource" ⇒ the resource URI   (→ `resources/read`, param `uri`).
   *  - primitive "prompt"   ⇒ the prompt NAME    (→ `prompts/get`, param name+args).
   */
  originName: string;
  /**
   * The ORIGINAL MCP object, verbatim and unmodified (the full Tool / Resource
   * / Prompt JSON as returned by the MCP list call). Source of truth for re-projection
   * and for the optional MCP-server façade output adapter. Never rewritten.
   */
  raw: Record<string, unknown>;
}

/**
 * Reference to a usage Skill body attached to a capability or workflow. Skills
 * are themselves discoverable as `kind:"skill"` entries; this is the back-link
 * from a capability to the skills that teach its use.
 */
export interface AttachedSkillRef {
  /** The id of the `kind:"skill"` entry. */
  id: CapabilityId;
  /** Short human/agent-facing label, mirrored from the skill entry for convenience. */
  label: string;
}

/**
 * Input/output contract of an entry, JSON-Schema-compatible so an ingested MCP
 * tool's `inputSchema`/`outputSchema` drop in here VERBATIM. Both optional:
 * a `kind:"skill"` entry typically has neither.
 */
export interface IoSchema {
  /** JSON Schema for the call arguments. For MCP tools: the tool's `inputSchema`, verbatim. */
  input?: JsonSchema;
  /** JSON Schema for the call result. For MCP tools: the tool's `outputSchema`, verbatim. */
  output?: JsonSchema;
}

/**
 * THE CANONICAL SELF-DESCRIBE ENTRY.
 *
 * Every capability, skill, and workflow is one of these. An agent's entire
 * mental model of "what can I do on this machine" is a list of these. The HEART
 * of the entry is `describe` — the semantic, agent-facing "how to use me" text.
 *
 * `CapabilityEntry` is the canonical name; `SelfDescribeEntry` is an exported
 * alias (some call sites read better one way or the other).
 */
export interface CapabilityEntry {
  // ── Identity ────────────────────────────────────────────────────────────
  /** Globally-unique, stable id. Unit of grant/scope/audit/invocation. */
  id: CapabilityId;
  /** The source/adapter this entry came from. */
  source: SourceId;
  /** Discriminator — capability | skill | workflow. */
  kind: EntryKind;

  // ── Human/agent-facing surface ──────────────────────────────────────────
  /** Short human-readable label, e.g. "Read Obsidian notes". */
  label: string;
  /**
   * THE HEART. Semantic, agent-facing description of WHAT this is, WHEN to
   * choose it, and HOW to use it well — written for an AI deciding whether to
   * call it. Follows the claude-plugin convention "Action outcome. Use when X."
   * For MCP-ingested entries this is seeded from the tool `description` and MAY
   * be enriched by an attached skill.
   */
  describe: string;

  // ── Call contract ─────────────────────────────────────────────────────────
  /** I/O JSON Schemas. MCP tool schemas pass through verbatim. Omitted for skills. */
  io?: IoSchema;
  /**
   * Permission verbs this entry REQUIRES to be invoked. Empty array = no grant
   * required (e.g. a pure skill). The user grants per-entry; the issued
   * scoped-token must cover every verb in this list for a call to be allowed.
   */
  grants: GrantVerb[];
  /** Transport the adapter uses to reach the underlying software (§6). */
  transport: TransportKind;

  // ── Usage knowledge + composition ─────────────────────────────────────────
  /**
   * Usage Skills attached to THIS entry (capabilities/workflows reference the
   * skills that teach them). Resolvable to `kind:"skill"` entries.
   */
  skills?: AttachedSkillRef[];
  /**
   * For `kind:"workflow"` only: the ordered member capabilities this workflow
   * orchestrates. Each member id MUST be a PRESENT registry entry (review #5/#secondary:
   * a workflow whose members are not real entries has no transitive-grant targets).
   * Drives the internal orchestrator's fan-out AND the synthesized transitive
   * scope surfaced to the user at grant-confirm time (§5b, `TransitiveGrant`).
   */
  members?: WorkflowMember[];
  /**
   * For `kind:"skill"` only: the markdown body (or a content ref) of the usage
   * skill — delivered to the agent as context at handshake/read time.
   */
  body?: SkillBody;

  // ── Provenance ──────────────────────────────────────────────────────────
  /** Present iff `transport === "mcp"`: verbatim MCP origin (§1 McpPassthrough). */
  mcp?: McpPassthrough;

  // ── Trust posture (ADR-018, additive — gateway-stamped) ───────────────────
  /** Source-class (3-class). Gateway-filled from the source; omitted ⇒ treat as "extension". */
  provenance?: Provenance;
  /** Derived risk tier for narration. Gateway-filled; omitted ⇒ derive from verbs. */
  sensitivity?: Sensitivity;
  /** The entry's own default trust-window (gateway fills by class+verb if absent). */
  recommendedTrustWindow?: TrustWindow;

  // ── Health (additive — gateway-stamped, inherited per-source) ─────────────
  /**
   * The INHERITED per-source health SNAPSHOT (HEALTH), stamped at serialization
   * time from the gateway's short-TTL health cache. Every entry of a given source
   * carries the SAME value (per-source granularity). Advisory + time-varying — an
   * agent reads it as a hint that a call may fail `source_unavailable`, never as
   * the authoritative per-call result. Omitted ⇒ a registry that predates HEALTH
   * (treat as "unknown").
   */
  health?: CapabilityHealth;

  // ── Metadata ──────────────────────────────────────────────────────────────
  /** Optional semantic version of the entry/contract for change tracking. */
  version?: string;
  /**
   * Open metadata escape hatch — NEVER read by gateway core routing logic.
   * Adapters and the management client may stash per-source extras here
   * (mirrors pneuma's `AgentCapabilities.extras` discipline).
   */
  extras?: Record<string, unknown>;
}

/** Canonical alias — same shape, reads better at discovery call sites. */
export type SelfDescribeEntry = CapabilityEntry;

/** The body of a `kind:"skill"` entry: inline markdown or a fetchable ref. */
export interface SkillBody {
  /** "markdown" inline, or "ref" pointing at content fetched on demand. */
  format: "markdown" | "ref";
  /** Inline markdown (format:"markdown") — frontmatter-style usage guidance. */
  markdown?: string;
  /** Content ref (format:"ref") — a gateway-relative URL to GET the body. */
  ref?: string;
}

/**
 * A member of a `kind:"workflow"` entry (review #5). A workflow orchestrates
 * these in order; each member MUST resolve to a present registry `CapabilityEntry`.
 * The member declares the MAXIMUM verbs the orchestrator may exercise on it during
 * a workflow run — this is what gets folded into the synthesized transitive scope
 * (§5b) and surfaced to the user at grant-confirm time.
 */
export interface WorkflowMember {
  /** The member capability id — MUST be a present registry entry. */
  id: CapabilityId;
  /**
   * The verbs this workflow may exercise on the member during a run. MUST be a
   * subset of the member entry's required `grants`. The union of all members'
   * verbs (per id) is the workflow's transitive demand, shown to the user.
   */
  verbs: GrantVerb[];
}

// ============================================================================
// §1b  USER-EXTENSION MANIFEST (Flow B — "one sentence → extension")
// ----------------------------------------------------------------------------
// The minimal contract that lets a user-defined extension wrap a CLI / script /
// localhost HTTP API as capability entries, presented IDENTICALLY to ingested
// MCP tools (review #secondary, Flow B must be demoable e2e). Registered via
// `POST /extensions` (§5d). The gateway turns a manifest into `CapabilityEntry`s
// on scan, so the extension source is just another `CapabilitySource`.
// ============================================================================

/**
 * One capability an extension contributes. Mirrors `CapabilityEntry`'s call
 * surface but omits gateway-derived fields (id is derived per the ID-DERIVATION
 * RULE from the manifest's source slug + this entry's `noun.verb`).
 */
export interface ExtensionCapabilityDecl {
  /** `<noun>.<verb>` suffix; the full id becomes `<sourceSlug>.<noun>.<verb>`. */
  name: string;
  kind: EntryKind;
  label: string;
  /** The agent-facing "what / when / how" — same role as `CapabilityEntry.describe`. */
  describe: string;
  io?: IoSchema;
  grants: GrantVerb[];
  /** Non-mcp transport this extension capability is reached over. */
  transport: Exclude<TransportKind, "mcp">;
  /** For kind:"workflow": members (must resolve to present entries once registered). */
  members?: WorkflowMember[];
  /** For kind:"skill": the inline usage body. */
  body?: SkillBody;
  /**
   * Transport routing config the extension transport needs (e.g. cli binary +
   * argv template, local-rest base-url hint + which credential to attach). Read
   * ONLY by the owning transport, never by core. See `ExtensionSecretRef`.
   */
  route?: Record<string, unknown>;
}

/**
 * A reference (NOT the value) to a secret the extension transport must present
 * to the underlying service — e.g. the Obsidian Local REST API bearer key
 * (review #secondary). The actual secret lives under `~/.plexus/secrets/` and is
 * resolved by the platform seam (`PlatformServices.resolveSecret`); it NEVER
 * appears in the manifest, the `.well-known` doc, the manifest snapshot, or audit.
 */
export interface ExtensionSecretRef {
  /** Logical secret name, e.g. "obsidian-rest-api-key". */
  name: string;
  /** How the transport attaches it. */
  attach: "bearer" | "header" | "query" | "env";
  /** Header/query/env key name when `attach` is "header" | "query" | "env". */
  as?: string;
}

/**
 * The user-extension manifest. Declares a source and the capability entries it
 * contributes. Registered at `POST /extensions`; the gateway materializes a
 * `CapabilitySource` whose `scan()` returns the projected entries.
 */
export interface ExtensionManifest {
  /** Manifest schema version. */
  manifest: "plexus-extension/0.1";
  /** The SourceId this extension registers (its id-slug seeds every entry id). */
  source: SourceId;
  label: string;
  /** Default transport for capabilities that don't override it. */
  transport: Exclude<TransportKind, "mcp">;
  /** The capabilities/skills/workflows this extension contributes. */
  capabilities: ExtensionCapabilityDecl[];
  /** Secret references this extension's transports require (resolved via platform seam). */
  secrets?: ExtensionSecretRef[];
  /** Optional how-to-locate hint for a local-rest/ipc service. */
  serviceHint?: LocalServiceHint;
}

/** Request body of `POST /extensions` — register a user extension (review #secondary, Flow B). */
export interface ExtensionRegisterRequest {
  /** Must reference an active handshake session (registration is user-authorized). */
  sessionId: string;
  manifest: ExtensionManifest;
}

/**
 * Response of `POST /extensions`. On success the extension's `CapabilitySource` is
 * materialized and its projected entries enter the registry; a `manifest_changed`
 * event fires so connected agents re-fetch (review #9). Makes Flow B demoable e2e.
 */
export interface ExtensionRegisterResponse {
  ok: boolean;
  source: SourceId;
  /** The capability ids the extension contributed. */
  registered: CapabilityId[];
  /** New manifest revision (agents compare to know to re-fetch). */
  revision: number;
  reason?: string;
}

// ============================================================================
// §2  DISCOVERY / `.well-known` SUMMARY SHAPES
// ----------------------------------------------------------------------------
// The `.well-known` document is the PRE-SESSION, unauthenticated advertisement
// MCP deliberately lacks. It is deliberately a SUMMARY (no full schemas/grants)
// so an agent can window-shop without a handshake.
// ============================================================================

/**
 * One line in the `.well-known` capability summary list. Enough to decide
 * whether to handshake; NOT enough to call (no io/grants detail, no skill body).
 */
export interface CapabilitySummary {
  id: CapabilityId;
  source: SourceId;
  kind: EntryKind;
  label: string;
  /** One-line teaser of `describe` (full text arrives in the manifest). */
  summary: string;
  /** Verbs this entry requires — so the agent knows the grant cost up front. */
  grants: GrantVerb[];
  transport: TransportKind;
  // ── Trust posture (ADR-018, additive — mirrored from the full entry) ──────
  /** Source-class (3-class). Omitted ⇒ agent treats as "extension" (safe default). */
  provenance?: Provenance;
  /** Derived risk tier for narration. */
  sensitivity?: Sensitivity;
  /** The entry's own default trust-window (the gateway's likely approve-UI default). */
  recommendedTrustWindow?: TrustWindow;
  // ── Health (additive — mirrored from the full entry, inherited per-source) ──
  /**
   * The INHERITED per-source health SNAPSHOT (HEALTH), so an agent window-shopping
   * the `.well-known` summary sees the same advisory health it will see on the full
   * manifest entry. Per-source granularity (every summary of a source shares it).
   * Omitted ⇒ treat as "unknown".
   */
  health?: CapabilityHealth;
}

/** Identity + version block describing the gateway instance itself. */
export interface GatewayInfo {
  name: "plexus";
  /** Gateway implementation version. */
  version: string;
  /** Self-describe protocol version this gateway speaks (e.g. "0.1"). */
  protocol: string;
  /** Loopback base URL the gateway is bound to, e.g. "http://127.0.0.1:7077". */
  baseUrl: string;
  /** Optional friendly instance name set by the user. */
  instance?: string;
}

/**
 * The auth advertisement in `.well-known` — tells the agent HOW to obtain a
 * session and WHERE every endpoint lives. No secret material here; just the
 * protocol shape.
 *
 * ENDPOINT-NAMESPACE CONVENTION (review #nit, ADR-016): all session-scoped
 * protocol endpoints live under the flat top-level namespace — `/link/handshake`,
 * `/grants`, `/grants/refresh`, `/grants/revoke`, `/grants/status`, `/invoke`,
 * `/manifest`, `/events`. The agent MUST read URLs from THIS advertisement rather
 * than hard-coding paths (the gateway may relocate them across versions).
 */
/**
 * A machine-readable REQUEST-SHAPE hint for one endpoint (integration-legibility P6-SCHEMA).
 * Lets a cold agent send a correct request with ZERO guessing — no reverse-engineering the body
 * from 4xx errors. The `body` field names are LOAD-BEARING (they are the exact field names the
 * gateway reads); placeholder VALUES are shown in `<angle-brackets>`.
 */
export interface RequestShapeHint {
  /** The endpoint URL (same value as the sibling `*Url` field). */
  url: string;
  /** The HTTP method to use. */
  method: "POST" | "PUT" | "GET";
  /**
   * WHERE the credential/session goes, in words a cold agent can act on. E.g.
   * `"body.connectionKey"`, `"header:X-Plexus-Session"`, `"bearer + header:X-Plexus-Session"`.
   */
  auth: string;
  /**
   * An example request BODY to send verbatim (after substituting the `<…>` placeholders). The
   * KEYS are the exact field names the gateway reads — notably `connectionKey` (handshake, in the
   * BODY not a header), the `grants` decision-MAP object (not an array), and `id` (invoke, not
   * `capability`).
   */
  body: Record<string, unknown>;
}

/**
 * The three request-shape hints a cold integrator needs to get from "authorized" to "invoking"
 * with no trial-and-error (integration-legibility P6-SCHEMA). Additive; sits beside the endpoint
 * URL fields so the shape travels WITH the address.
 */
export interface AuthRequestShapes {
  /** `POST /link/handshake` — body `{ "connectionKey": "<key>" }` (in the BODY, not a header/bearer). */
  handshake: RequestShapeHint;
  /** `PUT /grants` — body `{ "grants": { "<capabilityId>": "allow" } }` (a decision-map, not an array). */
  grantRequest: RequestShapeHint;
  /** `POST /invoke` — body `{ "id": "<capabilityId>", "input": { … } }` (the field is `id`, not `capability`). */
  invoke: RequestShapeHint;
}

export interface AuthAdvertisement {
  /** Where to POST the handshake (`POST /link/handshake`). */
  handshakeUrl: string;
  /** Where to PUT grants once handshaken (`PUT /grants`). */
  grantsUrl: string;
  /**
   * WHERE TO REQUEST A GRANT (additive, discoverability fix). The sanctioned "create/ask for a
   * grant" affordance — the same endpoint as `grantsUrl`, named explicitly so a cold agent does
   * not have to guess the verb. Send `{ grants: { <capabilityId>: "allow" } }` (see
   * `grantRequestMethod`) with the session identified by `sessionHeader`. Low-sensitivity
   * first-party/managed READS are AUTO-GRANTED (a scoped token comes straight back, no human);
   * write/elevated/high/extension caps return `grant_pending_user` for the owner to approve.
   */
  grantRequestUrl?: string;
  /** The HTTP method for `grantRequestUrl` (currently `"PUT"`). */
  grantRequestMethod?: "PUT";
  /**
   * The header that identifies the handshake session on session-authenticated requests
   * (`GET /grants`, `PUT /grants`, `GET /manifest`, and — for grant-assist — `POST /invoke`).
   * Standardized so the SAME session works across every session-scoped endpoint.
   */
  sessionHeader?: string;
  /** The Plexus management console URL where the owner approves pending grants. */
  consoleUrl?: string;
  /** Where to POST a grant-backed token refresh (`POST /grants/refresh`) — review #4. */
  refreshUrl: string;
  /** Where to POST a revocation (`POST /grants/revoke`) — review #3. */
  revokeUrl: string;
  /** Where to GET a pending-grant decision status / poll it (`GET /grants/status`) — review #9. */
  grantStatusUrl: string;
  /** Where to POST capability invocations (`POST /invoke`) — review #nit. */
  invokeUrl: string;
  /** Where to GET a fresh manifest snapshot without re-handshaking (`GET /manifest`) — review #9. */
  manifestUrl: string;
  /** Where to open the live event stream for list_changed / grant-resolved pushes (`GET /events`, SSE) — review #9. */
  eventsUrl: string;
  /**
   * Where to GET the standing-grant ledger (`GET /grants`) — the caller's durable
   * trust (ADR-018, additive). Session-authenticated like `/manifest`.
   */
  grantsListUrl?: string;
  /**
   * How the connection-key is delivered to the agent. "user-paste": the user
   * copies a key from the management client and hands it to the agent out of
   * band (default, most secure). "callback": reserved for future local OAuth.
   */
  connectionKeyDelivery: "user-paste" | "callback";
  /** Token scheme the gateway issues (see §4). */
  tokenScheme: "plexus-scoped-jwt";
  /**
   * MACHINE-READABLE REQUEST SHAPES (additive, integration-legibility P6-SCHEMA). The exact BODY
   * an agent should send to the three endpoints that a cold integrator otherwise reverse-engineers
   * from 4xx errors: handshake (`connectionKey` in the body), grant-request (`grants` decision-map),
   * and invoke (`id`, not `capability`). Present so a blind agent needs zero guessing.
   */
  requestShapes?: AuthRequestShapes;
}

/** Response body of `GET /.well-known/plexus`. */
export interface WellKnownDocument {
  gateway: GatewayInfo;
  /** Summary list of ALL discoverable entries (capabilities+skills+workflows). */
  capabilities: CapabilitySummary[];
  auth: AuthAdvertisement;
}

// ============================================================================
// §3  HANDSHAKE / MANIFEST SHAPES
// ----------------------------------------------------------------------------
// The handshake exchanges a connection-key for a session + the FULL manifest
// (full describe / io / grants / transport / attached skill bodies per entry).
// ============================================================================

/** Request body of `POST /link/handshake`. */
export interface HandshakeRequest {
  /** The connection-key the user pasted from the management client. */
  connectionKey: string;
  /** Free-form agent identity for the audit trail (model id, client name). */
  client?: {
    name?: string;
    version?: string;
    /** Stable agent identifier if the client has one (for per-agent grants). */
    agentId?: string;
  };
}

/**
 * The full self-describe manifest. This is the agent's complete, callable view
 * of the machine's capabilities for this session.
 */
export interface Manifest {
  gateway: GatewayInfo;
  /** Full entries — every field, including io schemas, grants, mcp passthrough. */
  entries: CapabilityEntry[];
  /** Opaque session handle the agent uses for subsequent grant/invoke calls. */
  sessionId: string;
  /** When this session/manifest view expires and must be re-handshaken. */
  expiresAt: IsoTimestamp;
  /**
   * Monotonic revision of the entry set (review #9). Bumped whenever entries
   * change (an MCP server emits list_changed, a source like Obsidian comes online
   * post-handshake, an extension registers). The agent compares this against the
   * `revision` carried on `ManifestChangedEvent` to know its manifest is stale and
   * re-fetch via `GET /manifest`.
   */
  revision: number;
}

/** Response body of `POST /link/handshake`. */
export interface HandshakeResponse {
  sessionId: string;
  manifest: Manifest;
  /**
   * Before any grant, the agent holds NO scoped token. This echoes the grant
   * endpoint so the agent knows where to request scopes next.
   */
  grantsUrl: string;
  expiresAt: IsoTimestamp;
}

// ============================================================================
// §3b  MANIFEST REFRESH + EVENT STREAM  (review #9, ADR-013)
// ----------------------------------------------------------------------------
// The handshake manifest is a one-shot snapshot. When the entry set changes
// mid-session (MCP list_changed, a source coming online, an extension being
// registered) the agent's view goes stale with no way to learn short of a full
// re-handshake. Fix: a pull endpoint (`GET /manifest`) AND a push channel
// (`GET /events`, Server-Sent Events). Also carries the resolution of a
// `grant_pending_user` decision so a pending grant never dead-ends.
// ============================================================================

/**
 * Response body of `GET /manifest` (session-authenticated via a header the
 * handshake established, e.g. `X-Plexus-Session: <sessionId>`). Returns the
 * CURRENT full manifest snapshot WITHOUT minting a new session or requiring a new
 * connection-key (review #9). Cheap to call; the agent uses it after seeing a
 * `ManifestChangedEvent` (or proactively if it suspects staleness).
 */
export interface ManifestRefreshResponse {
  manifest: Manifest;
}

/**
 * Discriminated event pushed over an SSE stream (review #9).
 *
 * Two audiences share ONE event union (the in-process `EventBus` is a single
 * fan-out): the AGENT stream `GET /events` carries the agent-relevant variants
 * (`manifest_changed` / `grant_resolved` / `token_revoked` / `source_status`),
 * and the MANAGEMENT stream `GET /v1/events` (REDESIGN-ARCHITECTURE §2.3) carries
 * those PLUS the management-only variants below (`pending_added` /
 * `pending_resolved` / `audit_appended`) that drive a tray badge + native
 * notifications + a live audit pulse without polling. Additive-only.
 */
export type PlexusEvent =
  | ManifestChangedEvent
  | GrantResolvedEvent
  | TokenRevokedEvent
  | SourceStatusEvent
  | PendingAddedEvent
  | PendingResolvedEvent
  | AuditAppendedEvent;

/** The entry set changed; the agent should re-fetch `GET /manifest`. */
export interface ManifestChangedEvent {
  type: "manifest_changed";
  /** New manifest revision (compare against the held `Manifest.revision`). */
  revision: number;
  /** Optional hint: ids added/removed/changed since the last revision. */
  changed?: { added?: CapabilityId[]; removed?: CapabilityId[]; updated?: CapabilityId[] };
}

/** A previously-pending grant was decided (review #9 — the pending resolution channel). */
export interface GrantResolvedEvent {
  type: "grant_resolved";
  pendingId: string;
  decision: "approved" | "denied" | "expired";
  /** Present iff approved — the agent fetches/holds the new token. */
  token?: ScopedToken;
}

/** A token the agent holds was revoked (review #3/#8) — stop using it immediately. */
export interface TokenRevokedEvent {
  type: "token_revoked";
  jti: string;
  reason?: string;
}

/** A source's availability changed (e.g. Obsidian went offline) — diagnostics for the agent. */
export interface SourceStatusEvent {
  type: "source_status";
  source: SourceId;
  available: boolean;
  reason?: string;
}

// ── MANAGEMENT-PLANE event variants (REDESIGN-ARCHITECTURE §2.3) ─────────────
// Carried ONLY over the management SSE stream `GET /v1/events` (the agent stream
// `GET /events` filters these out). They drive a tray badge + native "Agent X
// wants to WRITE your vault…" notification + a live audit pulse. Redaction-safe:
// they carry projections (no token strings, no connection-keys, no raw input).

/**
 * A redaction-safe projection of a pending item for the management stream. Mirrors
 * the human-facing fields of the admin `GET /v1/pending` (a.k.a. `/admin/api/pending`)
 * list — NO secrets, NO token material. For a grant it carries the gateway-authored
 * `PendingNarration` (so the tray notification reads the SAME truth as the web admin);
 * for a register it carries only the source label + flags.
 */
export interface PendingEventItem {
  pendingId: string;
  kind: "grant" | "register";
  createdAt: IsoTimestamp;
  /** For a grant: the requesting agent identity. */
  agentId?: string;
  /** For a grant: the capability ids the human is being asked to approve. */
  capabilities?: CapabilityId[];
  /** For a grant: the gateway-authored narration (drives the native notification). */
  pendingNarration?: PendingNarration[];
  /** For a register: the source being installed. */
  source?: SourceId;
}

/**
 * A new pending item was created — an agent's `PUT /grants` or `POST /extensions`
 * produced something awaiting a human decision (REDESIGN-ARCHITECTURE §2.3). Drives
 * the tray badge + the native approval notification (AUTHZ-UX §2 Mode-1).
 */
export interface PendingAddedEvent {
  type: "pending_added";
  item: PendingEventItem;
}

/** A pending item was approved/denied (or expired) — clear it from the tray inbox. */
export interface PendingResolvedEvent {
  type: "pending_resolved";
  pendingId: string;
  kind: "grant" | "register";
  decision: "approved" | "denied" | "expired";
}

/**
 * A redaction-safe projection of one appended audit event (the dashboard "audit
 * pulse" without polling, REDESIGN-ARCHITECTURE §2.3). Carries the event id + type
 * + correlation ids + timestamp ONLY — never the (already-redacted) `detail` blob,
 * so no secret/input material can ride the management stream even by accident.
 */
export interface AuditAppendedEvent {
  type: "audit_appended";
  id: string;
  auditType: AuditEventType;
  at: IsoTimestamp;
  agentId?: string;
  capabilityId?: CapabilityId;
  outcome?: "ok" | "error" | "denied";
}

// ============================================================================
// §4  GRANTS & SCOPED-TOKEN MODEL
// ----------------------------------------------------------------------------
// Per-capability scoped grants — the thing MCP's whole-server-audience auth
// cannot express. Default-deny, default-read-only. (ADR-005.)
// ============================================================================

/**
 * A per-entry grant decision. Verbs default to read-only when "allow" is given
 * without an explicit verb set; "deny" revokes regardless of verbs.
 */
export interface GrantDecision {
  decision: "allow" | "deny";
  /**
   * Verbs being granted (subset of the entry's required `grants`). Omitted ⇒
   * read-only default (["read"] if the entry requires read, else minimal). A
   * call is allowed only if every verb the entry REQUIRES is present here.
   */
  verbs?: GrantVerb[];
  /**
   * Trust-window the requester proposes (ADR-018, additive). On the AGENT path it
   * is advisory — the authorizer/human may SHORTEN it (never lengthen past the
   * per-class ceiling). On the ADMIN approve path it is authoritative (the human's pick).
   */
  trustWindow?: TrustWindow;
  /**
   * NEW (additive, AUTHZ-UX §2.N1). Agent-supplied FREE TEXT describing WHY it needs
   * this capability now — the "in order to [purpose Z]" of Mode-1 ad-hoc approval.
   * Rendered to the human, clearly labeled "the agent says:" in a visually-distinct
   * block. NEVER merged into the gateway-authored `PendingNarration.summary` (which
   * the gateway alone authors) — the human always sees gateway truth and the agent's
   * claim separately (anti-injection). TRANSPARENCY ONLY: `purpose` influences NO
   * authorization decision. Capped + render-safe server-side (truncated to 280 chars,
   * control chars stripped — never trust client length). Optional: a v0.1.2 client
   * omits it and nothing changes.
   */
  purpose?: string;
  /**
   * NEW (additive, AUTHZ-UX §3.1). A scope CONSTRAINT the requester/admin asks to
   * attach to this grant — predicates over a call's `input` that must hold for the
   * granted scope to cover a call. A constraint can ONLY NARROW authority (default-deny
   * OUTSIDE it); it never widens. The minted token carries the ENFORCED copy on
   * `TokenScope.constraint`. Optional: an unconstrained grant is today's whole-capability
   * behavior. See `ScopeConstraint`.
   */
  constraint?: ScopeConstraint;
}

/**
 * NEW (additive, AUTHZ-UX §3.1). A predicate set over a call's `input` that NARROWS a
 * granted scope: ALL present predicates must hold (AND) for the scope to cover a call.
 * Empty / absent ⇒ unconstrained (today's whole-capability behavior). A constraint can
 * ONLY ever narrow — there is no path by which adding one grants authority the bare
 * (id + verbs) scope did not already confer (the scope must still match id + verbs first).
 *
 * ENFORCEMENT (the security-critical contract): evaluated by `constraintSatisfied()`
 * (`src/core/constraint.ts`) at the SAME invoke chokepoint every call already passes
 * (`scopesCover` → pipeline). A call whose `input` fails the constraint makes the scope
 * INERT, so coverage fails → the existing `grant_required` denial (NO new ErrorCode).
 * FAIL CLOSED: a missing/malformed input field, or an unknown/unsupported op, ⇒ the
 * predicate is FALSE (denied). The enforced constraint rides in the signed JWT scopes —
 * it comes from the verified token, never from the request body.
 *
 * v1 GRANULARITY (AUTHZ-UX D2): `pathPrefix` + `allow` (resource-id allowlist) are the
 * enforced flagship cases; `match` supports eq/prefix/in. `match.op:"regex"` is NOT
 * enforced in this phase (ReDoS/mis-anchor footgun) — the enforcer FAILS CLOSED on it.
 * The shape stays in the contract for forward-compat.
 */
export interface ScopeConstraint {
  /**
   * Path-prefix confinement: the named input field, treated as a relative path, must
   * resolve to a location UNDER one of these prefixes. Enforced with the same lexical
   * normalize-and-reject-traversal logic as the obsidian vault confinement (reject `..`,
   * absolute paths, and prefix-escape) — `Inbox/` cannot be defeated by `Inbox/../x`.
   * e.g. `{ field: "path", allow: ["Inbox/", "Archive/2026/"] }`.
   */
  pathPrefix?: { field: string; allow: string[] };
  /**
   * Resource-id allowlist: the named input field must EXACTLY equal one of these values.
   * e.g. `{ field: "calendarId", values: ["work-cal"] }`.
   */
  allow?: { field: string; values: string[] };
  /** Generic value predicates on input fields (equals / prefix / in-set; regex reserved, not enforced). */
  match?: ScopeMatch[];
}

/**
 * NEW (additive, AUTHZ-UX §3.1). One value predicate inside a `ScopeConstraint.match`.
 * `field` is a dotted path into the call `input` (e.g. "params.folder"). FAIL CLOSED:
 * a missing field, a type mismatch, or an unsupported `op` ⇒ FALSE. `op:"regex"` is
 * RESERVED for a later phase and is NOT enforced here (the enforcer rejects it ⇒ FALSE).
 */
export interface ScopeMatch {
  /** Dotted path into `input`, e.g. "path" or "params.folder". */
  field: string;
  op: "eq" | "prefix" | "in" | "regex";
  /** Comparand for op:"eq" / op:"prefix". */
  value?: string | number | boolean;
  /** Comparand set for op:"in". */
  values?: (string | number | boolean)[];
  /** RESERVED for op:"regex" (anchored, length-capped) — NOT enforced in this phase. */
  pattern?: string;
}

/**
 * Request body of `PUT /grants`. Maps entry id → allow/deny (+ optional verbs).
 * Shorthand form `"allow" | "deny"` is accepted on the wire and normalized to
 * `GrantDecision` server-side (read-only default).
 */
export interface GrantRequest {
  /** Must reference an active handshake session. */
  sessionId: string;
  /** id → decision. */
  grants: Record<CapabilityId, GrantDecision | "allow" | "deny">;
  /**
   * NEW (additive, AUTHZ-UX §2.N3 / D4). Agent-requested MODE-2 TASK BUNDLE envelope.
   * When present, the multi-capability (+constraint) request is treated as ONE named
   * task bundle: the gateway tags each member grant with a shared `bundleId` + name and,
   * under `UserConfirmAuthorizer`, group-pends the risky members as ONE pending item
   * (`PendingView.bundle`) so the human approves the whole task in a single Approve.
   * The anti-self-grant linchpin holds — an agent's bundle still PENDS its risky members;
   * it can never auto-approve them. Optional context refs flow through the existing skill
   * mechanism (D3). A v0.1.2 client omits it and nothing changes.
   */
  bundle?: { name: string; agentId?: string; context?: GrantContextRef[] };
}

/**
 * NEW (additive, AUTHZ-UX §2.N3 / D3). A reference to one piece of in-scope TASK CONTEXT
 * attached to a bundle. Context REUSES the existing `kind:"skill"` mechanism — there is
 * NO new transport:
 *  - `kind:"skill"`  → reference an EXISTING `kind:"skill"` entry by `skillId`; it is
 *                      attached to the bundle's capabilities so it flows through the
 *                      normal manifest / `plexus skills <id>` path.
 *  - `kind:"inline"` → a small inline `markdown` blob (capped at `MAX_SKILL_BODY_BYTES`,
 *                      64 KiB) that the gateway MATERIALIZES as a `kind:"skill"` entry under
 *                      a synthetic `bundle:<id>` source (via the existing registerExtension /
 *                      materialize path) and attaches — again, no parallel channel.
 */
export interface GrantContextRef {
  kind: "skill" | "inline";
  /** For kind:"skill": the id of the existing `kind:"skill"` entry to reference. */
  skillId?: CapabilityId;
  /** Short label (for an inline blob's materialized skill, and for the context list). */
  label?: string;
  /** For kind:"inline": the markdown body (capped at `MAX_SKILL_BODY_BYTES`). */
  markdown?: string;
}

/**
 * TRANSITIVE-GRANT semantics for workflows (review #5, ADR-012). Granting a
 * `kind:"workflow"` entry does NOT by itself authorize its members: the
 * orchestrator runs each member under a SYNTHESIZED INTERNAL SCOPE derived from
 * the workflow's `members[]`. This type makes that derivation explicit and
 * SURFACEABLE to the user at grant-confirm time, so "allow cc-master.orchestration.run"
 * visibly carries "…which will also run board.create (write), agent.dispatch
 * (execute), board.status (read)." The synthesized scopes are stamped into the
 * issued token's `scopes` alongside the workflow scope, so member dispatch is
 * scope-checked through the SAME uniform pipeline (review #6) with no silent
 * escalation.
 */
export interface TransitiveGrant {
  /** The workflow being granted. */
  workflowId: CapabilityId;
  /**
   * The member scopes synthesized from `members[]` — each member id with the
   * verbs the workflow may exercise on it. Every id MUST be a present registry
   * entry. These are added to the token's `scopes` (flagged `synthesizedFor`).
   */
  memberScopes: TokenScope[];
}

/**
 * One scope line inside a scoped-token: which capability, which verbs. The
 * token's authority is exactly the union of its `scopes`. A scope may be
 * SYNTHESIZED for a workflow (review #5): when present, `synthesizedFor` names the
 * granting workflow id, so audit/UI can show WHY the agent holds a member scope it
 * never directly requested.
 */

export interface TokenScope {
  id: CapabilityId;
  /** Granted verbs for this id. Enforced per-call against the entry's required verbs. */
  verbs: GrantVerb[];
  /**
   * Present iff this scope was SYNTHESIZED as a workflow's transitive member scope
   * (review #5): the workflow id that implied it. Lets audit/UI explain why the
   * token holds a member scope the agent never directly requested.
   */
  synthesizedFor?: CapabilityId;
  /**
   * NEW (additive, AUTHZ-UX §3.1). The ENFORCED scope constraint (the copy that rides
   * in the signed JWT `scopes` and is checked at invoke). When present, this scope only
   * COVERS a call whose `input` satisfies the constraint (`constraintSatisfied`); else
   * the scope is INERT and coverage fails → `grant_required` (default-deny outside the
   * constraint). Absent ⇒ today's whole-capability scope (unchanged). A constraint can
   * only NARROW. Carried through `signToken` automatically (scopes are signed verbatim).
   */
  constraint?: ScopeConstraint;
}

/**
 * The decoded claims of a Plexus scoped-token. WIRE FORMAT = signed JWT
 * (HS256, gateway-held secret), so the body is self-contained and stateless to
 * verify, BUT every token id is also tracked server-side in a revocation
 * registry so grants can be revoked before expiry (ADR-006). Opaque to the
 * agent; the agent just presents the compact JWT string.
 */
export interface ScopedTokenClaims {
  /** JWT subject — the agent identity from handshake (audit linkage). */
  sub: string;
  /** Issuer — always this gateway instance id. */
  iss: string;
  /** The session this token belongs to. */
  sessionId: string;
  /** Unique token id — the handle used for revocation + audit correlation. */
  jti: string;
  /** The granted scopes — token authority is exactly this set. */
  scopes: TokenScope[];
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). Default lifetime short (see ADR-006). */
  exp: number;
  /**
   * Grant/trust-window expiry epoch seconds (ADR-018, additive diagnostics). The
   * standing-trust ceiling the token refreshes up to, distinct from the short `exp`.
   */
  gexp?: number;
}

/** Response body of `PUT /grants` — the freshly minted scoped-token. */
export interface ScopedToken {
  /** Compact signed JWT string the agent presents on invocation (Bearer). */
  token: string;
  /** Decoded scopes echoed for agent convenience (authoritative copy is in the JWT). */
  scopes: TokenScope[];
  jti: string;
  expiresAt: IsoTimestamp;
  /**
   * The transitive workflow grants folded into `scopes` this issuance (review #5).
   * Empty/omitted when no workflow was granted. Surfaced so the agent and the UI
   * see exactly which member scopes a workflow grant pulled in.
   */
  transitive?: TransitiveGrant[];
  /**
   * The trust-window ceiling next to the short `expiresAt` (ADR-018, additive) —
   * how long the backing grant stands / refresh may continue. Omitted for a
   * "once" grant whose window does not stand.
   */
  grantExpiresAt?: IsoTimestamp;
  /** The trust-window the backing grant was approved under (ADR-018, additive). */
  trustWindow?: TrustWindow;
}

/**
 * Response of `PUT /grants` when the configured `Authorizer` (ADR-007) returns
 * `pending` for one or more requested grants: NO token is minted yet; the agent
 * must poll `GET /grants/status` (review #9). The grants that WERE auto-approved
 * (if any) still mint a partial token. v1's default stub authorizer typically
 * never produces this (it auto-approves), but the path stays in the type surface
 * for a stricter plugged-in policy.
 */
export interface GrantPendingResponse {
  /** Discriminator so the agent can tell a pending response from a `ScopedToken`. */
  status: "grant_pending_user";
  /** A handle to poll the pending decision(s). */
  pendingId: string;
  /** The capability ids still awaiting a user decision. */
  pending: CapabilityId[];
  /** Where to poll (`GET /grants/status?pendingId=…`). */
  statusUrl: string;
  /**
   * Where the OWNER approves this pending grant (the Plexus management console). Additive —
   * echoed so the agent can tell the user EXACTLY where to go; it cannot approve on its own.
   */
  approvalUrl?: string;
  /** A partial token for any grants that WERE auto-approved this call (optional). */
  partialToken?: ScopedToken;
  /**
   * Gateway-authored narration per pending capability (ADR-018, additive) so the
   * agent can relay the exact same truth to the user (capability + verbs +
   * trust-window + revocability). One entry per `pending` id.
   */
  pendingNarration?: PendingNarration[];
}

/** Union returned by `PUT /grants`: either a token, or a pending notice. */
export type GrantResponse = ScopedToken | GrantPendingResponse;

/**
 * Response body of `GET /grants/status?pendingId=…` (review #9) — the resolution
 * channel for a `grant_pending_user` decision. The agent polls until `state` is
 * terminal. On `"approved"` the freshly-minted token is included.
 */
export interface GrantStatusResponse {
  pendingId: string;
  /** "pending": still awaiting the user. "approved"/"denied": terminal. "expired": the request timed out. */
  state: "pending" | "approved" | "denied" | "expired";
  /** The capability ids this pending request covered. */
  capabilities: CapabilityId[];
  /** Present iff state === "approved": the minted scoped-token. */
  token?: ScopedToken;
  /**
   * Gateway-authored narration per pending capability (ADR-018, additive) — the
   * same contract as on `GrantPendingResponse`, echoed here so a polling agent
   * can narrate while the decision is still pending.
   */
  pendingNarration?: PendingNarration[];
}

// ============================================================================
// §4a  THE AUTHORIZER SEAM  (locked user decision — ADR-007 revised)
// ----------------------------------------------------------------------------
// The authorize decision is a PLUGGABLE ABSTRACTION, not a hard-wired
// confirm-every-grant UI. An `Authorizer` takes a grant request + context and
// returns allow | deny | pending. v1 ships a SIMPLE STUB (auto-approve), keeping
// the configurable seam so a stricter policy (e.g. user-confirms-every-grant via
// the management client) can be plugged in WITHOUT a wire change. The
// `grant_pending_user` path stays in the type surface for that stricter policy.
// ============================================================================

/** The decision an `Authorizer` returns for a single requested grant. */
export type AuthorizationOutcome = "allow" | "deny" | "pending";

/** Context the gateway hands the authorizer alongside the grant request. */
export interface AuthorizationContext {
  /** The session requesting the grant. */
  sessionId: string;
  /** The agent identity (if any) behind the request. */
  agentId?: string;
  /** The entry being requested (for the policy to inspect kind/verbs/source). */
  entry: CapabilityEntry;
  /** The verbs being requested for this entry. */
  requestedVerbs: GrantVerb[];
  /** Whether a prior user-approved grant for (agentId, id) already exists (re-use ⇒ no re-prompt). */
  hasPriorApproval: boolean;
  /**
   * REVOCATION TOMBSTONE (Fix 1). Whether (agentId, id) was just REVOKED and not yet re-approved.
   * When set, a low-risk first-party/managed READ that would otherwise auto-allow under
   * `confirm-risky` is routed to "pending" instead — so a still-running agent cannot silently
   * re-acquire a just-revoked capability. A fresh human approval lifts the tombstone. Absent/false
   * ⇒ unchanged behavior. (Write/execute/extension already pend, so the flag only ever tightens.)
   */
  revokedTombstone?: boolean;
}

/** One authorizer decision, per capability id. */
export interface AuthorizationDecision {
  id: CapabilityId;
  outcome: AuthorizationOutcome;
  /** Verbs actually authorized (≤ requested). Present when outcome === "allow". */
  verbs?: GrantVerb[];
  /** Human reason (shown in audit / management UI), esp. for deny/pending. */
  reason?: string;
  /** Source-class the decision was rendered against (ADR-018, for narration). */
  provenance?: Provenance;
  /** Derived risk tier (ADR-018, for narration). */
  sensitivity?: Sensitivity;
  /**
   * The recommended default trust-window (per class+verb table) the gateway will
   * DEFAULT in the approve UI (ADR-018). The human still picks the real one.
   */
  recommendedTrustWindow?: TrustWindow;
}

/**
 * THE PLUGGABLE AUTHORIZATION POLICY (ADR-007 revised). The gateway calls
 * `authorize` for each requested grant; the returned outcomes drive whether
 * `PUT /grants` mints a token, returns `grant_pending_user`, or denies. Swapping
 * the policy never touches the wire.
 *
 * v1 default = `AutoApproveAuthorizer` (a trivial permissive stub returning
 * "allow" for the entry's requested verbs). A stricter `UserConfirmAuthorizer`
 * returning "pending" until the user confirms in the management client is a drop-in
 * replacement that exercises the `grant_pending_user` + `GET /grants/status` path.
 */
export interface Authorizer {
  /** Stable policy id, surfaced in audit detail (e.g. "auto-approve", "user-confirm"). */
  readonly policy: string;
  authorize(ctx: AuthorizationContext): Promise<AuthorizationDecision>;
}

// ============================================================================
// §4b  TOKEN REFRESH  (grant-backed re-mint — review #4, ADR-011)
// ----------------------------------------------------------------------------
// Token lifetime is LOCKED at 15 min (user decision). The flagship cc-master
// workflow runs >24h, so a 15-min token MUST be re-mintable WITHOUT a new
// connection-key and WITHOUT re-prompting the user — re-minted purely from the
// PERSISTED grant, bounded by that grant's own validity. The agent retains only
// the (short-lived) token + a refresh handle, never the connection-key.
// ============================================================================

/**
 * Request body of `POST /grants/refresh`. Presents the (possibly just-expired)
 * token to refresh via `Authorization: Bearer <token>` AND the session it belongs
 * to. The gateway re-mints a NEW token with the SAME scopes from the persisted
 * grant — no connection-key, no re-prompt — provided: the session is still live,
 * the originating grant still exists and is not revoked, and the grant's own
 * validity window has not elapsed.
 */
export interface RefreshRequest {
  /** The session the expiring token belongs to (must still be live — review #8). */
  sessionId: string;
  /**
   * The jti being refreshed. The current token is ALSO presented in the
   * Authorization header (signature may verify even just past `exp`, within a
   * bounded grace, for refresh ONLY — never for invoke).
   */
  jti: string;
}

/**
 * Response of `POST /grants/refresh` — a brand-new short-lived token carrying the
 * same scopes, plus the bound on how long refresh may continue (the grant's
 * validity). Once `grantExpiresAt` passes, refresh fails with `token_revoked`/
 * `grant_required` and the agent must go back through `PUT /grants`.
 */
export interface RefreshResponse {
  token: string;
  scopes: TokenScope[];
  /** The new token id (the old jti is now revoked). */
  jti: string;
  /** New token expiry (≈ now + 15 min). */
  expiresAt: IsoTimestamp;
  /** Hard ceiling: refresh stops working past the grant's own validity window. */
  grantExpiresAt: IsoTimestamp;
}

// ============================================================================
// §4c  REVOCATION  (review #3, ADR-010)
// ----------------------------------------------------------------------------
// The spec always promised revoke-by-jti and revoke-by-(agentId, capabilityId)
// and the audit model has grant.revoke/token.revoke — but no endpoint/type
// existed. Added here. CRITICAL workflow rule: a workflow fan-out re-checks the
// ORIGINATING jti's revocation state before EACH member dispatch, so a mid-
// fan-out revoke halts subsequent members (review #3).
// ============================================================================

/**
 * Request body of `POST /grants/revoke`. Exactly one selector form:
 *  - by `jti`:                revoke a single token.
 *  - by `(agentId, capabilityId)`: revoke ALL tokens carrying that scope for that
 *                              agent, and remove the persisted grant so it can't be
 *                              silently re-minted via refresh.
 * Driven by the management client (the user's "revoke now" action) or by the agent
 * relinquishing its own token. Authorization: a connection-key-authenticated
 * management session, or the token itself (an agent may revoke its own jti).
 */
export interface RevokeRequest {
  /** Revoke a single token by id. */
  jti?: string;
  /** Revoke by scope: requires both fields together. */
  agentId?: string;
  capabilityId?: CapabilityId;
  /** Optional audit annotation. */
  reason?: string;
}

/** Response of `POST /grants/revoke`. */
export interface RevokeResponse {
  /** Whether anything was revoked. */
  ok: boolean;
  /** The jtis that were revoked as a result. */
  revokedJtis: string[];
  /** Whether the persisted grant was also removed (scope-form revoke). */
  grantRemoved: boolean;
  /** The audit event id recording the revocation. */
  auditId: string;
}

// ============================================================================
// §5  INVOCATION SHAPES
// ----------------------------------------------------------------------------
// How an agent actually CALLS a granted capability. One uniform endpoint;
// routing to the adapter/transport is internal (§6).
// ============================================================================

/**
 * Request body of `POST /invoke`. The scoped-token is presented in the
 * `Authorization: Bearer <token>` header, NOT in the body.
 */
export interface InvokeRequest {
  /** The entry to call. Must be covered by the presented token's scopes. */
  id: CapabilityId;
  /** Call arguments — validated against the entry's `io.input` JSON Schema. */
  input?: Record<string, unknown>;
  /**
   * Idempotency key for safe retries of side-effecting (write/execute) calls
   * (review #secondary — now has real semantics). When present, the gateway
   * dedupes on the tuple `(jti, id, idempotencyKey)` within a bounded window
   * (`IDEMPOTENCY_WINDOW_MS`, default 24h): a second request with the same tuple
   * returns the FIRST call's stored `InvokeResponse` verbatim instead of
   * re-dispatching. Keys are scoped to a token (jti) so they cannot be replayed
   * across agents. Read-only calls ignore it.
   */
  idempotencyKey?: string;
}

/**
 * The VERBATIM, lossless MCP result slot (review #2). Generalizes the old
 * tool-only `mcpContent` so resources and prompts round-trip without loss. Carries
 * whichever shape the originating MCP primitive returned:
 *  - tool      (`tools/call`)      ⇒ `content[]` (+ optional `structuredContent`), `isError`.
 *  - resource  (`resources/read`)  ⇒ `contents[]` (uri/mimeType/text/blob).
 *  - prompt    (`prompts/get`)     ⇒ `messages[]` (role + content).
 * At most one of content/contents/messages is populated, matching `mcp.primitive`.
 * The gateway never rewrites these; a future MCP-server façade re-emits them as-is.
 */
export interface McpResult {
  /** tool result content blocks (text/image/audio/resource_link/…), verbatim. */
  content?: unknown[];
  /** tool structured output, verbatim (when the server returns `structuredContent`). */
  structuredContent?: unknown;
  /** resource read result blocks, verbatim. */
  contents?: unknown[];
  /** prompt get result messages, verbatim. */
  messages?: unknown[];
  /**
   * MCP in-band tool error flag (review #secondary). When the server returns
   * `isError:true`, the gateway maps it to `InvokeResponse.ok=false` with
   * `error.code="mcp_tool_error"` while PRESERVING `content[]` here verbatim.
   */
  isError?: boolean;
}

/** Normalized result of an invocation, transport-agnostic. */
export interface InvokeResponse {
  id: CapabilityId;
  /** Whether the underlying call succeeded. (MCP `isError:true` ⇒ ok:false.) */
  ok: boolean;
  /** Structured output — conforms to the entry's `io.output` schema when present. */
  output?: unknown;
  /**
   * The verbatim MCP result, present for `transport:"mcp"` entries regardless of
   * primitive (tool/resource/prompt). Replaces the old tool-only `mcpContent`
   * (review #2) so nothing is lost in normalization for any MCP primitive.
   */
  mcpResult?: McpResult;
  /**
   * Present when ok=false.
   *
   * Since v0.1.1 (tp2 / ADR-017) /invoke returns this same `InvokeResponse` shape
   * for EVERY denial — auth/pre-dispatch as well as transport — so `error` (with
   * its closed `ErrorCode`) is the single denial channel on /invoke. The HTTP
   * status still distinguishes the failure class (401/404/422/…).
   */
  error?: ErrorBody;
  /**
   * AUTO-GRANT ATTACHMENT (additive). Present only on a grant-assisted invoke (the agent called
   * `POST /invoke` with a session — `sessionHeader` — but no Bearer token, for a low-sensitivity
   * first-party/managed READ): the gateway auto-issued the scoped grant, ran the invoke, and
   * ATTACHES the freshly-minted scoped token here so the agent keeps it for subsequent direct
   * `Authorization: Bearer` invokes. Omitted on every normal (already-tokened) invoke.
   */
  grant?: ScopedToken;
  /**
   * The audit event id recording this call (audit linkage). Set on every
   * DISPATCHED call and on every AUDITED pre-dispatch denial. For an /invoke denial
   * that fails at the EDGE before the pipeline audits (no token / malformed token /
   * unparseable body — tp2 / ADR-017), there is no audit event and this is the
   * EMPTY STRING `""` sentinel (the field stays present so the `InvokeResponse`
   * shape is uniform; `""` means "no audit event for this denial").
   */
  auditId: string;
}

/**
 * Default idempotency dedupe window (review #secondary): a `(jti, id,
 * idempotencyKey)` tuple is honored for re-dispatch suppression for this long.
 * 24h comfortably covers the cc-master >24h workflow's retried member dispatches
 * within a single refreshed-token lineage.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// §5b  REQUEST SECURITY CONTEXT  (review #7 Host/Origin, review #8 liveness)
// ----------------------------------------------------------------------------
// Loopback bind alone does not stop other LOCAL processes nor a DNS-rebinding
// BROWSER attack (a malicious page resolving a hostname to 127.0.0.1 and POSTing
// to /invoke). Standard MCP-local mitigation: validate the `Host` header equals
// the bound loopback authority and validate `Origin`. Enforced on EVERY endpoint
// BEFORE auth. Also: invoke is bound to a LIVE session (review #8).
// ============================================================================

/**
 * The host/origin guard the gateway applies to every request (review #7). A
 * request is rejected with `host_forbidden` unless BOTH hold:
 *  - `Host` header exactly equals `127.0.0.1:<port>` (or `localhost:<port>`),
 *    matching the bound loopback authority — defeats DNS-rebinding hostnames.
 *  - `Origin`, when present (browser-originated), is in `allowedOrigins`
 *    (default: only the management client's own origin; agent CLIs send no Origin).
 * Also documents that `.well-known` exposes a gateway version + capability-summary
 * FINGERPRINT to any local caller — acceptable for summaries (ADR-008), but full
 * detail still requires the connection-key handshake.
 */
export interface HostOriginPolicy {
  /** The exact loopback authority the Host header must match, e.g. "127.0.0.1:7077". */
  expectedHost: string;
  /** Origins permitted to call mutating endpoints from a browser context. */
  allowedOrigins: string[];
  /** Whether a missing Origin header (non-browser agent CLI) is allowed. Default true. */
  allowMissingOrigin: boolean;
}

/**
 * SESSION↔TOKEN LIVENESS (review #8). Invoke must not succeed on a token whose
 * session has been invalidated (e.g. by connection-key rotation) even if the JWT
 * has not yet expired. The gateway enforces this by checking the token's
 * `sessionId` against the LIVE-SESSION set on every invoke. When the connection
 * key rotates, sessions bootstrapped under the old key are invalidated AND their
 * outstanding tokens' jtis are ENQUEUED for revocation — so a rotated-out agent
 * cannot keep calling /invoke for up to 15 min (review #8). This type is the
 * liveness check result handed to the invoke pipeline.
 */
export interface SessionLiveness {
  sessionId: string;
  /** Whether the session is still live (not expired, not invalidated by key rotation). */
  live: boolean;
  /** When false, the reason — surfaced as `session_expired` to the agent. */
  reason?: string;
}

// ============================================================================
// §6  ADAPTER-LAYER ARCHITECTURE
// ----------------------------------------------------------------------------
// Two layers, mirroring pneuma-skills:
//   - CapabilitySource  (lifecycle layer): availability / scan / lifecycle.
//   - CapabilityBridge  (per-session protocol-translation): invoke / route.
// Plus the Transport interface (the call-wire seam) and the platform seam.
// The adapter type is HIDDEN behind these interfaces; core never branches on
// source/transport type (no scattered `if (id === ...)`).
// ============================================================================

/** Result of a source availability probe — is this source runnable right now? */
export interface SourceRequirementResult {
  ok: boolean;
  /** Human-readable reason when !ok (e.g. "Obsidian Local REST API not reachable"). */
  reason?: string;
  /** Resolved binary / endpoint that satisfied the requirement, for diagnostics. */
  resolved?: string;
}

/**
 * LIFECYCLE LAYER. One per capability source (first-party adapter, MCP server,
 * user extension). Owns availability, scan, and lifecycle. Mirrors pneuma
 * `AgentBackend` + `BackendModule`.
 */
export interface CapabilitySource {
  /** Unique source id. */
  readonly id: SourceId;
  readonly label: string;
  /** Which transport this source's entries are reached over. */
  readonly transport: TransportKind;

  /**
   * Cheap probe: is this source installed & reachable? (PATH lookup, port
   * ping, MCP initialize handshake.) Safe to call at startup; drives the
   * management client's availability badges. Uses the platform seam (§6) for
   * any OS-specific discovery.
   */
  checkRequirements(): Promise<SourceRequirementResult>;

  /**
   * OPTIONAL per-source HEALTH probe (additive). Reports the source's CURRENT
   * operational health (`ok`/`degraded`/`unavailable`/`unknown`) — richer than the
   * boolean `checkRequirements()`: only `health()` can report `"degraded"` (reachable
   * but impaired). The gateway's health service calls it on a short-TTL, stale-while-
   * revalidate basis (never on the hot discovery/handshake path) and stamps `checkedAt`.
   *
   * NOT IMPLEMENTED ⇒ DERIVE: when a source omits `health()`, the gateway derives
   * health from `checkRequirements()` — ok→"ok", not-ok→"unavailable" (reason as
   * detail). A source free to no-op this (and whose `checkRequirements` is the
   * optimistic default) reads as "unknown" — the connector's freedom, by design.
   * Keep it CHEAP: it is polled in the background; a slow probe must not block calls.
   */
  health?(): Promise<SourceHealth>;

  /**
   * SCAN: enumerate the self-describe entries this source provides. For an MCP
   * source this runs the MCP client (initialize → tools/list → resources/list →
   * prompts/list) and PROJECTS each primitive to a `CapabilityEntry` with
   * verbatim schemas + `mcp` passthrough. The MCP per-primitive list calls are CURSOR-
   * PAGINATED; scan() MUST page to exhaustion internally so large servers are
   * never silently truncated (review #secondary). For a user extension this reads
   * the `ExtensionManifest`. For a first-party orchestration source like cc-master,
   * scan() returns BOTH the workflow entry AND each of its member entries (review
   * #secondary, Flow A) so the workflow's `members[]` always resolve to present
   * registry entries (transitive grants have real targets). Called at startup and
   * on refresh.
   */
  scan(): Promise<CapabilityEntry[]>;

  /**
   * Start any long-lived resources. For MCP sources this owns a PERSISTENT MCP
   * client for the source's lifetime (review #secondary): one initialize'd session
   * reused across request-scoped invokes, re-initialized on session loss. Request-
   * scoped invokes never re-handshake the MCP server. Idempotent.
   */
  start(): Promise<void>;
  /** Tear down. Idempotent. */
  stop(): Promise<void>;

  /** Subscribe to live entry-set changes (e.g. MCP list_changed notifications). */
  onEntriesChanged?(cb: (entries: CapabilityEntry[]) => void): void;

  /**
   * Optional: a first-class, USER-CONFIRMED + AUDITED install action (review
   * #secondary, Flow A). Replaces stashing install metadata in `extras` (which
   * core NEVER reads). Used by first-party sources like cc-master to register
   * their Claude Code plugin. The gateway routes this through the same user-
   * authorization seam as a grant and emits a `source.install` audit event;
   * after install, `scan()` surfaces the workflow + members. Absent on sources
   * that need no install.
   */
  install?(deps: SourceInstallDeps): Promise<SourceInstallResult>;
}

/** Deps for the audited install action (review #secondary). */
export interface SourceInstallDeps {
  /** The audit handle (install is an audited action). */
  audit(event: AuditEventInput): Promise<AuditEvent>;
  /** The platform seam (locate/spawn the installer, e.g. `claude --plugin-dir`). */
  platform: PlatformServices;
}

/** Result of a source install action. */
export interface SourceInstallResult {
  ok: boolean;
  /** What was installed, for the audit detail (e.g. plugin id + path). */
  installed?: string;
  reason?: string;
}

/**
 * Cross-cutting deps handed to a bridge at construction (review #6, #secondary).
 * Now includes `audit` (folding the adapter-deps asymmetry: sources can audit
 * lifecycle/source_unavailable too) and `invokeById` (the re-entrant invoke
 * pipeline a `workflow` transport fans out through — review #6).
 */
export interface BridgeDeps {
  /** Append an audit event. The bridge MUST audit every invocation. */
  audit(event: AuditEventInput): Promise<AuditEvent>;
  /** Resolve a transport implementation by kind (no branching in the bridge). */
  getTransport(kind: TransportKind): Transport;
  /** Look up the full entry for an id (to read transport/mcp routing info). */
  getEntry(id: CapabilityId): CapabilityEntry | undefined;
  /**
   * RE-ENTER the uniform invoke pipeline for another entry (review #6). This is
   * how the `workflow` transport fans out to `members` WITHOUT the core ever
   * branching on `kind:"workflow"`: the workflow transport calls `invokeById` per
   * member, and each member dispatch goes through the SAME scope-check + audit +
   * transport routing as a top-level invoke. The pipeline re-checks the
   * originating jti's revocation state before EACH member dispatch (review #3),
   * so a mid-fan-out revoke halts the rest.
   */
  invokeById(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse>;
}

/**
 * The authorization context threaded through `invokeById` so member dispatch is
 * scope-checked under the SAME token/session as the originating call (review
 * #3/#6). Carries the originating jti so the pipeline can re-check revocation
 * before each member dispatch.
 */
export interface InvokeContext {
  /** The originating token id — re-checked for revocation before each dispatch. */
  jti: string;
  /** The session — re-checked for liveness (review #8). */
  sessionId: string;
  /** The agent identity (audit linkage). */
  agentId?: string;
  /** The token's scopes — member dispatch must be covered (incl. synthesized workflow scopes). */
  scopes: TokenScope[];
  /**
   * Threads an edge-span (agent ↔ primary) to the workload-span (primary ↔ proxy) of
   * the SAME logical invoke so the two audit records can be stitched together across
   * tiers (mesh §3.5 CorrelationId). Set at the mesh forward boundary; the audit events
   * a dispatch emits inherit it. Omitted on a single-gateway (non-federated) invoke.
   */
  correlationId?: string;
  /**
   * Which tier is RECORDING the audit events this context produces — `"proxy"` on a
   * tunnel-trusted forwarded invoke (the resource-owning gateway), omitted on the
   * primary/agent-facing path (mesh §3.5 / Invariant D). Stamped onto the emitted
   * `AuditEvent.tier` so the proxy's local log is self-identifying when it bubbles up.
   */
  tier?: GatewayMode;
}

/**
 * Result of routing an invocation through the bridge — mirrors pneuma's
 * RouteResult so core can stay dumb about what a bridge does or doesn't own.
 */
export type RouteResult =
  /** Bridge fully handled the call; result is authoritative. */
  | "handled"
  /** This entry's verb/op isn't supported by the source (e.g. read-only source got a write). */
  | "unsupported"
  /** Not this bridge's concern; gateway falls through to default handling. */
  | "passthrough";

/**
 * PER-SESSION PROTOCOL-TRANSLATION LAYER. One instance per (session × source).
 * Closes over its adapter so the adapter type stays PRIVATE to the impl — the
 * gateway core never sees it. Mirrors pneuma `BridgeBackend`.
 */
export interface CapabilityBridge {
  /** Which source this bridge fronts — for diagnostics only; never branched on by core. */
  readonly source: SourceId;

  /** Return the entries this bridge currently exposes (self-describe surface). */
  getCapabilities(): CapabilityEntry[];

  /**
   * INVOKE a granted capability. Pre-conditions (token covers id + verbs, session
   * live, jti not revoked) are enforced by the gateway BEFORE this is called; the
   * bridge translates the normalized `InvokeRequest` to the underlying transport
   * and normalizes the result back. `ctx` carries the authorization context so a
   * `workflow`-transport bridge can re-enter the pipeline for members (review #6).
   * MUST emit an audit event via `BridgeDeps.audit`.
   */
  invoke(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse>;

  /**
   * Decide ownership/handling of an invocation without executing — lets the
   * gateway pick the right bridge and detect unsupported ops uniformly.
   */
  route(id: CapabilityId): RouteResult;

  /** Tear down per-session resources. Idempotent. */
  disconnect(): Promise<void>;
}

/**
 * THE TRANSPORT SEAM. The adapter layer implements one of these per
 * `TransportKind`. The bridge calls `dispatch`; the transport owns the wire.
 * Adding a transport = implement + register; never edit callers.
 */
export interface Transport {
  readonly kind: TransportKind;

  /**
   * Execute a normalized call over this transport against a specific entry.
   * `entry` carries everything transport-specific (mcp passthrough origin,
   * cli binary, rest base url) so the transport needs no extra config. `ctx` is
   * present for transports that must RE-ENTER the invoke pipeline (the `workflow`
   * transport — review #6); leaf transports (mcp/cli/local-rest/…) ignore it.
   */
  dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    ctx?: TransportDispatchContext,
  ): Promise<TransportResult>;
}

/**
 * Context handed to a transport's `dispatch` when the call may fan out into the
 * invoke pipeline (review #6). Only the `workflow` transport uses it.
 */
export interface TransportDispatchContext {
  /** Re-enter the uniform invoke pipeline for a member id (scope-checked + audited). */
  invokeById(req: InvokeRequest, ctx: InvokeContext): Promise<InvokeResponse>;
  /** The originating authorization context (jti/session/scopes) for member dispatch. */
  invoke: InvokeContext;
}

/** Raw, transport-level result the bridge normalizes into an InvokeResponse. */
export interface TransportResult {
  ok: boolean;
  /** Decoded payload (parsed JSON, stdout, MCP structuredContent…). */
  data?: unknown;
  /**
   * The verbatim MCP result (review #2), present when the transport is "mcp".
   * Carries content[]/structuredContent/contents[]/messages[]/isError per the
   * originating primitive. Replaces the old tool-only `mcpContent`.
   */
  mcpResult?: McpResult;
  error?: ErrorBody;
}

/**
 * The `mcp` transport concretely (PRIVILEGED). Plexus runs an MCP CLIENT.
 * This sub-interface documents the extra lifecycle an MCP transport owns on top
 * of `Transport`. (`McpTransport extends Transport` for the verbatim wire.)
 *
 * The transport BRANCHES ON `entry.mcp.primitive` (review #1): a tool entry
 * dispatches via `call` (`tools/call`), a resource entry via `readResource`
 * (`resources/read`), a prompt entry via `getPrompt` (`prompts/get`). Each
 * returns its native shape into the verbatim `McpResult` slot. The persistent
 * MCP client (owned by `CapabilitySource.start()`) is reused across calls.
 */
export interface McpTransport extends Transport {
  readonly kind: "mcp";
  /**
   * initialize handshake against a server; returns negotiated protocol + server
   * info. OBLIGATION (review #secondary, lives in the impl): the client MUST send
   * its `clientInfo` + capabilities in `initialize` and MUST send the
   * `notifications/initialized` follow-up before any list or call. For
   * Streamable-HTTP MCP it MUST track the `Mcp-Session-Id`; the persistent client
   * (`CapabilitySource.start()`) owns and re-inits this for the source's lifetime.
   */
  initialize(serverId: string): Promise<{ protocolVersion: string; serverInfo: Record<string, unknown> }>;
  /**
   * tools/list (+ resources/list, prompts/list) → raw MCP objects for re-projection.
   * MUST page each per-primitive list call to exhaustion via the MCP cursor (review #secondary) —
   * the returned arrays are the FULL set, never a single truncated page.
   */
  list(serverId: string): Promise<{ tools: unknown[]; resources: unknown[]; prompts: unknown[] }>;
  /** tools/call — routes by tool NAME (`entry.mcp.originName`). Verbatim `content[]`+isError. */
  call(serverId: string, originName: string, args: Record<string, unknown>): Promise<TransportResult>;
  /**
   * resources/read (review #1) — routes by resource URI (`entry.mcp.originName`).
   * Returns the verbatim `contents[]` (uri/mimeType/text/blob) in `McpResult.contents`.
   */
  readResource(serverId: string, uri: string): Promise<TransportResult>;
  /**
   * prompts/get (review #1) — routes by prompt NAME (`entry.mcp.originName`) with
   * arguments. Returns the verbatim `messages[]` in `McpResult.messages`.
   */
  getPrompt(serverId: string, name: string, args: Record<string, unknown>): Promise<TransportResult>;
}

/**
 * The `workflow` transport concretely (review #6, ADR-014). There is NO external
 * wire: dispatch RE-ENTERS the uniform invoke pipeline per `entry.members[]` via
 * `ctx.invokeById`, so the gateway core NEVER branches on `kind:"workflow"`. Each
 * member dispatch is scope-checked (against the synthesized transitive scopes,
 * §5b) and audited through the same path as any invoke, and the originating jti's
 * revocation state is re-checked before EACH member (review #3). The orchestrator
 * is thus "just another transport," not a special case in the core.
 */
export interface WorkflowTransport extends Transport {
  readonly kind: "workflow";
  /** Requires `ctx` (the re-entrant pipeline) — fans out across `entry.members`. */
  dispatch(
    entry: CapabilityEntry,
    input: Record<string, unknown>,
    ctx: TransportDispatchContext,
  ): Promise<TransportResult>;
}

// ============================================================================
// §6b  CENTRAL REGISTRY + PLATFORM-ABSTRACTION SEAM
// ============================================================================

/**
 * The central registry — single source of truth aggregating every source
 * module. Mirrors pneuma `backends/index.ts: MODULES`. ALL callers go through
 * these helpers; NO `if (id === ...)` branching lives outside a source module.
 * A source ships a `SourceModule` from `sources/<id>/manifest.ts`; this registry
 * is the only place they're aggregated.
 */
export interface SourceModule {
  readonly id: SourceId;
  readonly label: string;
  readonly transport: TransportKind;
  /** Factory for the lifecycle-layer source. */
  createSource(deps: PlatformServices): CapabilitySource;
  /** Factory for a per-session bridge (protocol-translation layer). */
  createBridge(deps: BridgeDeps, sessionId: string): CapabilityBridge;
}

/** The aggregate registry contract. */
export interface SourceRegistry {
  /** Every registered source module. */
  all(): SourceModule[];
  /** Look up one module by id (the only sanctioned id→module mapping). */
  get(id: SourceId): SourceModule | undefined;
  /** Resolve a transport implementation by kind (the only sanctioned kind→transport mapping). */
  getTransport(kind: TransportKind): Transport;
}

/**
 * PLATFORM-ABSTRACTION SEAM. Everything OS-specific — binary discovery,
 * transport spawning, local-service location — lives behind this interface.
 * v1 ships a macOS implementation; Windows/Linux implement the same seam.
 * Reuses pneuma's path-resolver approach (login-shell PATH capture + fallback
 * candidate dirs). Core and adapters depend ONLY on this interface.
 */
export interface PlatformServices {
  readonly platform: "darwin" | "win32" | "linux";

  /** Resolve a binary to an absolute path (which/where + enriched PATH + cache). */
  resolveBinary(name: string): Promise<string | undefined>;
  /** Capture the user's real interactive shell PATH (login-shell, fallback dirs). */
  getEnrichedPath(): Promise<string>;
  /**
   * Locate a known local-service endpoint for an app (e.g. an app's localhost
   * REST port, a unix socket path). OS-specific lookup hidden here.
   */
  locateLocalService(hint: LocalServiceHint): Promise<LocalServiceLocation | undefined>;
  /** Spawn a subprocess with the enriched PATH (stdio/cli/mcp-stdio transports). */
  spawnProcess(spec: SpawnSpec): SpawnedProcess;
  /**
   * Resolve a NAMED secret to its value for a transport that must authenticate to
   * a local service (review #secondary — e.g. the Obsidian Local REST API bearer
   * key). Secrets live under `~/.plexus/secrets/` (OS keychain on platforms that
   * have one), referenced by `ExtensionSecretRef.name`. The value is handed ONLY
   * to the owning transport at dispatch time; it NEVER enters an entry, the
   * manifest, the `.well-known` doc, or audit `detail` (which is redacted — §7).
   * Returns undefined when the secret is not configured.
   */
  resolveSecret(name: string): Promise<string | undefined>;
}

/** A hint describing the local service to locate (kept OS-neutral). */
export interface LocalServiceHint {
  /** Logical app id, e.g. "obsidian". */
  app: string;
  /** Optional default port / socket name the adapter knows about. */
  defaultPort?: number;
  socketName?: string;
}

/** Where a located local service lives. */
export interface LocalServiceLocation {
  kind: "http" | "unix-socket" | "named-pipe";
  /** e.g. "http://127.0.0.1:27123" or "/tmp/app.sock". */
  address: string;
  /**
   * Name of the secret (resolved via `PlatformServices.resolveSecret`) that the
   * transport must present to authenticate to this service (review #secondary —
   * e.g. the Obsidian Local REST API bearer key). Absent for unauthenticated
   * local services. The value itself is NEVER carried here.
   */
  secretRef?: string;
}

/** Process spawn spec (transport-agnostic). */
export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Minimal handle to a spawned process (NDJSON/stdio transports own the framing). */
export interface SpawnedProcess {
  pid: number;
  write(data: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

// ============================================================================
// §7  AUDIT MODEL
// ----------------------------------------------------------------------------
// Every grant change and every invocation is auditable, retainable, revocable,
// and correlated to a token (jti) and an agent identity (sub).
// ============================================================================

/** What kind of event the audit log records. */
export type AuditEventType =
  | "handshake"
  | "grant.allow"
  | "grant.deny"
  | "grant.revoke"
  | "grant.pending"
  | "token.issue"
  | "token.refresh"
  | "token.revoke"
  | "invoke"
  | "source.install"
  /** Owner toggled a capability's top-level EXPOSURE ("What I expose"). */
  | "exposure.set";

/**
 * AUDIT REDACTION CONTRACT (review #secondary, ADR-009 amendment). Redaction is
 * a CONTRACT, not a comment. The single audit writer applies this pass to every
 * event before persisting: `detail` MUST NOT contain raw call `input` arguments,
 * token strings, connection-keys, or resolved secrets. Adapters hand redaction-
 * safe detail only (shapes/counts/ids, not values). This type names the fields
 * the writer scrubs so the rule is checkable, not aspirational.
 */
export interface AuditRedactionPolicy {
  /** detail keys whose VALUES are dropped/masked before persistence. */
  redactedKeys: string[];
  /** Whether raw call input is forbidden in detail entirely (default true). */
  forbidRawInput: boolean;
}

/** Input shape callers hand to `audit()` (gateway fills id + timestamp). */
export interface AuditEventInput {
  type: AuditEventType;
  /** Agent identity (token `sub`) responsible for the event. */
  agentId?: string;
  /** Token id correlation. */
  jti?: string;
  /** Session correlation. */
  sessionId?: string;
  /** Affected capability id (for grant/invoke events). */
  capabilityId?: CapabilityId;
  /** Verbs involved. */
  verbs?: GrantVerb[];
  /** Outcome for invoke events. */
  outcome?: "ok" | "error" | "denied";
  /**
   * Structured detail. MUST be redaction-safe per `AuditRedactionPolicy`: no raw
   * call input, no token/connection-key/secret material (review #secondary). The
   * single writer applies the redaction pass regardless, but callers should hand
   * safe detail to begin with.
   */
  detail?: Record<string, unknown>;
  /**
   * The invoke REQUEST args (the call `input`), captured so an audit reviewer can
   * see WHAT was asked — the Activity view's "request" pane. The single writer
   * applies the SAME redaction pass as `detail` (nested keys named in
   * `AuditRedactionPolicy.redactedKeys` — token/secret/connectionKey/… — are
   * masked) AND a size cap (top-level keys kept, long strings clipped, arrays/
   * objects bounded, marked when truncated). Callers hand the RAW input; the
   * writer is the single redaction+truncation choke point, so a secret in input is
   * NEVER persisted. Optional + backward-compatible: pre-existing events omit it.
   */
  input?: unknown;
  /**
   * The invoke RESULT, captured so an audit reviewer can see WHAT came back — the
   * Activity view's "result" pane. For a successful dispatch this is the returned
   * data; for a failure (dispatch error or a pre-dispatch denial) it is the error
   * (`{ error: { code, message } }`). Redacted + truncated by the single writer
   * exactly like `input`. Optional + backward-compatible.
   */
  output?: unknown;

  // ── MESH (federation, additive — see §9; mesh domain model §3.5) ──────────
  // All three optional: a v0.1.2 (single-gateway) client neither sets nor reads
  // them, and a depth-1 `primary` bearing its own workload (Q8) leaves them unset.
  /**
   * WHO/WHY behind the event — `{ agent, principal?, grantRef?, policyRef? }`
   * (mesh §1 Attribution / §3.5). On a single gateway `agentId` already carries the
   * "who"; `attribution` is the richer, federation-ready form (adds principal +
   * grant/policy refs) and supersedes nothing. Omitted ⇒ fall back to `agentId`.
   */
  attribution?: Attribution;
  /**
   * Threads an edge-span (agent ↔ primary) to the workload-span (primary ↔ proxy)
   * of the SAME logical invoke as it cascades down + the audit bubbles back up
   * (mesh §3.5 CorrelationId). Stable across tiers. Omitted on a single gateway.
   */
  correlationId?: string;
  /**
   * Which tier RECORDED this event — `"primary"` (the authority/aggregation root)
   * or `"proxy"` (the resource-owning gateway). The proxy's local log is
   * authoritative for its own capabilities; the primary keeps a redacted mirror
   * (Invariant D / Q7). Omitted ⇒ a single-gateway event (implicitly the primary).
   */
  tier?: GatewayMode;
}

/** A persisted audit event (append-only JSONL under ~/.plexus/audit/). */
export interface AuditEvent extends AuditEventInput {
  /** Unique event id (also returned in InvokeResponse.auditId). */
  id: string;
  /** When it happened. */
  at: IsoTimestamp;
}

// ============================================================================
// §8  ERROR ENVELOPE (uniform across endpoints)
// ----------------------------------------------------------------------------
// CLOSED error-code union (review #10) so agents can branch deterministically:
// re-grant vs. re-handshake vs. refresh vs. give up.
// ============================================================================

/**
 * The CLOSED set of stable machine error codes (review #10, ADR-015). Frozen at
 * v0.1.0. An agent branches its recovery strategy on this:
 *
 *  - token_expired           → call `POST /grants/refresh` (or re-grant) and retry.
 *  - token_revoked           → grant was revoked; must re-request via `PUT /grants`.
 *  - grant_required          → no scope for this id/verb; request a grant.
 *  - approval_required       → (invoke-time, additive) the invoke was for a capability the
 *                              session has no grant for AND the capability needs OWNER approval
 *                              (write / elevated / high-sensitivity / extension-provenance). The
 *                              gateway CREATED a pending record: the body carries `pendingId` +
 *                              `approvalUrl` (the Plexus console) + `grantStatusUrl` to poll. The
 *                              agent CANNOT mint its own token — a human must approve. (Low-sens
 *                              first-party/managed READS never reach this: they auto-grant.)
 *  - grant_pending_user      → grant awaits a user decision; poll `GET /grants/status`.
 *  - session_expired         → the handshake session expired; re-handshake.
 *  - unknown_capability      → no such entry id (likely a stale manifest; GET /manifest).
 *  - capability_unexposed    → the OWNER disabled this capability at the top level ("What
 *                              I expose"); it is invisible + ungrantable + uninvokable even
 *                              with a still-valid token (effective access = granted ∧ exposed).
 *                              NOT recoverable by the agent — the owner must re-enable it.
 *  - schema_validation_failed→ `input` failed the entry's `io.input` schema; fix args.
 *  - source_unavailable      → the underlying source/app is not reachable right now.
 *  - capability_unavailable  → (MESH, additive — Invariant E) the capability's HOME
 *                              (its workload, reached over the proxy tunnel) is down,
 *                              so the primary cannot route the invoke right now. The
 *                              typed signal carries `unavailableSince` (how long down)
 *                              instead of hanging. NOT distributed-system DR — a
 *                              capability has exactly one home (no replica/failover);
 *                              recovers when that home re-enrolls / comes back. A
 *                              single-gateway deployment never emits it (it has no
 *                              remote workloads), so a v0.1.2 client never sees it.
 *  - mcp_tool_error          → MCP server returned `isError:true`; see preserved content.
 *  - transport_error         → transport-level failure (HTTP/exit code/IPC).
 *  - host_forbidden          → Host/Origin check failed (review #7) — wrong host header.
 *  - rate_limited            → too many calls; back off.
 *  - internal_error          → unexpected gateway fault.
 */
export type ErrorCode =
  | "token_expired"
  | "token_revoked"
  | "grant_required"
  | "approval_required"
  | "grant_pending_user"
  | "session_expired"
  | "unknown_capability"
  | "capability_unexposed"
  | "schema_validation_failed"
  | "source_unavailable"
  | "capability_unavailable"
  | "mcp_tool_error"
  | "transport_error"
  | "host_forbidden"
  | "rate_limited"
  | "internal_error";

/** The error payload carried in `ErrorResponse` and `InvokeResponse.error`. */
export interface ErrorBody {
  /** Stable, CLOSED machine code (review #10). */
  code: ErrorCode;
  message: string;
  /** Optional capability id the error concerns. */
  capabilityId?: CapabilityId;
  /** Transport-level detail (HTTP status, MCP error object, exit code…). May be redacted. */
  detail?: unknown;
  /**
   * GRANT-ASSIST GUIDANCE (additive). Populated on the two invoke-without-grant denials so the
   * agent is steered to the ONE sanctioned, audited, owner-approved path — never toward forging
   * a token:
   *  - `code:"approval_required"` → `pendingId` (the record just created), `approvalUrl` (the
   *    Plexus console where the owner approves), and `grantStatusUrl` (poll for the minted token).
   *  - `code:"grant_required"` (no session presented) → `grantRequestUrl` + `sessionHeader` so the
   *    agent knows WHERE to request a grant and HOW to identify its session.
   * All omitted on every other code and on a normal (granted) invoke.
   */
  pendingId?: string;
  /** Where the OWNER approves a pending grant (the Plexus console) — with `approval_required`. */
  approvalUrl?: string;
  /** Where the agent polls a pending grant's status (`GET /grants/status?pendingId=…`). */
  grantStatusUrl?: string;
  /** Where the agent requests a grant (`PUT /grants`) — with the no-session `grant_required` guidance. */
  grantRequestUrl?: string;
  /** The header name that identifies the handshake session on grant/invoke requests. */
  sessionHeader?: string;
  /**
   * MESH (additive — Invariant E). Present with `code:"capability_unavailable"`: when
   * the capability's home (workload) first went unreachable, so the caller learns HOW
   * LONG it has been down rather than getting a hang. Omitted for every other code and
   * on a single-gateway deployment.
   */
  unavailableSince?: IsoTimestamp;
  /**
   * SIGNPOST (additive). The path to the unauthenticated discovery doc
   * (`GET /.well-known/plexus`) — populated on the catch-all not-found envelope so a
   * cold agent that lands on the root or a wrong path immediately learns where the
   * capability catalog + auth flow live. Omitted on typed, in-flow errors.
   */
  discovery?: string;
}

/** Uniform error body returned by any endpoint on failure. */
export interface ErrorResponse {
  error: ErrorBody;
}

// ============================================================================
// §9  FEDERATED CAPABILITY MESH  (ADDITIVE — forward-looking contract surface)
// ----------------------------------------------------------------------------
// CONTRACT-ONLY types for evolving Plexus from a single local gateway into a
// federated mesh: a `primary` gateway (the authority an agent integrates against)
// aggregating capabilities from many `proxy` gateways living next to the real
// services, with audit + catalog cascading up. See the domain model:
//   docs/design/federated-mesh-domain-model.md  (§1 language, §3 aggregates,
//   §5 invariants A–G, §7 ADR ledger).
//
// STRICT-SUPERSET / BACKWARD-COMPAT (Q8). Today's single gateway IS a depth-1
// `primary` bearing its own workload; a bare `CapabilityId` resolves under the
// default tenant/workload. EVERYTHING below is ADDITIVE — new types + new OPTIONAL
// fields only. A v0.1.2 client neither sets nor reads any of it and the frozen
// agent↔primary wire (handshake / grants / invoke / events / audit) is untouched.
// These are TYPES + CONTRACT only; no runtime logic ships with them.
// ============================================================================

/**
 * The AUTHORITY axis (mesh §0). A gateway's mode is fixed at boot (immutable) and
 * orthogonal to whether it bears a local workload (Invariant A):
 *  - "primary" = the authority root: agent-facing, holds grants, runs the
 *                authorizer, is the audit sink. MAY also bear its own workload.
 *  - "proxy"   = subordinate: bears local sources, dials out to a primary, keeps a
 *                local exposure veto + local audit, but DELEGATES authorization up
 *                (Invariant E — no proxy decides grants).
 * Exactly ONE gateway in a mesh is `primary`.
 */
export type GatewayMode = "primary" | "proxy";

/**
 * Org/ownership coordinate — the top namespace segment of a `CapabilityAddress`
 * (mesh §1). Personal = a single implicit `"local"` tenant (elided in UI); an
 * enterprise sets it explicitly (Q5). Keep-in-model, cap-operationally.
 */
export type TenantId = string;

/**
 * The identity a gateway claims for its LOCAL capabilities — the workload-path
 * segment(s) of a `CapabilityAddress` (mesh §1). Unique under its parent
 * (Invariant F). v1 convention caps operational depth at 1 (one workload segment)
 * via enrollment policy, NOT via grammar.
 */
export type WorkloadName = string;

/**
 * THE CAPABILITY ADDRESS — the logical identity (URN) of a capability across the
 * mesh (mesh §1 / §3.2, Invariant B: address is identity, route is location).
 *
 * GRAMMAR:  `tenant / <workload-path…> / source.capability`
 *   - `/` separates LOCATION segments (tenant, then the variable-depth workload path);
 *   - `.` separates the `source.capability` tail (today's `CapabilityId`).
 *
 * Today's bare `CapabilityId` (e.g. `mcp.github.create_issue`) is exactly the
 * `source.capability` TAIL; federation PREPENDS the location path on ascent (the
 * primary MOUNTS — applies the tenant/workload prefix per its enrollment record,
 * Invariant F / Q4), e.g. `local/laptop/mcp.github.create_issue`.
 *
 * DEPTH is a property of the GRAMMAR (variable-depth), not a fixed tuple — so a
 * deeper topology never forces an address-format migration. **v1 convention caps
 * operational depth at 1** (one workload segment) by enrollment policy, not grammar
 * (Q8 / mesh §3.2). Grants & audit bind to the ADDRESS; resolution binds
 * address→route, so health/route changes never mutate addresses.
 *
 * Represented as a string alias (like `CapabilityId` / `SourceId`) so it is a flat,
 * JSON-serializable wire value; the structured grammar is parsed where needed.
 */
export type CapabilityAddress = string;

/**
 * The upstream a `proxy` attaches to (mesh §3.1) — a VALUE OBJECT carried in the
 * gateway's boot config / enrollment frame. The `primaryPubKey` is the primary's
 * Ed25519 public key, pinned at enrollment for mutual auth (Q2). Identity ⟂
 * encryption: this is the authenticated peer key, independent of any transport
 * channel encryption underneath.
 */
export interface MeshUpstream {
  /** Where the proxy dials out to reach its primary (the tunnel endpoint). */
  url: string;
  /** The primary's Ed25519 public key, pinned at enrollment for mutual auth (Q2). */
  primaryPubKey: string;
}

/**
 * Lifecycle of a proxy's enrollment as seen at the primary (mesh §3.1):
 *  - "pending" = handshake started, not yet validated/admitted.
 *  - "active"  = admitted (valid one-time join token auto-admits, zero-exposure
 *                entry — join ≠ access; Q3). Its capabilities can cascade up.
 *  - "revoked" = the primary has withdrawn recognition (terminal).
 */
export type EnrollmentStatus = "pending" | "active" | "revoked";

/**
 * THE ENROLLMENT RECORD — the primary's durable record of a proxy join (mesh §3.1).
 * Boot-time handshake where a proxy joins a primary: mode + upstream + workload +
 * one-time join token → validated, unique under the primary (Invariant F),
 * recognized. The pinned Ed25519 proxy pubkey is the cross-tier identity (Q2); the
 * join token is stored ONLY as a hash (never the secret itself). A valid one-time
 * token auto-admits but the new workload enters ZERO-EXPOSURE (caps default hidden +
 * ungranted), so a leaked token = a visible, zero-exposure rogue workload (Q3).
 */
export interface EnrollmentRecord {
  /** The workload identity the proxy claimed — unique under this primary (Invariant F). */
  workload: WorkloadName;
  /** The proxy's Ed25519 public key, pinned at join for all subsequent tunnel auth (Q2). */
  pinnedProxyPubKey: string;
  /** Hash of the one-time join token (the raw token is never persisted). */
  joinTokenHash: string;
  /** When the proxy claimed enrollment. */
  claimedAt: IsoTimestamp;
  /** Lifecycle state at the primary. */
  status: EnrollmentStatus;
}

// ── The tunnel multiplexer's published language: the Frame union ─────────────
// A proxy DIALS OUT a single persistent, mutually-authenticated tunnel to its
// primary (NAT-forced — no inbound hole on the proxy host). Enrollment,
// catalog-push, invoke-forward, audit-bubble and keepalive all MULTIPLEX over that
// one connection (mesh §7 transport premise). Each `Frame` is one multiplexed
// message; `corr` is the correlation id that pairs a request with its reply (e.g. an
// `invoke` with its `invoke-result`) and threads the cascade for audit. This is the
// PUBLISHED LANGUAGE of the primary↔proxy boundary — distinct from, and never
// conflated with, the agent↔primary wire (two trust boundaries, mesh §7).

/** Proxy → primary: the enrollment handshake payload (claims workload + pins keys). */
export interface EnrollFramePayload {
  /** The workload identity the proxy claims (mounted by the primary on ascent, Q4). */
  workload: WorkloadName;
  /** Declared at join — `"proxy"` for a dial-out subordinate (mode ⟂ workload, Invariant A). */
  mode: GatewayMode;
  /** The proxy's Ed25519 public key to pin for mutual auth (Q2). */
  proxyPubKey: string;
  /** The one-time join token presented for admission (auto-admit, zero-exposure entry — Q3). */
  joinToken: string;
  /** Echo of the upstream the proxy dialed (the primary it is attaching to). */
  upstream?: MeshUpstream;
}

/**
 * Proxy → primary: a catalog push. The proxy advertises BARE local
 * `source.capability` entries and is workload-agnostic on the wire (Q4); the
 * primary MOUNTS them (applies tenant/workload prefix → full `CapabilityAddress`,
 * Invariant F) and mounts the travelling companion skills (Invariant G).
 */
export interface CatalogFramePayload {
  /** The publishing workload (the primary maps it to the address prefix). */
  workload: WorkloadName;
  /** Bare local entries being advertised (their `id` is the `source.capability` tail). */
  entries: CapabilityEntry[];
  /** Monotonic catalog revision for this workload (lets the primary detect staleness). */
  revision?: number;
  /** Ids withdrawn since the last push (cascaded `CapabilityWithdrawn`). */
  withdrawn?: CapabilityId[];
}

/**
 * Primary → proxy: forward an ALREADY-AUTHORIZED invoke down the tunnel (data-plane
 * passthrough, Q1). The proxy trusts any invoke arriving on the tunnel as
 * already-authorized (tunnel-trust, Invariant E) — it only applies its local
 * exposure veto + records audit; it never re-decides authorization.
 */
export interface InvokeFramePayload {
  /** The logical URN the primary resolved + authorized (audit binds to this, Invariant B). */
  address: CapabilityAddress;
  /** The BARE local capability id the proxy executes (workload-agnostic on the wire, Q4). */
  id: CapabilityId;
  /** The call arguments (plaintext — the authority already saw them to gate on content, Q1). */
  input?: unknown;
  /** Idempotency key threaded from the agent's invoke (re-dispatch suppression). */
  idempotencyKey?: string;
  /**
   * Threads the primary's edge-span (the forward) to the proxy's workload-span (the
   * execution) so both audit records share one id (mesh §3.5 CorrelationId). Generated
   * at the forward boundary; the proxy stamps it onto the audit event it records (and
   * bubbles up). Omitted ⇒ the proxy mints a local-only correlation.
   */
  correlationId?: string;
}

/** Keepalive in either direction over the persistent tunnel. */
export interface PingFramePayload {
  /** When the ping was emitted (liveness/RTT diagnostics). */
  at?: IsoTimestamp;
}

/**
 * MESH HEALTH-REPORTING (mesh-health-reporting.md). A capability a peer ADVERTISES in the
 * connection-auth handshake (`auth-init` / `auth-challenge`). Health reporting is enabled on a
 * connection ONLY when BOTH peers advertise it; the negotiated result is derived identically on
 * both ends (`version = min`, `intervalMs = max`). Absent from a peer ⇒ bare-heartbeat fallback
 * (backward compatible). See `NegotiatedHealthReporting`.
 */
export interface HealthReportingCapability {
  /** Protocol version the peer speaks (v1 today). */
  version: number;
  /** The peer's requested reporting interval (ms) — the negotiated interval is the MAX of the two. */
  intervalMs: number;
}

/** The negotiated (both-advertised) health-reporting parameters bound to a connection. */
export interface NegotiatedHealthReporting {
  version: number;
  intervalMs: number;
}

/**
 * One per-source health row inside a `health` frame. The reporter emits its LOCAL bare
 * `source` ids (workload-agnostic on the wire, like the catalog); each of a source's
 * capabilities INHERITS this one status (per-source granularity). At the primary all of a
 * workload's caps mount under one synthetic `mesh:<workload>` source, so the rows are retained
 * for admin detail while the mounted-cap health resolves from `overall`.
 */
export interface HealthReportSource {
  /** The reporter's LOCAL source id (bare, e.g. `filesystem` / `mcp.github`). */
  source: SourceId;
  /** The source's health status (caps inherit it). */
  status: HealthStatus;
  /** Human-readable reason (e.g. the source's `health()`/`checkRequirements` detail). */
  detail?: string;
  /** When the reporter probed this source (its cache stamp). */
  checkedAt?: IsoTimestamp;
}

/**
 * The `health` frame payload (bidirectional, mesh-health-reporting.md §3). Proxy→primary
 * reports the proxy's aggregated local source health; primary→proxy reports the primary's
 * liveness/health (cascade). ANTI-FORGERY: the primary attributes a report to the
 * AUTHENTICATED workload of the socket it arrived on — `reporter` is advisory and NEVER trusted
 * (same discipline as catalog mounting under `authenticatedWorkload`).
 */
export interface HealthFramePayload {
  /** ADVISORY self-label (`"primary"` or the reporter's workload). NEVER trusted for attribution. */
  reporter: WorkloadName | "primary";
  /** Aggregate: `ok` (all sources healthy), `degraded` (≥1 impaired), `down` (≥1 unavailable). */
  overall: "ok" | "degraded" | "down";
  /** Per-source rows (caps inherit their source's status). */
  sources: HealthReportSource[];
  /** Monotonic sequence per reporter — the receiver drops an out-of-order (stale) report. */
  seq: number;
  /** When the reporter built this snapshot. */
  ts: IsoTimestamp;
}

/** `enroll` — proxy → primary join handshake. */
export interface EnrollFrame {
  t: "enroll";
  corr: string;
  payload: EnrollFramePayload;
}
/** `catalog` — proxy → primary capability publish/withdraw (cascades up). */
export interface CatalogFrame {
  t: "catalog";
  corr: string;
  payload: CatalogFramePayload;
}
/** `invoke` — primary → proxy forward of an already-authorized invoke. */
export interface InvokeFrame {
  t: "invoke";
  corr: string;
  payload: InvokeFramePayload;
}
/**
 * `invoke-result` — proxy → primary, the outcome of an `invoke` frame. Reuses the
 * agent-facing `InvokeResponse` shape verbatim (including a typed
 * `capability_unavailable` error per Invariant E); `corr` pairs it with its `invoke`.
 */
export interface InvokeResultFrame {
  t: "invoke-result";
  corr: string;
  payload: InvokeResponse;
}
/**
 * `audit` — proxy → primary best-effort audit bubble-up (Invariant D, never blocks
 * the hot path). Carries the proxy-local `AuditEvent` (already redacted by the same
 * redactor both tiers run); the primary stores a redacted mirror (Q7).
 */
export interface AuditFrame {
  t: "audit";
  corr: string;
  payload: AuditEvent;
}
/** `ping` — bidirectional keepalive over the dialed tunnel. */
export interface PingFrame {
  t: "ping";
  corr: string;
  payload: PingFramePayload;
}
/**
 * `health` — bidirectional health report over the dialed tunnel (mesh-health-reporting.md).
 * Negotiated at the handshake; when active it doubles as the liveness signal (subsuming the
 * bare `ping`). The primary attributes it to the AUTHENTICATED workload of the socket (never
 * `payload.reporter`).
 */
export interface HealthFrame {
  t: "health";
  corr: string;
  payload: HealthFramePayload;
}

/**
 * THE MESH FRAME UNION — every message multiplexed over the proxy↔primary tunnel,
 * discriminated by `t`. The published language of the tunnel multiplexer.
 */
export type Frame =
  | EnrollFrame
  | CatalogFrame
  | InvokeFrame
  | InvokeResultFrame
  | AuditFrame
  | PingFrame
  | HealthFrame;

/**
 * ATTRIBUTION — the who/why behind an audit event (mesh §1 / §3.5). A value object
 * that generalizes the single gateway's `agentId`-only "who" into a federation- and
 * enterprise-ready shape. Referenced (optionally) from `AuditEventInput.attribution`.
 */
export interface Attribution {
  /** WHO acted — the agent identity (the token `sub`). */
  agent: string;
  /** On WHOSE BEHALF — the human/service-account the agent acts for (enterprise). */
  principal?: string;
  /** WHY (authorization) — the `StandingGrant` id that authorized this. */
  grantRef?: string;
  /** WHY (policy) — the policy rule id, when the decision was policy-evaluated (enterprise). */
  policyRef?: string;
}
