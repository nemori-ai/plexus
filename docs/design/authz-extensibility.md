# Authorization Extensibility — the 1.0 seams (ticket vs badge)

> Developer/design-facing. Audience: someone deciding whether Plexus's 1.0 authorization
> model can grow into task-scoped and enterprise authorization **without a breaking
> rewrite** — and someone extending it later who needs to know which seams were left open
> on purpose. Status: **locked for 1.0-RC** (recorded as ADR-020 in
> [`../protocol/DECISIONS.md`](../protocol/DECISIONS.md)). Every load-bearing claim cites
> code so you can verify it yourself. Paths are relative to `packages/` unless noted.
>
> The one-sentence version: **1.0 ships the badge and a proto-ticket; the full ticket is
> deliberately deferred — but every join key, reserved field, and choke point it will need
> already exists and is guaranteed here.**

## 1. The two units of authorization — ticket and badge (门票与工牌)

Users reason about **tasks**; the gateway enforces **capability calls**. Approval fatigue
is what happens when a human is asked to make task-level decisions at call-level
granularity — twenty identical cards degrade every decision into muscle memory. Plexus's
answer separates two instruments:

- **The badge (工牌)** — *who you are.* The durable per-agent PAT: long-lived identity,
  independently revocable, never authority by itself
  ([`design/security-model.md`](./security-model.md) §1).
- **The ticket (门票)** — *what you may do right now.* A task-scoped, bounded consent:
  approved up front, in force while the task runs, closed when the task ends, and
  narratable as one story ("this agent organized this vault under this authorization").

Coarsening consent from per-call to per-task is safe only because two compensating
controls stay dense: **every entry and exit is logged** (the audit trail, per call), and
**revocation is one act with immediate effect** (kill the ticket, every member dies).
Consent granularity, audit density, and revocation speed trade off as a triangle — 1.0
holds the second and third fixed so the first can relax.

**1.0 ships the badge in full and the ticket as a *proto-ticket*: the task bundle.** A
bundle is N ordinary standing grants sharing a `bundleId` tag — one approve, one revoke,
attached context, **no new authority class** (`runtime/src/core/grant-service.ts:1357-1361`:
"a bundle adds NO new authority class"). What it does *not* yet have is a lifecycle: no
open/close, no task boundary, no ticket-level narration. That object is deferred
(ADR-020) — this document guarantees the seams it will be built from.

## 2. The seams — what 1.0 locks open (verify each)

### S1 — The bundle join key outlives the grant rows (audit linkage)

Grant rows are **deleted** on revoke, by design: `revoke()` removes the pair
(`grant-service.ts:1245-1266`), `revokeAllForAgent()` sweeps the agent
(`grant-service.ts:1316-1350`), `revokeBundle()` removes every member
(`grant-service.ts:1573`). The durable record of *what was authorized under which task* is
therefore the **audit log**, not the grant store — so the `bundleId` join key rides every
grant-lifecycle audit event, stamped **before** the row is removed:

| Lifecycle stage | Event | Where stamped |
| --- | --- | --- |
| agent requests a named bundle | `grant.pending` | `grant-service.ts:662` (+ `bundleName`) |
| human approves the pend | `grant.allow` | `grant-service.ts:1068` (+ `bundleName`) |
| bare in-scope re-mint of a member | `grant.allow` | `grant-service.ts:696` (don't silently un-bundle) |
| admin one-shot bundle create | `grant.allow` | `grant-service.ts:1406-1417` (+ `bundleName`) |
| pair revoke of a member | `grant.revoke` | `grant-service.ts:1255-1260,1297` (captured pre-removal) |
| agent revoke (sweep) | `grant.revoke` | `grant-service.ts:1320,1350` (distinct `bundleIds`) |
| bundle revoke | `grant.revoke` | `grant-service.ts:1597-1605` |

Covered end-to-end by `tests/authz-ux-bundle.test.ts` §6 ("audit keeps the bundle join
replayable"): pend → allow → re-mint → revoke all carry the same `bundleId` **after** the
ledger shows zero rows for the bundle.

**Honest bound:** the audit log is append-only JSONL, daily-rotated, **retention default
90 days** (`runtime/src/audit/index.ts:7`). The ticket story is replayable within the
retention window — an enterprise deployment that needs longer replay raises retention or
ships the log; nothing else has to change.

### S2 — Attribution reserves the enterprise "who/why" fields

Every audit event can carry an `Attribution` — `agent` (who acted), `principal?` (on whose
behalf — enterprise), `grantRef?` (which grant authorized it), `policyRef?` (which policy
rule decided it — enterprise) (`protocol/src/types.ts:2719-2729`). All optional; a
single-gateway 1.0 deployment neither sets nor reads them. A future ticket/policy layer
populates them without touching the event shape.

### S3 — Trust windows extend additively

`TrustWindowKind` is a closed union — `"once" | "1h" | "1d" | "7d" | "until-revoked" |
"custom"` (`protocol/src/types.ts:304`) — with a **single** expiry choke point
(`resolveWindowExpiry`, used by `persistGrant`, `grant-service.ts:740-751`). Adding a
future kind (e.g. `until-task-closed`, whose expiry is an event rather than a timestamp)
is an additive protocol minor bump plus one branch in one function. No stored grant, no
wire client, no admin UI breaks: unknown kinds simply never appear until offered.

### S4 — The authorizer is a pluggable policy seam (ADR-007)

The grant decision runs behind the `Authorizer` interface (`protocol/src/types.ts:1509`;
implementations in `runtime/src/auth/authorizer.ts` — "PLUGGABLE abstraction; swapping the
policy never touches the wire"). 1.0 ships `auto-approve` (trusted-admin path) and
`confirm-risky` (the default pend policy). An enterprise policy engine — evaluate against
a ticket, a role, an org rule — slots in as a third implementation and reports its
decisions via `policyRef` (S2), with zero wire change.

### S5 — A ticket can never widen authority (the invariant that survives extension)

Whatever the future ticket object becomes, it inherits the bundle's structural rule: **a
grouping confers no authority beyond its members** — each member is an ordinary
`PersistedGrant` that passed the ordinary approval gate, and the whole group is dropped by
connection-key rotation (`keyEpoch` stamping, D6) exactly like any grant. The ticket is a
*consent-and-narration* object, never a fourth authority class alongside grant, token, and
exposure. Effective access stays **granted ∧ exposed**, per capability, enforced live at
the pipeline (`runtime/src/core/exposure.ts`, `pipeline.ts`).

## 3. Execute inside a ticket — the constraints, now partly answered (ADR-023)

The `execute → once` ceiling was originally stated as structural — an execute capability
never rides a standing grant, not even admin-supplied (`design/security-model.md` §3,
ADR-018). A full ticket model collides with it — "organize this vault" may legitimately
include a `claudecode.run` leg, and a ticket that still pends on every execute is an
incomplete ticket, while a ticket that silently lifts the ceiling is a hole.

**ADR-023 relaxes `execute → once` from an absolute into a DEFAULT-with-owner-override** —
the owner may opt a *specific* execute capability into a standing grant for a *specific*
agent (default-off, double-confirm at connect). That resolves the first constraint below in
the strict, opt-in direction it demanded; the *ticket* object itself is still not built. The
constraints any future ticket answer must satisfy remain:

1. Standing execute is never something the **agent** can choose or self-elevate to, and never
   a default — it exists only as a deliberate, warned, **per-agent + per-capability owner
   override** (ADR-023). The default floor (execute pends per use) is unchanged.
2. Any relaxation is **opt-in per capability** (the owner declares standing execute
   admissible for one agent), never a blanket ticket/agent power.
3. A ticket-scoped execute never rides `until-revoked` beyond a bounded window unless the
   owner explicitly chose `until-revoked` in that per-capability opt-in.

## 4. What the future ticket object adds (sketch, non-normative)

Materializable from the seams above, with no migration:

- **Lifecycle** — open (the approval act) → in-force → closed (user act, task end, or
  window expiry). "Closed" is the new state; S3 carries it as a window kind.
- **Boundary** — the task's scope constraints + context, which the bundle already groups
  (`bundleId` + constraints + attached context, AUTHZ-UX §2.N3).
- **Narration** — the Grants tab and the audit view grouped by ticket: one card per task,
  its members inside, its full call history joined via S1.

None of this is 1.0 work. The guarantee of this document is only: when it becomes work,
it is **assembly**, not surgery.
