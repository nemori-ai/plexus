---
title: Authorization extensibility
description: "The 1.0 authorization seams — ticket vs badge: how task-scoped and enterprise authorization will be assembled from join keys, reserved fields, and choke points that 1.0 already guarantees."
---

# Authorization extensibility — ticket vs badge

::: tip Audience
Someone deciding whether Plexus's 1.0 authorization model can grow into task-scoped
and enterprise authorization **without a breaking rewrite** — and someone extending it
later who needs to know which seams were left open on purpose. Locked as **ADR-020**
in the [decision log](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md);
the repo SSOT is
[`authz-extensibility.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/authz-extensibility.md).
:::

The one-sentence version: **1.0 ships the badge and a proto-ticket; the full ticket is
deliberately deferred — but every join key, reserved field, and choke point it will need
already exists and is guaranteed here.**

## The two units of authorization — ticket and badge

Users reason about **tasks**; the gateway enforces **capability calls**. Approval
fatigue is what happens when a human is asked to make task-level decisions at
call-level granularity — twenty identical cards degrade every decision into muscle
memory. Plexus's answer separates two instruments:

- **The badge** — *who you are.* The durable per-agent PAT: long-lived identity,
  independently revocable, never authority by itself
  ([security model](/architecture/security-model)).
- **The ticket** — *what you may do right now.* A task-scoped, bounded consent:
  approved up front, in force while the task runs, closed when the task ends, and
  narratable as one story ("this agent organized this vault under this authorization").

Coarsening consent from per-call to per-task is safe only because two compensating
controls stay dense: **every entry and exit is logged** (the audit trail, per call),
and **revocation is one act with immediate effect** (kill the ticket, every member
dies). Consent granularity, audit density, and revocation speed trade off as a
triangle — 1.0 holds the second and third fixed so the first can relax.

**1.0 ships the badge in full and the ticket as a *proto-ticket*: the task bundle.** A
bundle is N ordinary standing grants sharing a `bundleId` tag — one approve, one
revoke, attached context, **no new authority class**. What it does *not* yet have is a
lifecycle: no open/close, no task boundary, no ticket-level narration. That object is
deferred (ADR-020) — the seams below are what it will be built from. The 1.0 admin
console does **not** surface bundle authoring yet — the endpoints and grant-service
coupling ship as the retained mechanism, and any bundle member shows as a normal
standing grant — so the surface can be reintroduced once the ticket lifecycle lands.

## The seams — what 1.0 locks open

### S1 — The bundle join key outlives the grant rows

Grant rows are **deleted** on revoke, by design — that is what makes revoke final
(refresh can't re-mint). The durable record of *what was authorized under which task*
is therefore the **audit log**, not the grant store — so the `bundleId` join key rides
every grant-lifecycle audit event, stamped **before** the row is removed:

| Lifecycle stage | Event carries |
| --- | --- |
| agent requests a named bundle | `grant.pending` + `bundleId` + `bundleName` |
| human approves the pend | `grant.allow` + `bundleId` + `bundleName` |
| bare in-scope re-mint of a member | `grant.allow` + `bundleId` (never silently un-bundled) |
| admin one-shot bundle create | `grant.allow` + `bundleId` + `bundleName` |
| pair / agent / bundle revoke | `grant.revoke` + `bundleId` (captured pre-removal) |

So a task bundle's full story — pend → allow → re-mint → revoke — is replayable from
the audit log alone, **after** the ledger shows zero rows for the bundle. Honest bound:
the audit log is append-only JSONL with a default 90-day retention; a deployment that
needs longer replay raises retention, and nothing else changes.

### S2 — Attribution reserves the enterprise "who/why" fields

Every audit event can carry an `Attribution` — `agent` (who acted), `principal?` (on
whose behalf — enterprise), `grantRef?` (which grant authorized it), `policyRef?`
(which policy rule decided it — enterprise). All optional; a single-gateway 1.0
deployment neither sets nor reads them. A future ticket/policy layer populates them
without touching the event shape.

### S3 — Trust windows extend additively

`TrustWindowKind` is a closed union — `once | 1h | 1d | 7d | until-revoked | custom` —
with a **single** expiry choke point. Adding a future kind (e.g. `until-task-closed`,
whose expiry is an event rather than a timestamp) is an additive protocol minor bump
plus one branch in one function. No stored grant, no wire client, no admin UI breaks:
unknown kinds simply never appear until offered.

### S4 — The authorizer is a pluggable policy seam

The grant decision runs behind the `Authorizer` interface (ADR-007 — "swapping the
policy never touches the wire"). 1.0 ships `auto-approve` (trusted-admin path) and
`confirm-risky` (the default pend policy). An enterprise policy engine — evaluate
against a ticket, a role, an org rule — slots in as a third implementation and reports
its decisions via `policyRef` (S2), with zero wire change.

### S5 — A ticket can never widen authority

Whatever the future ticket object becomes, it inherits the bundle's structural rule:
**a grouping confers no authority beyond its members** — each member is an ordinary
standing grant that passed the ordinary approval gate, and the whole group is dropped
by connection-key rotation exactly like any grant. The ticket is a
*consent-and-narration* object, never a fourth authority class alongside grant, token,
and exposure. Effective access stays **granted ∧ exposed**, per capability, enforced
live at the pipeline.

## Execute inside a ticket — partly answered (ADR-023)

The `execute → once` ceiling was originally stated as structural: an execute capability
never rides a standing grant, not even under an admin-supplied trust-window
([the trust model](/concepts/trust-model)). A full ticket model collides with it —
"organize this vault" may legitimately include a `claudecode.run` leg, and a ticket
that still pends on every execute is an incomplete ticket, while a ticket that
silently lifts the ceiling is a hole.

**ADR-023 partly answers this**: it relaxes `execute → once` from an absolute into a
**default with an owner override** — the owner may opt a *specific* execute capability
into a standing grant for a *specific* agent (default off, double-confirmed at
connect). That resolves the first constraint below in the strict, opt-in direction it
demanded; the *ticket* object itself is still not built. The constraints any future
ticket answer must satisfy remain:

1. Standing execute is never something the **agent** can choose or self-elevate to,
   and never a default — it exists only as a deliberate, warned, **per-agent +
   per-capability owner override** (ADR-023). The default floor (execute pends per
   use) is unchanged.
2. Any relaxation is **opt-in per capability** (the owner declares standing execute
   admissible for one agent), never a blanket ticket power.
3. A ticket-scoped execute never rides `until-revoked` beyond a bounded window unless
   the owner explicitly chose `until-revoked` in that per-capability opt-in.

## What the future ticket object adds (sketch, non-normative)

Materializable from the seams above, with no migration:

- **Lifecycle** — open (the approval act) → in-force → closed (user act, task end, or
  window expiry). "Closed" is the new state; S3 carries it as a window kind.
- **Boundary** — the task's scope constraints + context, which the bundle already
  groups.
- **Narration** — the Grants tab and the audit view grouped by ticket: one card per
  task, its members inside, its full call history joined via S1.

None of this is 1.0 work. The guarantee of this page is only: when it becomes work,
it is **assembly**, not surgery.
