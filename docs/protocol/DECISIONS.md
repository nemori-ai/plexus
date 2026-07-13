# Plexus M0 — Design Decisions (ADRs)

> Date: 2026-06-24 (ADR-020/021 added 2026-07-06; ADR-022/023 added 2026-07-08; ADR-024 added 2026-07-10; ADR-025 added 2026-07-13) ·
> **Status: M0 contract v0.1.3** (v0.1.0 + ADR-017 `/invoke` single-shape refinement +
> ADR-018 unified trust model + ADR-019 enrollment/PAT self-description reconciliation +
> ADR-020 authorization-extensibility seams + ADR-021 source settings / exec wire-audit
> split / call-once-and-wait + ADR-022 cc-master removal + ADR-023 authorized-subset model
> (agent sees only its granted subset; `.well-known` catalog strip amends ADR-008; execute
> standing-opt-in relaxes ADR-5), additive) · Scope: the M0 protocol & architecture contract.
> Each ADR records a decision, the rationale, and what it **forecloses**. This
> revision applies the adversarial-review fixes (findings #1–#10 + secondary) and
> the two locked user decisions (Authorizer seam, 15-min token + refresh). The
> formerly-open forks are now decided (see **RESOLVED IN THE FREEZE**); the
> **OPEN / DEFERRED POST-v1** section holds only genuinely post-v1 items, none of
> which block the freeze.

Already locked upstream (not relitigated): **ADR-001 MCP = superset/collector,
Option A built the Option-C way** (MCP is the privileged `mcp` ingestion
transport, schemas verbatim, additive layer above the wire, façade as a later
optional output); **ADR-002 name stays "Plexus"** through v1; **stack** = Bun +
TS + Hono, macOS first, reuse pneuma `path-resolver`.

---

## ADR-003 — Transport set: `local-rest | stdio | ipc | mcp | cli` (+ 2 sentinels)

**Decision.** First batch exactly as kickoff §9.3, with `mcp` privileged. Add two
non-wire sentinels `skill` and `workflow` so the `transport` field is total over
all entry kinds (a skill/workflow is still "reached", just not over a wire).
Transports implement a single `Transport.dispatch()` interface; the registry maps
`kind → impl`. Adding a transport = implement + register.

**Rationale.** Covers the realistic local surface: HTTP localhost APIs
(local-rest), generic subprocess protocols (stdio), OS IPC (ipc), MCP servers
(mcp), and plain binaries (cli). Sentinels keep the type total and avoid an
`Option<transport>`.

**Forecloses.** WebSocket-as-its-own-transport (folded into local-rest/ipc for
now); a pluggable third-party transport registry at runtime (transports are
compile-time registered in M0).

## ADR-004 — Unified self-describe model: one `CapabilityEntry`, `kind` discriminator

**Decision.** capability / skill / workflow are ONE type discriminated by `kind`,
not three parallel schemas. Kind-specific fields are optional (`members` for
workflow, `body` for skill, `mcp` for mcp-transport). `CapabilityEntry` is
canonical; `SelfDescribeEntry` is an alias.

**Rationale.** The agent gets ONE discovery loop, ONE grant surface, ONE
invocation path. Isomorphism is the whole point — "customization is extension,
extension is auto-discovered." A first-party adapter, an ingested MCP tool, and a
user extension must be indistinguishable in shape.

**Forecloses.** Per-kind endpoints / per-kind token types. A heavily polymorphic
entry would have been more "correct" OO-wise but breaks the uniform-discovery
promise.

## ADR-005 — Per-capability scoped grants (the thing MCP can't express)

**Decision.** Grant unit = `(agentId, capabilityId, verbs)`. Verbs =
`read | write | execute`. Default-deny, default-read-only (bare `"allow"` →
`["read"]`). This is precisely the gap over MCP's whole-server-audience auth.

**Rationale.** The user's core knob is "agent X may call tool Y under scope Z."
Per-capability + per-verb is the minimum that delivers it. `execute` is split out
from `write` because launching an orchestration (cc-master) is a different risk
class than a data write.

**Forecloses.** Resource-instance-level scoping (e.g. "only vault A, only path
B") in M0 — that lives in `input` validation / extension config, not the grant
verb set. Can be added later as a `constraints` field without breaking the verb
model.

## ADR-006 — Scoped-token = signed JWT (HS256) + server-side revocation registry

**Decision.** Hybrid: **signed JWT** body (stateless verify, self-contained
`scopes`) **plus** a server-side `jti` revocation registry (revoke before `exp`).
Short default lifetime (15 min); grants persist in the grant store, tokens are
cheap regenerable views.

**Rationale.** Pure opaque + DB lookup adds a round-trip and a store read per
invoke for a local single-process gateway — unnecessary. Pure stateless JWT can't
be revoked before expiry — unacceptable for a local agent gateway where "revoke
now" is a primary user action. The hybrid gets stateless verify AND instant
revoke; the registry is a small in-memory set persisted to `~/.plexus/`.

**Forecloses.** Long-lived bearer tokens (lifetime is deliberately short).
Asymmetric (RS256) signing — overkill for a single local issuer-verifier; HS256
with a per-install secret is simpler. Revisit RS256 only if the MCP-server façade
ever issues tokens consumed by a separate verifier.

## ADR-007 (REVISED) — Grant authorization is a PLUGGABLE SEAM; v1 ships a stub

**Decision.** The authorize decision is a **pluggable abstraction**, the
`Authorizer` interface (`types.ts` §4a): input = grant request + `AuthorizationContext`,
output = `allow | deny | pending`. The gateway calls it per requested grant and
drives `PUT /grants` accordingly (mint token / `grant_pending_user` / deny). **v1
ships a SIMPLE STUB** — `AutoApproveAuthorizer` (permissive: returns `allow` for
the entry's requested verbs). The `grant_pending_user` path + `GET /grants/status`
poll channel stay fully in the type surface so a stricter policy (e.g. a
`UserConfirmAuthorizer` that returns `pending` until the user confirms in the
management client) is a **drop-in replacement with no wire change**.

**Rationale (revised per locked user decision).** A full confirm-every-grant UI is
NOT a v1 requirement; over-designing it would block the demo. What matters is the
SEAM: the authority model must be swappable without touching the protocol. A
trivial auto-approve default is acceptable for v1; the architecture preserves the
space to harden later. This supersedes the earlier "user-confirms-every-grant by
default" stance.

**Forecloses.** Baking a specific authorization UX into the wire. Any policy —
permissive, confirm-every-grant, trusted-agent-with-pre-approved-scopes — plugs in
behind `Authorizer`.

## ADR-010 — Revocation endpoint + in-flight workflow revocation (review #3)

**Decision.** Add `POST /grants/revoke` with `RevokeRequest`/`RevokeResponse`.
Two selector forms: by `jti` (one token) or by `(agentId, capabilityId)` (all
tokens carrying that scope + remove the persisted grant so refresh can't re-mint).
**Workflow rule:** the orchestrator re-checks the originating `jti`'s revocation
state **before EACH member dispatch**, so a mid-fan-out revoke halts the remaining
members.

**Rationale.** The spec always promised revoke-by-jti / revoke-by-scope and the
audit model had `grant.revoke`/`token.revoke`, but no endpoint/type existed — a
freeze blocker. Per-member re-check closes the "which token does a seconds-long
fan-out check?" gap.

**Forecloses.** Revoking an already-completed member call (revocation is
forward-only; completed dispatches are audited, not undone).

## ADR-011 — Grant-backed token refresh (review #4; required by 15-min lifetime)

**Decision.** Add `POST /grants/refresh` (`RefreshRequest`/`RefreshResponse`). It
re-mints a new 15-min token with the SAME scopes from the **persisted grant** —
**no connection-key, no re-prompt** — bounded by the grant's own validity
(`grantExpiresAt`). The agent presents the expiring token + session; the gateway
verifies session liveness + grant validity + non-revocation, then issues a fresh
jti (old jti revoked).

**Rationale.** Token lifetime is **locked at 15 min** (ADR-006, user-confirmed),
but the flagship cc-master workflow runs **>24h**. Without refresh its token dies
in 15 min and can only be re-minted via a full handshake needing a connection-key
the agent should not retain. Refresh keeps tokens short-lived AND long tasks alive.

**Forecloses.** Indefinite token life (refresh is hard-capped by grant validity).
Connection-key retention by the agent.

## ADR-012 — Workflow transitive grants (review #5)

**Decision.** `members` is now `WorkflowMember[]` (`{id, verbs}`); each id MUST be a
present registry entry. Granting a workflow synthesizes an internal **transitive
scope** (`TransitiveGrant`) — the member scopes are stamped into the issued token
(flagged `synthesizedFor`) and **surfaced to the user at grant-confirm time**.
Member dispatch is scope-checked through the same pipeline (no silent escalation).

**Rationale.** A token scoped to the workflow id alone would either leave members
unchecked (silent escalation, breaking ADR-005/007) or require an untyped implicit
expansion. Making the transitive scope explicit + user-visible preserves the
per-capability authority model end-to-end.

**Forecloses.** Workflows whose members are not real registry entries (cc-master's
`scan()` must produce the workflow AND its members — see ADR-009 amendment).

## ADR-013 — Workflow = a transport that re-enters the invoke pipeline (review #6)

**Decision.** Add a `WorkflowTransport` whose `dispatch` **re-enters the uniform
invoke pipeline** per member via `BridgeDeps.invokeById` / `TransportDispatchContext`.
The gateway core NEVER branches on `kind:"workflow"`; the orchestrator is "just
another transport." (Chosen over modeling the orchestrator as a first-party
`CapabilitySource` — the transport-re-entry option keeps members flowing through
the exact same scope-check + audit path as any invoke, which is the property we
most need.)

**Rationale.** The draft forced `if (kind === "workflow") runOrchestrator else
bridge.invoke` — the precise branch the black-box architecture forbids. Re-entry
makes fan-out uniform: each member is a normal scope-checked, audited invoke.

**Forecloses.** A bespoke orchestrator code path in the core. Fan-out that bypasses
grant enforcement.

## ADR-014 — Manifest refresh + event stream + pending-grant channel (review #9)

**Decision.** Add `GET /manifest` (pull a fresh snapshot, no re-handshake), a
`GET /events` SSE stream (`PlexusEvent`: `manifest_changed` / `grant_resolved` /
`token_revoked` / `source_status`), and `GET /grants/status` (poll a
`grant_pending_user` decision). `Manifest.revision` is a monotonic counter agents
compare to detect staleness.

**Rationale.** The handshake manifest was a one-shot snapshot with no push channel,
so an MCP `list_changed` (or Obsidian coming online post-handshake) left the agent
stale; and `grant_pending_user` dead-ended with no resolution channel. These close
both lifecycle gaps — collectively a blocker for both flows.

**Forecloses.** Full re-handshake as the only way to refresh a view.

## ADR-015 — Closed `ErrorCode` union (review #10)

**Decision.** `ErrorResponse.code` / `InvokeResponse.error.code` use a **closed**
`ErrorCode` union (`token_expired`, `token_revoked`, `grant_required`,
`grant_pending_user`, `session_expired`, `unknown_capability`,
`schema_validation_failed`, `source_unavailable`, `mcp_tool_error`,
`transport_error`, `host_forbidden`, `rate_limited`, `internal_error`). Frozen at
v0.1.0.

**Rationale.** An open `string` code can't be branched on reliably — the agent
can't tell "refresh" from "re-grant" from "give up." A closed union makes recovery
deterministic. MCP in-band `isError:true` maps to `ok:false` + `mcp_tool_error`
with `content[]` preserved verbatim.

**Forecloses.** Ad-hoc per-endpoint codes. New codes require a contract bump.

## ADR-016 — Host/Origin defense + advertised endpoint namespace (review #7, #nit)

**Decision.** Every endpoint enforces `Host` == the bound loopback authority
(`127.0.0.1:<port>`) and validates `Origin` (`HostOriginPolicy`) BEFORE auth —
the standard MCP-local DNS-rebinding mitigation; failures return `host_forbidden`.
`.well-known` exposes only summaries (ADR-008), accepting a version/inventory
fingerprint as the cost of pre-session discovery. All endpoint URLs (invoke,
revoke, refresh, grant-status, manifest, events) are **advertised** in
`AuthAdvertisement`; the agent reads URLs rather than hard-coding paths
(`/grants/*` namespace convention).

**Rationale.** Loopback bind alone stops neither other local processes nor a
DNS-rebinding browser POSTing to `/invoke`. Host/Origin validation is the cheap,
standard defense. Advertising URLs removes the hard-coded `/invoke` assumption.

**Forecloses.** Binding to `0.0.0.0`; trusting any localhost caller without a
host check.

## ADR-017 — `/invoke` returns ONE result shape for all outcomes (tp2, v0.1.1)

**Decision.** `POST /invoke` ALWAYS returns an **`InvokeResponse`-shaped** body —
`{ id, ok, … }` on success and `{ id, ok:false, error:{code,message,capabilityId?},
auditId }` on **every** denial, including auth/pre-dispatch ones (no token,
`grant_required`, `token_revoked`/`token_expired`, `session_expired`,
`unknown_capability`, `schema_validation_failed`). The closed `ErrorCode` and the
per-denial **HTTP status** (401 auth · 404 unknown · 422 schema · 403 host · 429
rate · 503 source · 200 in-band dispatch error · 400 otherwise) are unchanged; only
the surrounding body changes. `auditId` is the audited-denial's event id (every
pipeline pre-dispatch denial is audited) or the empty-string sentinel `""` for an
EDGE denial that fails before the pipeline audits. **Scope: `/invoke` ONLY** — every
other endpoint keeps the uniform `ErrorResponse` envelope.

**Rationale.** v0.1.0 returned TWO shapes on `/invoke`: a transport/capability
failure as an in-band `InvokeResponse{ok:false}` at HTTP 200, but an auth/pre-dispatch
denial as the `ErrorResponse` envelope (`{error:{…}}`, 4xx) with no `id`/`ok`/
`auditId`. A naive agent deserializing every `/invoke` reply as `InvokeResponse` got
`ok === undefined` on denial (the agent-harness consumer, t12). Collapsing the denial
path to the same shape `/invoke` already uses for success gives the agent ONE result
contract on its hottest endpoint, with no loss — the HTTP status still classifies the
failure and `error.code` is the same closed union.

**Non-breaking.** No new `ErrorCode`s; statuses unchanged; `error` already existed on
`InvokeResponse` and `auditId` stays a required `string` (the `""` sentinel preserves
the field's presence for edge denials). Versioned `0.1.0 → 0.1.1`.

**Forecloses.** A second result framing on `/invoke`; clients normalizing an
`ErrorResponse` envelope back to `{ok,error}` (the min-agent client's old hack, now
removed).

## ADR-018 — Unified trust model: named primitives, two clocks, 3-class provenance (v0.1.2)

**Decision.** The grant machinery was correct but *invisible* and *un-named*, so it
read differently on every surface. v0.1.2 **names** the primitives and **surfaces**
them so a human (UI), an agent (protocol), and a developer (API) read the SAME facts.
All changes are ADDITIVE under the frozen wire — new optional fields and one new
endpoint; a `v0.1.1` client ignores them.

- **Named primitives (one word each, used verbatim everywhere):** **agent** (the
  self-asserted label a grant is *scoped* to, `agentId` = handshake `client.agentId`
  — see "Trust boundary & agentId" below: it is NOT an authentication boundary),
  **capability**, **scope** (one `capability × verbs` token line), **grant** (the
  standing, human-approved `(agentId, capabilityId, verbs)`), **trust-window** (how
  long the grant stands before re-asking), **token** (a ~15-min auto-refreshed view
  of the grant), **provenance / source-class**, **sensitivity**.

- **Two clocks (both configurable in `~/.plexus/auth-config.json`):**
  **token-lifetime** (~15 min — the blast radius of a leaked credential; clamped to
  `[1min, 60min]`, never per-approval, never agent-choosable — a security invariant)
  vs **trust-window** (how long the human's *decision* stands before Plexus re-asks).
  Naming both, side by side, is the legibility win: refresh re-mints up to the
  trust-window ceiling without re-approval, and now the ceiling is shown.

- **3-class provenance + posture:** `first-party` (reserved/in-process), `managed`
  (a source the user ADDED through the trusted admin UI, human-vetted at add-time —
  **shares the first-party READ posture**; write/exec still pends), `extension`
  (wire-registered by an agent — strictest, ANY verb pends). first-party + managed
  **reads auto-allow**; all **write/exec pend**; **extension reads pend** too. A
  standing, unexpired grant short-circuits the re-ask.

- **"once" single-use semantics:** a `once` grant persists with `standing:false` and
  `expiresAt = grantedAt`, so refresh cannot re-mint it and `hasPriorApproval` must
  NOT short-circuit on it. "Once" means once.

- **anon = session-only, no standing trust:** never persist a standing (> session)
  grant under an `anon:*` id (capped at `once`); surface it as "Anonymous (re-asks
  every session)". A stable `agentId` is what gives a returning agent something durable
  to stand on (Plexus remembers its standing grants) — without one, every session
  re-asks. This is a scoping convenience, NOT a security boundary (next paragraph).

- **Trust boundary & agentId (the honest model).** On Plexus's loopback, single-user
  design **the connection-key IS the trust boundary**. `agentId` is a SELF-ASSERTED,
  unforgeable-by-design label, copied verbatim from `client.agentId` at handshake with
  no verification. Its ONLY job is to **scope** which standing grants apply (a UX
  convenience so a returning agent isn't re-prompted) — it is **NOT authentication and
  confers NO isolation** between mutually-distrusting local processes. Any process
  holding the connection-key can handshake as any `agentId` and ride that id's standing
  grants; this is intended under this model. **Rotating the connection-key is how you
  revoke broadly** (it invalidates every session bootstrapped under the old key). True
  per-agent **cryptographic** identity (an agentId only its issued principal can claim)
  is explicitly **POST-v1**. Operators should therefore treat a per-agent standing
  grant as "any local key-holder may use this", not "only this agent may".

- **Admin "Grant access" targets a REAL `agentId`** (retire `plexus-admin` as a grant
  *subject*): the admin approve/grant path persists under the intended real agent
  (picker default `plexus-cli`) so the agent's next request hits `hasPriorApproval`.
  `plexus-admin` stays ONLY for the management session's own mechanical calls. (Fixes
  the "decoy grant" that pre-authorized no real agent.)

- **Agent trust-window is advisory-only:** `GrantDecision.trustWindow` on the agent
  (`PUT /grants`) path may be SHORTENED by the authorizer/human, never lengthened past
  the per-class ceiling; on the admin approve path it is authoritative. An agent can
  never self-extend its standing trust.

- **Gateway-authored narration:** the gateway authors the one-line
  `PendingNarration.summary` per pending capability so narration can't drift across
  agents; the skill REQUIRES the agent to state capability + verbs + trust-window +
  revocability, and to never say "one-time" unless the window is actually `once`.

- **New endpoint `GET /grants`** (session-authenticated, like `/manifest`) →
  `GrantsListResponse` — the agent's symmetrical view of the user's Grants screen;
  advertised via `AuthAdvertisement.grantsListUrl`. Admin uses `GET /admin/api/grants`.

- **Additive fields:** `provenance` / `sensitivity` / `recommendedTrustWindow` on
  `CapabilityEntry` + `CapabilitySummary`; `trustWindow` on `GrantDecision`;
  `pendingNarration[]` on `GrantPendingResponse` + `GrantStatusResponse`;
  `grantExpiresAt` / `trustWindow` on `ScopedToken`; `gexp` on `ScopedTokenClaims`;
  `grantsListUrl` on `AuthAdvertisement`.

**The four user-ratified defaults.**
1. **Contextual, 3-class default trust-windows:** first-party/managed read **7d**,
   write/exec **1d**; extension read **1d**, write/exec **once**.
2. **Keep auto-allowing first-party + managed reads** (low friction) — but they MUST
   appear in the Grants ledger with their trust-window; nothing is silent.
3. **3-class provenance** (`first-party` / `managed` / `extension`).
4. **Offer `until-revoked` but NEVER default it;** custom durations capped at
   `maxTrustWindowMs` = **30 days**.

**Sensitivity derivation** (gateway-computed so all surfaces agree): `low` = read on
first-party/managed; `elevated` = write/exec on first-party/managed OR read on
extension; `high` = write/exec on extension OR any cli/local-rest transport with
write/exec. Workflows roll up members' sensitivity (max wins).

**Non-breaking.** Every change is a new optional field or a new endpoint; no frozen
wire type changed; no new `ErrorCode`; the 15-min token contract is unchanged.
Versioned `0.1.1 → 0.1.2`.

**Forecloses.** A silent (un-listed) standing grant; an agent self-extending its
trust-window; `plexus-admin` as a grant subject; narration that calls a multi-day
grant "one-time"; per-approval token lifetimes.

## ADR-019 — Enrollment/PAT is the AGENT handshake; connection-key is admin-only (v0.1.3)

**Decision.** The runtime already shipped the two-credential auth model — an agent
authenticates with its **own durable per-agent PAT** (`plx_agent_…`), redeemed once
from a one-time **enrollment code** (`plx_enroll_…`); the **connection-key** is the
**admin/management** credential and agents never hold it (agent-skill-compile
**ADR-4** bearer PAT, **ADR-9** enrollment self-description). But the machine-readable
Floor self-description (`GET /.well-known/plexus`) still told a cold agent to handshake
with the OLD **connection-key-in-body** shape — the ADMIN path — and `requestShapes`
is the ONE surface a skill-LESS cold agent relies on (Inv II). This ADR reconciles the
self-description to the code: `requestShapes.handshake` now describes the AGENT path
(`Authorization: Bearer <PAT>`, no body) via a new optional `RequestShapeHint.headers`,
and `connectionKeyDelivery` is documented as the ADMIN/owner connection-key delivery,
never an agent affordance. It also reaffirms **ADR-5**: an `execute` capability can
**never** be standing (`once` ceiling), even under an admin trust window — unchanged.

**Non-breaking.** Additive (a new optional `headers` field on `RequestShapeHint`) plus
a corrective doc/shape fix to a now-false agent-facing hint. No frozen wire type is
removed or retyped; the connection-key-in-body handshake stays the documented ADMIN
path (the endpoint code already accepted both — Bearer PAT ⇒ agent, `connectionKey`
body ⇒ admin — this only aligns the DESCRIPTION to that behavior). Versioned
`0.1.2 → 0.1.3` (the version never moved when the enrollment/PAT surfaces shipped;
this bump also carries that reconciliation). The ADR-log home moved from
`docs/archive/protocol/DECISIONS.md` to `docs/protocol/DECISIONS.md`.

**Supersedes.** The agent-facing reading of the two-tier disclosure in **ADR-008** and
**ADR-018** where `.well-known` presented the connection-key-in-body handshake as the
agent path — that hint is now ADMIN-only. Everything else in ADR-008/ADR-018 stands.

**Forecloses.** Advertising the connection-key (or any admin-only credential) as an
agent handshake affordance; a skill-less cold agent being steered onto the admin path.

## ADR-020 — Authorization-extensibility seams locked for 1.0 (ticket vs badge)

**Decision.** 1.0 ships the **badge** (per-agent PAT identity) in full and the **ticket**
(task-scoped consent) as the existing task bundle — a *proto-ticket* with no lifecycle
object. Instead of building the ticket now, 1.0 **locks the seams it will be assembled
from**, as verifiable guarantees (the full treatment is
[`docs/design/authz-extensibility.md`](../design/authz-extensibility.md)):

1. **Audit linkage outlives grant rows.** Grant records are deleted on revoke (by
   design); therefore every grant-lifecycle audit event (`grant.pending`, `grant.allow` —
   including bare in-scope re-mints — and every `grant.revoke` path) carries the member's
   `bundleId`, stamped **before** row removal. The task story is replayable from the
   audit log alone, within audit retention (default 90d).
2. **Enterprise attribution fields are reserved.** `Attribution.principal` / `grantRef` /
   `policyRef` exist on the audit shape, all optional; 1.0 neither sets nor reads them.
3. **Trust windows extend additively.** `TrustWindowKind` is a closed union with one
   expiry choke point (`resolveWindowExpiry`); a future `until-task-closed` kind is an
   additive minor bump, not a migration.
4. **Policy is a seam.** The `Authorizer` interface (ADR-007) is where a ticket/policy
   engine slots in, reporting via `policyRef` — zero wire change.
5. **A ticket never widens authority.** A bundle (and any future ticket) is grouped
   ordinary grants — no fourth authority class beside grant, token, and exposure;
   effective access stays granted ∧ exposed.

**Deliberately undecided:** execute-inside-a-ticket. The `execute → once` ceiling
(ADR-5/ADR-018) stands unmodified in 1.0. Any future relaxation must (a) keep
standing-eligibility a property of capability sensitivity, never a ticket/admin/agent
choice; (b) be opt-in per capability; (c) never outlive the ticket's own bounded window.

**Non-breaking.** Additive only: new optional keys inside audit `detail`
(`bundleId`/`bundleName`/`bundleIds`) — `detail` is already `Record<string, unknown>`.
No wire type changes; protocol stays `0.1.3`.

**Forecloses.** Building a ticket that requires migrating or resurrecting deleted grant
rows (the audit log is the durable join surface); a ticket/bundle mechanism that mints
authority beyond its member grants; lifting the execute ceiling as a side effect of any
future ticket work.

## ADR-021 — Machine-level source settings + the exec wire/audit split + call-once-and-wait

**Decision.** Three related corrections shipped together after live dogfooding of the
personal-gateway scenario:

1. **Machine-level source settings.** First-party sources gain owner-managed, persisted
   machine knobs (`~/.plexus/source-settings.json`; GET/PUT `/admin/api/source-settings`,
   connection-key gated). v1 ships ONE knob: **`realLaunch`** on the exec trio
   (codex / claudecode / cc-master) — whether an *approved* execute call actually spawns
   the tool (spending the owner's model quota) or performs the honest record-mode
   dry-run. The persisted setting wins over the legacy env flags (which remain as
   recipe/test fallbacks); absent both ⇒ OFF. Every flip is **audited** (new additive
   event type `source.settings`) because it changes what "approve" does. Machine
   capability is the RESOURCE side's static asset decision — a second axis that
   *composes with* per-call grant approval, never a substitute for it.
2. **The exec wire/audit split.** `codex.run` / `claudecode.run` results return the
   calling agent the minimal honest set (`ok`, `launched`, `sandboxed`, `output`
   verbatim, `exitCode`); the confinement diagnostics (absolute jail path, home dir,
   tool install path/version, sandbox argv with the prompt masked) move to the owner's
   audit `detail`. A jail-root behavior contract (`AGENTS.md`/`CLAUDE.md`,
   write-if-absent — the owner's file wins) additionally steers the spawned tool to not
   volunteer machine details (advisory: tool stdout is never rewritten).
3. **Call-once-and-wait is the sanctioned client behavior.** On `grant_pending_user`
   the CLI engine now blocks on the advertised `statusUrl` and invokes with the token
   the approval minted (`--no-wait` / `PLEXUS_APPROVAL_WAIT_MS` opt out). Exiting with
   a "re-run" hint could never work for an execute capability — execute never stands,
   so a re-run just re-pends and nothing ever consumes the minted token.

**Non-breaking-ish.** (1) and (3) are additive (new files/endpoints/flags; one additive
audit-type union member). (2) deliberately **narrows** the exec output shape — a
consumer reading `jail`/`argv`/`confinement` off the wire loses them (they were an
information-disclosure bug, not a contract; the `io.output` schemas are corrected in the
same change). Protocol stays `0.1.3`.

**Forecloses.** Handing machine fingerprints to agents as a side effect of invocation;
treating env flags as the only launch control; client retry-loops as the answer to
pending approvals. Deferred (KNOWN-LIMITATIONS): the same wire/audit split for
`cc-master.*` dispatch results; the `codex.plan` / `codex.run` capability split;
approval narration that states the current real-launch mode.

## ADR-022 — cc-master source removed wholesale; workflow mechanism stays

**Decision.** The `cc-master` first-party source — the Claude Code orchestration
(board/dispatch/orchestration/session-launch) surface, its embedded vendored plugin,
its admin launch-profile config (`loadCcMaster`), detector, and examples — is
**removed entirely**, with no compatibility layer. The protocol-level mechanisms it
exercised are **kept unchanged**: the `workflow` capability kind, `transport:"workflow"`,
and transitive authorization (`synthesizedFor`, ADR-012) remain part of the frozen
contract (worked example now [`examples/orchestrator.pipeline.run.json`](./examples/orchestrator.pipeline.run.json)).
The sandboxed `claudecode` source (`claudecode.run`, execute) is the **only** path by
which Plexus exposes Claude Code. Its id leaves `RESERVED_SOURCE_IDS` with the module
(the set's semantic is "first-party sources that exist", derived from `MODULES`);
historical ADR text mentioning cc-master is preserved verbatim above and below.

## ADR-023 — The authorized subset: an agent's world IS what the owner granted it

**Decision.** The owner declares, at connect, the exact capability **subset** one agent
may reach, and that selection IS the agent's world. Blueprint:
[`docs/design/agent-authorized-subset.md`](../design/agent-authorized-subset.md). Four
enforcement points, each keyed on a new per-agent `AgentSubsetStore`
(`~/.plexus/agent-subsets.json`, `core/agent-subset.ts`):

1. **Connect declares the subset.** `POST /admin/api/agents/connect` persists the selected
   caps as the agent's authorized subset (read/write → standing grants; execute → per-use).
   A per-capability owner `default-grant` flag (`core/default-grant.ts`) pre-checks the
   sensible defaults in the connect wizard — a UI default only, never a runtime grant.
2. **Discovery is scoped.** `buildManifest` scopes a connected agent's manifest to
   `subset ∩ exposed` — it discovers only "the capabilities Plexus authorized you to
   access," never the catalog. A read-as-context skill rides along iff attached to an
   authorized capability.
3. **Out-of-subset grants are DENIED, not pended** (`grant-service.ts`). An agent's
   `PUT /grants` for a capability outside its subset is denied — no owner card, no
   auto-grant. This **retires** the `confirm-risky` "auto-allow any first-party read on
   request" as the agent-facing default: reads are frictionless because the owner granted
   them standing at connect, not because a request auto-approves. (The auto-allow path
   stays only for legacy un-scoped agents.)
4. **`.well-known` stops advertising the catalog** (amends **ADR-008**). The public
   `GET /.well-known/plexus` carries the gateway identity + lifecycle endpoints + a
   `capabilitiesVia` pointer only — no capability summaries. The catalog is delivered
   post-handshake (the manifest). Closes pre-identity enumeration. The internal "Floor"
   the plugin compiler builds server-side still carries summaries (`buildWellKnown`).

**`execute → once` becomes DEFAULT-with-owner-override** (relaxes **ADR-5**, which
ADR-019/ADR-020 had reaffirmed as absolute). Execute stays per-use by default; the owner
may opt a *specific* execute capability into a **standing** grant for a *specific* agent —
**default-off + double-confirm** at connect (`agentSubsets.isStandingExecute`, honored in
`chooseTrustWindow`). Coherent because the default floor is unchanged (a naïve owner never
gets standing execute; an agent can never self-elevate) and it stays *opt-in per capability,
never a blanket power* — exactly the constraint ADR-020 fixed. Downstream docs
(`README`, `concepts`, `security`, `architecture`, `authz-extensibility`) are updated to
"per-use by default; owner may opt into standing (default-off, double-confirm)."

**Forecloses.** An agent learning Plexus has more than its subset; silent read
self-acquisition via bulk `PUT /grants`; see-but-can't-use manifest noise; pre-identity
catalog enumeration; and standing execute arising from anything other than a deliberate,
warned, per-agent owner action. **Migration** is opt-in: an agent with no subset record is
un-scoped (legacy behavior preserved) until the owner re-connects it.

## ADR-024 — Things 3 source removed wholesale; personal-data roster is the first-party spine

**Decision.** The `things` first-party source (Things 3 — AppleScript read +
URL-scheme write) is **removed entirely**, with no compatibility layer, following the
ADR-022 (cc-master) removal shape: its module directory, `MODULES` registration,
exports, tests, and every doc/demo appearance go together. Its id leaves
`RESERVED_SOURCE_IDS` with the module (the set derives from `MODULES`). Scenario and
demo roles it played (the pend-a-write story in the acceptance harness and the site
realtime demo) are recast onto `apple-notes.notes.create` — the write-pend narrative
is unchanged, only the actor. **Why.** The 2026-07-10 first-party batch pinned the
selection north star to *personal data + desktop-native software with no cloud-API
equivalent*, and the shipped roster (apple-calendar / reminders / notes / mail /
contacts / photos, shortcuts, browser, workspace, sysinfo, claudecode, codex) covers
that spine first-party; a third-party task manager's to-do surface no longer earns a
compiled-in seat and can return as a runtime extension or managed connector if wanted.
**Forecloses.** Nothing protocol-level: no mechanism was unique to `things` (AppleScript
read and URL-scheme write both have other first-party exemplars).

## ADR-025 — Side-effecting capabilities are per-use at connect; standing requires explicit per-capability owner opt-in

**Decision.** The connect-time bulk grant (`POST /admin/api/agents/connect`) applies the
global trust window to **read** legs only. A selected side-effecting capability
(**write** or **execute**) enters the agent's authorized subset **without** a standing
grant — each use pends for the owner — and is reported under `skipped` (the truthful
contract). Standing at connect requires the per-capability owner opt-in, generalizing
**ADR-023**'s execute opt-in to any side-effecting capability: the wire field is
`standing` (`standingExecute` accepted as a legacy alias; `GET /admin/api/agents/:id/subset`
echoes both), the store method is `agentSubsets.isStanding` (persisted files' old
`standingExecute` key is read compatibly), and the default-off + confirm posture is
unchanged. The owner's **per-capability acts still win** everywhere else: approving a
write's pending request with a real window, or a direct `PUT /admin/api/grants` naming
it, creates a standing write exactly as before. Blueprint:
[`docs/design/agent-authorized-subset.md`](../design/agent-authorized-subset.md) §4.1.

**Why.** The ADR-023 shape let a write ride the connect wizard's *global* window into a
standing grant — exactly the "unconscious standing" trap the execute opt-in closes: an
owner picks "7d" thinking of the reads, and every selected write silently becomes
frictionless. One rule now covers every side effect: **without deliberate
per-capability owner config, each side-effecting use is approved by the owner
individually; explicit owner config wins.**

**Consequences.** Execute is unchanged and stricter than write: its `once` floor lives
in the grant service itself (ADR-5), so an un-opted execute cannot stand through *any*
path; a write's per-use is only a connect-time default, liftable by any explicit
per-capability owner act (the opt-in, approve-with-window, or a direct grant).
ADR-023's text above records the pre-generalization behavior (`read/write → standing`,
`agentSubsets.isStandingExecute`) verbatim; this ADR supersedes those two clauses.
**Forecloses.** A write becoming standing as a side effect of a global connect-time
setting; any agent-side path to standing for a side-effecting capability.

## ADR-009 (amendment) — first-class audited install + redaction contract

**Amendment to ADR-009.** (a) Source install is a **first-class, user-confirmed,
audited** action (`CapabilitySource.install()`, `source.install` audit event), NOT
an `extras` blob the core never reads (review #secondary, Flow A); cc-master's
`scan()` produces the workflow AND its members. (b) Audit **redaction is a
contract** (`AuditRedactionPolicy`): the single writer scrubs raw call input,
token/connection-key, and resolved-secret material from `detail` before persisting
(review #secondary). (c) Local-service credentials (e.g. the Obsidian Local REST
API bearer key) resolve via `PlatformServices.resolveSecret` from `~/.plexus/secrets/`,
referenced by name — never carried in an entry, manifest, `.well-known`, or audit.

## ADR-008 — `.well-known` summary vs. handshake manifest (two-tier disclosure)

**Decision.** `.well-known/plexus` is unauthenticated and returns SUMMARIES only
(id/kind/label/one-line/grants/transport). Full `describe`, `io` schemas, skill
bodies, and `mcp.raw` are disclosed only in the handshake `Manifest` (after
connection-key). 

**Rationale.** This is the pre-session advertisement MCP lacks (kickoff's reason
to exist), but exposing full schemas + usage skills + MCP internals to any
unauthenticated localhost caller is needless leakage. Summary is enough to decide
"should I handshake"; details cost a handshake.

**Forecloses.** Agents calling directly off `.well-known` with no session. A
"public full manifest" mode could be added behind a user toggle later.

## ADR-009 — State layout & single write path

**Decision.** All state under `~/.plexus/` (grant store, audit JSONL, source
registry/capabilities, connection-key, token-revocation set). Single write path
for grants + audit (one writer), atomic writes. No pointer files in user cwds;
reverse-lookup from the home registry. Mirrors claude-plugin local-first scoping.

**Rationale.** Prevents schema drift / concurrent corruption; keeps the
compliance story clean (everything the gateway knows lives in one user-owned dir
the user can inspect/delete).

**Forecloses.** Per-project local config files; multi-writer concurrency (a
single gateway process is the sole writer in M0).

---

## RESOLVED IN THE FREEZE (were OPEN forks; now decided)

The directional forks the prior draft listed are now decided and folded into the
ADRs above — they are no longer open:

- **Grant authority flow** → ADR-007 REVISED: pluggable `Authorizer` seam, v1 stub
  = auto-approve. (Locked user decision.)
- **Token lifetime** → ADR-006 + **ADR-011**: **15 min, locked**, made workable by
  the grant-backed refresh endpoint. (Locked user decision.)
- **`execute` verb** → kept (ADR-005). Three verbs.
- **`.well-known` disclosure tier** → kept summary-only (ADR-008), with the
  fingerprint exposure explicitly accepted in ADR-016.
- **MCP resources/prompts projection** → resources → read-only capability entries,
  prompts → skill/capability seeds; now fully buildable via ADR `readResource`/
  `getPrompt` transport branching (review #1) and the verbatim `McpResult` slot
  (review #2).
- **Connection-key delivery** → user-paste only for v1 (callback reserved).

## OPEN / DEFERRED POST-v1 (explicitly out of the frozen M0 contract)

Genuinely deferred; NONE block the v0.1.0 freeze. Each is post-v1 by intent.

1. **MCP-server façade OUTPUT adapter.** Designed-for (the `mcp.raw` verbatim slot,
   the `McpResult` verbatim slot, the down-projection rules) but **not built** in
   M0. Post-v1.

2. **Resource-instance-level grant constraints** (e.g. "only vault A / path B").
   The verb model stays; a `constraints` field can be added later without breaking
   the wire (ADR-005). Post-v1.

3. **Localhost OAuth-style connection-key callback.** Smoother UX than user-paste
   but adds a browser-redirect surface. `connectionKeyDelivery:"callback"` is
   reserved in the type surface; not implemented in v1.

4. **Multi-platform (Windows/Linux) platform-seam implementations.** Interfaces are
   multi-platform from day one (`PlatformServices`); only the macOS impl ships in v1.

5. **Runtime-pluggable third-party transports.** Transports are compile-time
   registered in M0 (ADR-003). A runtime transport registry is post-v1.

6. **Naming.** "Plexus" collides with an existing repo; resolve before M5
   open-source release. No protocol impact.

7. **Task ticket as a first-class lifecycle object.** The bundle (AUTHZ-UX §2.N3) stays a
   pure grouping in 1.0; the full ticket — open/close lifecycle, task boundary,
   ticket-grouped narration, an `until-task-closed` window kind — is deferred. The seams
   it assembles from are locked by **ADR-020**
   ([`docs/design/authz-extensibility.md`](../design/authz-extensibility.md)); building it
   is assembly, not surgery. Post-v1.
