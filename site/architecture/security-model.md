---
title: The security model
description: "The authoritative Plexus trust and authorization model: two credentials, per-agent PATs, standing grants gated by sensitivity, and the execute-defaults-to-per-use ceiling — every claim cited to code."
---

# Security & trust model

::: tip Audience
Someone deciding whether to trust Plexus with real resources, who needs to know
**exactly** what each credential can do, what a leak of each costs, and how
authorization flows. Every load-bearing claim cites `file:line` against the
committed code so you can verify it yourself. The authoritative design ledger is
[`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)
(Inv III = per-agent PAT / connection-key admin-only; Inv IV = through-primary
equivalence; Inv VI = templated auth core). This document describes what the
**code** enforces. Paths below are relative to `packages/runtime/src/` unless noted.
:::

## The trust model in 5 sentences

1. There is exactly one **admin trust boundary** — the `connection-key` (plus the wider
   management surface it authenticates) — and agents **never** hold it; an agent that only
   speaks HTTP can never reach the management plane.
2. Each agent authenticates with its **own durable per-agent PAT**, redeemed once from a
   one-time enrollment code, so the blast radius of a leaked agent credential is exactly
   **that one agent's pre-granted capabilities**, independently revocable.
3. A grant is **standing** (frictionless re-use) only when the capability's own
   **sensitivity** permits it; running code (`execute`) defaults to per-use approval (`once`)
   and rides a standing grant only when the owner opts that specific agent + capability in at
   connect time (default off, double-confirmed) — never something the agent can lift itself.
4. The PAT proves the real `agentId`, so a client can never self-assert another agent's
   identity; the admin path may name an `agentId` only because holding the connection-key
   *is* the admin authority.
5. Every credential is **hash-at-rest, fail-closed, and single-purpose**, and the surfaces an
   agent can see (the "Floor") deliberately disclose only the sanctioned owner-approval path —
   never a hint that an on-disk key or a forgeable token exists.

## 1. Credential taxonomy & trust boundaries

Plexus has two trust boundaries and a small set of credentials on each side. The most
important rule: **the connection-key is admin-only; agents authenticate with a
per-agent PAT.**

![Two credentials that never cross — the admin connection-key and each agent's PAT](/diagrams/two-trust-boundaries.png)

| Credential | Who holds it | Authorizes | Lifetime | At rest | Blast radius if leaked |
|---|---|---|---|---|---|
| **Admin connection-key** | The local human / desktop app / `plexus` CLI — obtained **out of band**, never over HTTP | Full management plane: `/admin/api/*` (connect/revoke agents, grants, exposure, sources, mesh join tokens), and the admin path of `handshake` | Long-lived; rotatable (rotation invalidates sessions bootstrapped under the old key) | verified via `state.connectionKey.verify()`; never returned by any route | **Total.** Full admin authority over this gateway. This is *the* thing to protect. |
| **Management key** | Same as above | Same as above — "management key" and "connection-key" are the **same secret** presented as `X-Plexus-Connection-Key` on `/admin/api/*` and on privileged agent-plane actions (revoke-by-jti, grant-status-for-non-originator) | Same | Same | Same as connection-key. |
| **Per-agent enrollment code** | One specific agent, delivered out of band (rides the install command) | Redeeming **once** for that agent's PAT | **15 min**, single-use (`DEFAULT_CODE_TTL_MS`) | sha256 hash only (`codeHash`) | One agent's *bootstrap*, and only within 15 min and only if unredeemed. After redemption it is inert. |
| **Per-agent PAT** (`plx_agent_…`) | One specific agent, stored in its own paradigm (e.g. `.env`) | Opening a session **as that agentId** at `handshake`; from there, that agent's pre-granted (standing) capabilities | Durable until revoked / re-issued (no TTL) | sha256 hash only (`patHash`) | **One agent's pre-granted capabilities**, independently revocable. Cannot reach the management plane. |
| **Scoped token** (signed JWT, `tokenScheme: "plexus-scoped-jwt"`) | The agent that was granted | Invoking exactly the capabilities/verbs in its `scopes`, while its session is live and its jti un-revoked | Short: 15 min default, clamped to `[1m, 60m]` (`config.ts:36-40`) | Stateless signed JWT; jti tracked for revocation | A narrow, short-lived, revocable slice: specific caps for ≤60 min, killable by jti. |
| **Mesh join token** | A remote proxy operator, out of band | Enrolling **one** proxy workload into the mesh (pins its Ed25519 key) | Optional TTL, single-use | sha256 hash only | Admits one workload — and per §7, join grants **zero** capability visibility/access until the owner deliberately exposes + grants. |

### Why the connection-key stays admin-only (verify this)

- **No route returns it, and no payload hints it exists.** There is deliberately **no**
  `GET /admin/api/connection-key` (`admin.ts:409-416`). The rationale is written into the
  code: an untrusted agent speaks only HTTP, so any HTTP route that returned or hinted at the
  key would let the agent escalate to management.
- **The management plane is key-gated uniformly.** One blanket middleware
  `admin.use("/api/*", requireManagementKey)` (`admin.ts:407`) requires a verified
  `X-Plexus-Connection-Key` on **every** `/admin/api/*` data route, reads and writes alike
  (`requireManagementKey`, `admin.ts:383-399`). The loopback Host/Origin guard alone is *not*
  treated as sufficient (any local process can send `Host: 127.0.0.1`, and the gateway may be
  bound to a LAN interface).
- **Agents present a PAT, admins present the connection-key — different places.** At
  `handshake`, an agent presents a `Bearer plx_agent_…` header; an admin presents
  `{ "connectionKey": … }` in the JSON **body** (`handlers.ts:184-248`). The two paths are
  selected by credential presence and never fall through to each other.

## 2. Authorization flow, end to end

![The five-step agent loop — discover, enroll, handshake, grant, invoke](/diagrams/protocol-loop.png)

```
                         ┌─────────────────────────────────────────────────────────────┐
                         │  ADMIN (config-time, holds the connection-key, out-of-band)  │
                         │  POST /admin/api/agents/connect                              │
                         │   ├─ mint one-time enrollment code (plx_enroll_…, 15 min)    │
                         │   └─ declare selected cap-set as the authorized subset:      │
                         │      READ caps → STANDING grants (that IS the human approval)│
                         │      write/execute → per-use unless opted standing per cap   │
                         └───────────────┬──────────────────────────┬──────────────────┘
                                         │ install command          │ standing read grants
                                         │ carries the code          │ persisted for agentId
                                         ▼                          ▼
   AGENT                                                        GATEWAY (primary authority)
   ─────                                                        ─────────────────────────────
   (0) DISCOVER   GET /.well-known/plexus            ──►  unauth; returns gateway identity
                  (no credential)                          + auth advertisement + enrollment
                                                           self-description + capabilitiesVia
                                                           pointer               (well-known.ts)

   (1) ENROLL     POST /agents/enroll { code }       ──►  redeemEnrollmentCode(code):
                                                           shape→known→PENDING→fresh→mint PAT→
                                                           fsync→CONSUME code (single-use)
                  ◄── { pat: plx_agent_…, agentId }        (agent-enrollment.ts:391)
                  store PAT (own paradigm)                 PAT returned in plaintext ONCE

   (2) HANDSHAKE  POST /link/handshake               ──►  verifyPat(pat) → REAL agentId
                  Authorization: Bearer plx_agent_…        session bound to THAT id (not client-
                  ◄── { sessionId, manifest, … }           supplied)      (handlers.ts:195-231)

   (3) GRANT      PUT /grants { grants:{ id:"allow"}} ──►  per cap: in the agent's authorized
                  X-Plexus-Session: <sess>                 subset? ── no ─► DENIED (audited)
                                                           hasPriorApproval? (standing +
                                                           unexpired) ─ yes ─► short-circuit → token
                                                                              ─ no ──► authorizer:
                                                             low-risk 1P read → allow (auto)
                                                             write/exec / extension → PENDING
                  ◄── ScopedToken  OR  grant_pending_user   (grant-service.ts:542-733)

   (3b) APPROVE   (owner, in console)  POST /admin/api/pending/:id { action:"approve", trustWindow }
                                                       ──►  persist standing grant + mint token
                  agent polls GET /grants/status?pendingId=…  (originator- or mgmt-key-gated)
                  ◄── { state:"approved", token }        (handlers.ts:417-444)

   (4) INVOKE     POST /invoke { id, input }          ──►  verifyToken → jti/session liveness →
                  Authorization: Bearer <scoped-jwt>       exposure gate → constraint check →
                  ◄── { id, ok:true, output }              dispatch      (handlers.ts:561-626)
```

**What is checked at each hop:**

- **(0) Discover** — nothing. `.well-known` is public and unauthenticated by design; it
  advertises the gateway identity, the auth/lifecycle endpoint URLs, and the enrollment
  self-description, plus a `capabilitiesVia` pointer: enroll and handshake to receive the
  capabilities the owner authorized for you. Capability discovery happens only after
  handshake, via the manifest scoped to the agent's authorized subset — which closes
  pre-identity enumeration. It never discloses the connection-key or any secret
  (`buildPublicWellKnown`, `well-known.ts:168-177`).
- **(1) Enroll** — the **code is the credential** (`handlers.ts:279-324`); the connection-key
  is never accepted here. Fail-closed: malformed body → 400; bad/used/expired code → 401 with a
  typed reason; durable-write failure → 500 with the code left unconsumed for retry.
  The redeem itself runs five checks in order and only mints on success
  (`redeemEnrollmentCode`, `agent-enrollment.ts:391`).
- **(2) Handshake** — a `Bearer` token is treated as a PAT auth attempt and **must** verify; a
  forged/revoked/expired/non-PAT bearer fails closed (401, no session) and does **not** fall
  through to the connection-key. The session binds to the PAT's verified `agentId`; any
  `client.agentId` is coerced to it (`handlers.ts:197-215`, `sessions.ts:74-93`).
- **(3) Grant** — see §3. For a scoped agent, a request for a capability **outside its
  owner-authorized subset is denied outright** (audited), never pended — unless an
  owner-issued standing grant for it already exists; the authoritative admin path (the flow
  that defines the subset at connect) is exempt (`grant-service.ts:613-646`). Within the
  subset, a standing+unexpired prior grant short-circuits the authorizer; otherwise the
  `UserConfirmAuthorizer` decides auto-allow vs pend (`authorizer.ts:218-280`).
  Unknown capability ids are rejected 400 (no silent skip, no hollow token) before the grant
  service is touched (`handlers.ts:380-387`).
- **(4) Invoke** — token signature, jti revocation, and session liveness are all enforced
  (and a denial is **audited**, not silently dropped) inside the pipeline
  (`handlers.ts:585-626`). A top-level-disabled ("unexposed") capability is refused even with a
  valid token.

## 3. Standing grants, trust-windows & sensitivity

A **standing grant** is the durable record that lets an agent's later in-scope request
short-circuit human approval. Standing-eligibility is decided by **capability sensitivity**,
which is derived from `provenance × verb` — **not** by whether the capability is local or
remote (ADR-5 / Inv IV).

### Sensitivity → trust-window

`recommendedTrustWindowFor(provenance, verbs, table)` (`capability-registry.ts:163-173`) maps:

- **`execute` (any provenance/origin) → `once`.** This is the one act whose sensitivity
  defaults to per-use approval. It keys on the **verb**, which survives a mesh mount, so a
  mesh `execute` cap and a local `execute` cap both get `once` — nothing gets `once` merely for
  being remote (`capability-registry.ts:168-169`).
- **`read` / `write` → the standing-eligible per-class default** from `DEFAULT_TRUST_WINDOWS`
  (`config.ts:67-74`):

  | class | read | write |
  |---|---|---|
  | first-party | 7d | 1d |
  | managed | 7d | 1d |
  | extension | 1d | 1d |

  Note `extension:write` is `1d` (a real standing window), **not** `once`. The older
  "mesh/extension caps hardcoded to `once`" behavior conflated *remote* with *per-use-only* and
  was removed (`config.ts:56-66`).

### The `execute → once` default ceiling (verify this)

`chooseTrustWindow` (`grant-service.ts:461-506`) is the single choke point that resolves the
window actually applied. Two guards make the per-use posture structural:

```ts
// grant-service.ts (chooseTrustWindow)
if (this.isAnon(opts.agentId)) return { kind: "once" };     // ~476  anon:* capped
if (def.kind === "once") {                                  // ~484  execute: per-use DEFAULT
  if (!optedStanding) return { kind: "once" };              //       no owner opt-in → hard floor
  // opted in: honor the admin window; absent → until-revoked (or 7d when disallowed)
  …
}
```

The `def.kind === "once"` branch is the load-bearing rule: when the capability's own sensitivity
yields a `once` default (exactly the `execute` case), `once` is returned **regardless of what was
requested and regardless of whether the pick is admin-authoritative** — unless the owner has
opted **that specific (agent, capability) pair** into a standing execute grant at connect time
(ADR-023: default off, double-confirmed, independently revocable). The opt-in is consulted via
`agentSubsets.isStanding` and persisted only by the owner's connect flow (the per-capability
`standing` field of `POST /admin/api/agents/connect` in `core/admin.ts`; the legacy
`standingExecute` key is accepted as an alias) — an agent can never set it itself. An opted-in execute grant honors the
admin's authoritative window, or stands `until-revoked` absent one (clamped to `7d` when
`until-revoked` is disallowed by policy). For `read`/`write` the default is never `once`, so
this clause never fires for them and a legitimate admin window survives. The clamp is applied on
**both** the authoritative (admin) and advisory (agent) paths — every mint site funnels through
`chooseTrustWindow` (`grant-service.ts:666, 1119, 1476`).

### Other standing-grant rules

- **First grant pends for extension; re-use short-circuits.** `hasPriorApproval` returns true
  **only** for a standing + unexpired grant (`grant-service.ts:394-402`,
  `isStandingAndUnexpired`); a `once` or expired grant never short-circuits. So the first ask for
  a write/extension cap pends for the owner; subsequent in-scope asks are frictionless.
- **`anon:*` → `once`.** A session with no verified agentId (`anon:<sessionId>`) never gets a
  durable standing grant — capped at `once` in both `chooseTrustWindow` (`grant-service.ts:~476`)
  and the authorizer's window pick (`authorizer.ts:213-215`).
- **Agent windows are advisory, admin windows authoritative.** An agent may propose a window on
  `PUT /grants` but it may only **shorten**, never lengthen past the per-class ceiling
  (`shorterWindow`, `grant-service.ts:88-90`, applied at `:505`). The admin/human approve pick
  is authoritative (still subject to the un-opted `execute→once` and `until-revoked`-policy
  clamps).
- **Constraints only narrow.** A constrained standing grant short-circuits a bare or
  deep-equal request but not a broader/different one, and the minted token always carries the
  **standing grant's** constraint, never a widened one (`effectiveConstraint`,
  `grant-service.ts:428-434`).

## 4. Identity & anti-spoofing

The pre-`feat/agent-skill-compile` weakness was a self-asserted `agentId`: a client could claim
to *be* any agent. The PAT closes this.

- **The PAT binds the real agentId.** At `handshake`, a `Bearer` token is resolved through the
  enrollment ledger: `verifyPat(pat)` returns the `agentId` of the **active** row whose
  `patHash` matches, or `null` (`verifyPat`, `agent-enrollment.ts:438`). The session is then opened bound
  to *that* id, and the client-supplied `agentId` is overwritten with the verified one
  (`handlers.ts:214-215`).
- **The session store treats explicit agentId as trusted, client.agentId as untrusted.**
  `open(bootstrapKey, client, agentId)` uses the explicit verified `agentId` when present and
  overrides any `client.agentId`; the free-form `client.agentId` is audit metadata only and is
  **never**, on its own, a trustworthy identity for a public caller (`sessions.ts:33-46, 74-93`).
- **A stolen agentId string buys nothing.** Replay/forge resistance comes from the PAT verifier
  (hash-at-rest, per-agent, revocable) — naming an agent without its PAT gets you a 401, no
  session (`handlers.ts:197-209`).
- **Why the admin path may still name an agentId.** The connection-key body path *may*
  legitimately name the `agentId` it acts on behalf of (the console's "connect an agent" does
  exactly this). That is not a spoof: possessing the connection-key **is** the admin authority,
  and an agent has no connection-key to reach that path with (`handlers.ts:174-182`,
  `admin.ts:668`).

## 5. Revocation & blast radius

"Revoke an agent" means **all of that agent's access dies immediately, and nothing else is
touched.** The admin route `POST /admin/api/agents/revoke` (`admin.ts:838`) does three
per-agent-scoped things:

1. **Enrollment / PAT** — `agentEnrollment.revoke(agentId)` flips the row to `revoked` and drops
   its `patHash` from the active index, so the PAT stops verifying immediately; future handshakes
   with it fail closed (`agent-enrollment.ts:457`).
2. **Live sessions** — `sessions.invalidateByAgentId(agentId)` invalidates every live session
   bound to that agentId and returns their jtis, which are then revoked. This makes revoke
   **immediate** rather than delayed by ~session-lifetime, and reaches sessions by *identity*
   (the admin knows the agentId, not the raw PAT) (`sessions.ts:126-139`, `admin.ts:871-877`).
3. **Standing grants + live tokens** — `grants.revokeAllForAgent(agentId)` removes the agent's
   durable grants (so refresh can't re-mint) **and tombstones** each pair (so a still-running
   agent's bare re-request re-confirms with a human instead of silently re-auto-allowing a
   low-risk read), then revokes any remaining tracked jtis (`revokeAllForAgent`,
   `grant-service.ts:1396`).

**Per-agent isolation.** Every step keys on `agentId`; a second agent's enrollment, sessions,
and grants are untouched. This is the concrete payoff of the per-agent PAT: revocation is scoped
to one agent, unlike a shared credential whose rotation would cut everyone off.

**Revocation tombstone.** After a revoke, a just-revoked `(agentId, cap)` low-risk read that
would normally auto-allow instead **pends** for a human (`authorizer.ts:266-271`,
`ctx.revokedTombstone`); a fresh human approval lifts the tombstone. "Revoke is the complete
stop."

**Related revocation paths:** connection-key **rotation** invalidates sessions bootstrapped
under the old key (`sessions.invalidateByKey`, `sessions.ts:115-124`) — note that PAT-bootstrapped
agent sessions are bootstrapped under the PAT, not the connection-key, so they are deliberately
decoupled from key rotation and die only with their own PAT. An agent may relinquish its **own**
token by presenting it (`revoke` path b, `handlers.ts:512-533`); revoke-by-jti-for-someone-else
and revoke-by-bundle require the management key (`handlers.ts:536-539`).

**Revocation deletes the grant row — the audit log keeps the story.** Removing the durable
record is what makes revoke final (refresh can't re-mint), so the *replayable* record of what
was authorized is the audit trail, not the grant store. Every grant-lifecycle audit event
carries the member's `bundleId` (stamped before row removal), so a task bundle's full story —
pend → allow → re-mint → revoke — survives the rows within audit retention. This guarantee,
and the other seams the authorization model keeps open for task-scoped and enterprise use,
are locked in [authorization extensibility](/architecture/extensibility) (ADR-020).

## 6. Compile-model security (self-integrating skills)

The compile model ships a resource to an agent as a native artifact (v1: a Claude Code plugin).
Inv VI is the security spine: **the auth/invoke core of any generated artifact is deterministically
templated and Floor-verifiable, never LLM-authored**, and **no long-lived secret is baked into a
distributed artifact.**

- **No secret is baked in; the one-time code rides the install.** The distributed artifact
  contains no durable PAT and no admin key. The enrollment **code** (short-lived, single-use) may
  ride the install *command*, and is redeemed to a PAT the agent stores itself — the PAT is
  returned exactly once at redeem and never persisted into a shipped file
  (`well-known.ts:119-129` describes the redeem→store contract; `agent-enrollment.ts:122-128`).
- **The hardened `.well-known` is the oracle.** A build-time verifier
  (`integration/verify-plugin.ts`) checks a rendered plugin against the Floor across five
  independent axes, returning a structured pass/fail:
  1. **Sanctioned auth core** — `bin/plexus` is byte-identical (sha-256) to the committed
     sanctioned engine (`tools/plexus-cli/plexus`); the plumbing was not hand/LLM-altered.
  2. **No baked secret** — no distributed file contains a `plx_agent_…` PAT, a baked
     `plx_enroll_…` code, or any caller-supplied durable credential (incl. the admin
     connection-key, passable as `forbiddenSecrets`).
  3. **Only advertised/granted caps** — every capability the skill references is present in the
     Floor's advertised catalog (and, when supplied, within the cap-set the plugin was compiled
     for). A skill can never reference a cap the Floor does not advertise.
  4. **Sanctioned flow** — the enroll/handshake/invoke the plugin *instructs* matches the Floor's
     `auth.enrollment` / `requestShapes`; no instruction file improvises an auth path (reads an
     on-disk admin key, or forges a token).
  5. **Prose integrity** — the hand-authored skill body is hash-pinned
     (`SKILL_BODY_SHA256_PIN`): the source prose must hash to the pinned oracle and the rendered
     `SKILL.md` carries it verbatim, so any edit to the pedagogical shell forces a deliberate
     re-review + re-pin before it can ship.
- **Staleness is safe (Inv V).** A skill is a projection over the Floor; the gateway enforces
  authz **live**. A stale or mis-generated skill can never exceed the Floor's authz — worst case
  is cosmetic (references a revoked cap → the invoke just fails at the gateway). Auto-update is a
  freshness/UX feature, not a safety feature; **v1-partial:** auto-update is deferred to v2.

## 7. Mesh trust

Mesh access is governed by **through-the-primary equivalence** (Inv IV / ADR-5): a capability
routed from a mesh node is authorized **identically** to a local one — same PAT, same authorizer,
same trust-windows. Origin is a routing detail invisible to the agent's authz path.

Two mesh-specific defenses back that up:

- **Remote-asserted trust posture is never trusted.** When a remote workload's caps are mounted,
  the primary **strips** any `provenance`/`sensitivity`/`recommendedTrustWindow`/`health` the
  proxy asserted and **re-derives** them locally. A mounted cap re-derives to `extension`
  provenance (the strictest class), so a mounted remote read **pends** and never auto-allows; a
  malicious proxy asserting `provenance:"first-party"` cannot spoof the authorizer
  (`capability-registry.ts:956-973`).
- **Tunnel auth is mutual, pinned Ed25519, fail-closed.** The proxy↔primary boundary is separate
  from the agent↔primary boundary. At join, a one-time join token (the nonce, sha256-at-rest,
  single-use) admits one workload and **pins** its Ed25519 public key (`mesh/enrollment.ts`
  header + `admit`). Every subsequent socket runs a mutual challenge — the primary verifies the
  proxy against the pinned key, the proxy verifies the primary against its pinned
  `upstream.primaryPubKey` (mandatory: no bare TOFU) — and an unenrolled/unauthenticated socket
  is dropped before any data frame (`mesh/handshake.ts:399-454`).
- **Transport-encryption policy.** `requireEncryption` (`PLEXUS_MESH_REQUIRE_ENCRYPTION`) makes
  the primary refuse a plain-`ws` proxy tunnel with a typed `encryption_required` reason and
  accept only `wss` (`mesh/handshake.ts:399-403`). Identity ⟂ encryption: this gates the
  *channel*, not the Ed25519 identity — a valid pinned key over plain ws is still refused. It
  fails fast at boot if enabled without TLS material (`config.ts:645-650`).

See [the federated mesh](/architecture/mesh) for the full mesh developer model.

## 8. Error hygiene as a security property

A blind-test finding showed that vague auth errors *tempt*
a careful agent to "go find a signing key on disk and mint its own token." The committed error
surface treats **legibility toward the sanctioned path as a security control**:

- An `/invoke` with a live session but no grant returns a **structured** `approval_required`
  with `pendingId` + `approvalUrl` + `grantStatusUrl` and the explicit message *"Owner must
  approve this grant in the Plexus console; the agent cannot mint its own token"*
  (`handlers.ts:692-712`).
- An `/invoke` with no session returns honest `grant_required` guidance that points at
  handshake → `PUT /grants` and states plainly that low-risk first-party reads are auto-granted
  and **"the agent cannot mint its own token"** (`handlers.ts:634-652`).
- `.well-known` advertises the grant-**request** entry point (`grantRequestUrl` + method) and the
  enrollment redeem step, so the only advertised forward path is the audited, owner-approved one
  (`well-known.ts:60-129`). No response, error, or how-to hints that an on-disk key or a
  forgeable token exists.
- The originator/management gate on `GET /grants/status` ensures a minted token is only ever
  handed to the session that created the pending (or the management key) — a leaked `pendingId`
  alone gets a 403, never the token (`handlers.ts:417-444`).

The principle: **make the sanctioned path the only discoverable one, and never phrase an error in
a way that steers a caller toward forging a credential or reading a key file.**

## 9. Threat model — in-scope, out-of-scope, and the red-team result

### In scope (the code defends these)

- A network/HTTP-only adversary (an agent, a LAN peer once LAN binding is enabled) trying to
  reach the management plane: blocked by the connection-key gate on all `/admin/api/*` and the
  no-key-over-HTTP rule (`admin.ts:383-416`).
- An agent trying to self-assert another agent's identity: blocked by PAT→agentId binding (§4).
- An agent trying to self-grant write/execute or grant against an extension cap without a human:
  blocked by the default `UserConfirmAuthorizer` (`authorizer.ts:180-280`).
- An agent trying to make running code (`execute`) frictionless/standing **on its own**:
  structurally impossible — only the owner can opt a specific (agent, capability) pair into
  standing execute at connect (`chooseTrustWindow`, `grant-service.ts:461-506`).
- A leaked agent credential: bounded to one agent's pre-granted caps, revocable in isolation (§5).
- A malicious mesh proxy asserting a favorable trust posture, or a plaintext/MITM tunnel: blocked
  by local re-derivation, pinned mutual auth, and the encryption policy (§7).
- Secrets at rest: enrollment codes, PATs, and mesh join tokens are sha256-hashed on disk
  (0600 ledger files); PAT/code plaintext is returned exactly once and never recoverable
  (`agent-enrollment.ts:36-39, 225-236`).

### Out of scope (documented assumptions — rely on OS/deployment, not Plexus code)

::: warning Same-UID host isolation
The per-agent-PAT isolation assumes the agent process **cannot read the admin connection-key
file.** On a same-UID host an agent can `cat ~/.plexus/connection-key` and gain full admin
authority — Plexus's in-process boundary cannot prevent a process that can read the owner's home
directory. The mitigation is **OS sandboxing / the container appliance** (the mesh/appliance
epic; see
[`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md),
[`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md)),
which puts the agent in a confinement that cannot read the key file. Until then, treat "the agent
runs as the same user that owns `~/.plexus`" as **full admin trust in that agent.**
:::

- Host compromise / root, memory scraping of the live process, and side channels are out of
  scope for the application layer.
- **v1-partial hardening, explicitly deferred:**
  - **Keypair PATs.** v1 uses a **bearer** PAT (chosen for the operator's `.env` mental model +
    simplicity, ADR-4). A keypair PAT (proof-of-possession, so a leaked-at-rest credential is
    useless without the private key) is a documented **v2** hardening over bearer PATs.
  - **Skill auto-update** (Inv V) — deferred; safety does not require it (§6).
  - **LLM-authored pedagogical shell** — even in v2, the LLM may write only task-framing/examples,
    never the auth/invoke mechanics (Inv VI).

### Red-team result

Two adversarial red-team reviews were run on the committed auth spine + the admin/revoke path.
Conclusion: **the spine is clean.** The one confirmed **HIGH** — an `execute` capability being
allowed to ride a standing grant under an admin-supplied window with no owner decision anywhere
— **has been fixed**; the fix is the `def.kind === "once"` clamp in `chooseTrustWindow`
(`grant-service.ts:484`), applied on both the authoritative and advisory paths. ADR-023 keeps
that clamp as the default and adds the one sanctioned lift: the owner's explicit
per-(agent, capability) standing-execute opt-in, double-confirmed at connect.

## 10. What a developer must NOT do

- **Do not bake the connection-key (or any durable secret) into anything agent-facing** — not a
  skill, not a plugin, not a config the agent can read, not an HTTP response. The connection-key
  is admin-only; there is deliberately no route that returns it.
- **Do not let a skill's auth/invoke core be LLM-authored or hand-edited.** It must be the
  byte-identical sanctioned engine, verified against the Floor oracle (Inv VI,
  `verify-plugin.ts`). An LLM writing the auth path could ship an over-reach tutorial.
- **Do not distribute a durable PAT.** Ship the one-time code (short-lived, single-use); let the
  agent redeem and store its own PAT.
- **Do not treat the loopback Host/Origin guard as authentication** for management actions — it
  proves "an accepted authority," not "the trusted management client." Gate management routes on
  the verified connection-key.
- **Do not add a management action that an agent can reach over the agent plane.** Agent-plane
  actions must go through the authorizer (pend-for-owner) and never grant management authority.
- **Do not let an `execute` capability stand without the explicit per-(agent, capability)
  owner opt-in** (default off, double-confirmed at connect). Keep the un-opted `once` floor in
  `chooseTrustWindow` intact, and keep the agent path advisory (shorten-only).
- **Do not trust remote-asserted trust posture** (provenance/sensitivity/health) from a mesh
  proxy — always re-derive locally.
- **Do not phrase an auth error in a way that implies a forgeable token or an on-disk key.** Point
  callers at the sanctioned owner-approval path.

### Appendix — key files

| Concern | File |
|---|---|
| Enrollment ledger (code→PAT, hash-at-rest, single-use, revoke) | `core/agent-enrollment.ts` |
| Two-credential handshake (PAT=agent, connection-key=admin) | `core/handlers.ts` (`handshake`, `enrollAgent`) |
| Session binding, `invalidateByAgentId`/`invalidateByKey` | `core/sessions.ts` |
| Grants, standing, `hasPriorApproval`, `chooseTrustWindow`, `revokeAllForAgent` | `core/grant-service.ts` |
| Sensitivity→window, `recommendedTrustWindowFor`, mesh mount re-derivation | `core/capability-registry.ts` |
| `DEFAULT_TRUST_WINDOWS`, clamps, `requireEncryption` fail-fast | `config.ts` |
| Management-key gate, connect/revoke an agent | `core/admin.ts` |
| Public Floor + enrollment self-description | `core/well-known.ts` |
| Pend / auto-approve / tombstone policy | `auth/authorizer.ts` |
| Build-time skill↔Floor verifier (Inv VI) | `integration/verify-plugin.ts` |
| Mesh join enrollment (Ed25519 pin), mutual tunnel auth + encryption policy | `mesh/enrollment.ts`, `mesh/handshake.ts` |
