---
title: The trust model
description: Default-deny, the two clocks, provenance and sensitivity, and the execute-defaults-to-once rule — how Plexus decides what an agent may call.
---

# The trust model

This is a focused read on the one idea that governs everything Plexus does with an
agent's request: **an agent that can reach the gateway still has zero authority by
default.** For the whole mental model in context, read [the concepts](/concepts/)
first; this page goes deep on the trust machinery alone. For the adversarial view and
the credential boundary, see the [security model](/architecture/security-model).

---

## Default-deny is the whole promise

Reaching the gateway — even handshaking successfully — buys an agent *knowledge* of
what the owner authorized for it, never the right to call anything. A successful
handshake grants the agent's manifest — its owner-authorized subset, in complete
detail — and grants *nothing else*. The agent never learns the gateway has more than
what the owner selected for it. An agent that has never been granted a capability
is denied at `/invoke` with `grant_required`.

Authority is something a **human** grants: scoped to specific capabilities, time-boxed,
and revocable at any moment. It is never something the agent can take, infer, or
self-assert.

---

## Two clocks, not one

Plexus deliberately separates **how long your approval stands** from **how long a
single token lives**:

![The two clocks — the trust-window over short-lived scoped tokens](/diagrams/two-clocks.png)

- **Trust-window** — the lifetime of *your decision*. When you approve a grant you
  pick a window: `once`, `1h`, `1d`, `7d`, `until-revoked`, or a `custom` duration.
  Until that window ends (or you revoke), the agent does not have to re-ask. This is
  the **standing grant**.

- **Scoped token** — the **blast radius**. Every actual call carries a short-lived
  bearer token, default **15 minutes** (`DEFAULT_TOKEN_LIFETIME_MS`, clamped to
  `[1m, 60m]`). When it expires the agent silently re-mints a fresh one from the
  standing grant via `POST /grants/refresh` — **no connection-key, no re-prompt** — as
  long as the trust-window still stands. A leaked token is therefore worthless within
  minutes, even while the standing grant persists.

A `once` grant is special: it stands for exactly one use (`expiresAt = grantedAt`),
cannot be refreshed, and never short-circuits a future approval.

---

## Provenance — the 3-class organizing axis

![Provenance to default posture — first-party and managed reads auto-grant, every write or execute pends, and an extension's every verb pends](/diagrams/provenance-posture.png)

One fact governs how cautious Plexus is with a capability: its **provenance** —
where the capability came from. Trust follows origin.

| Provenance | Means | Default posture |
| --- | --- | --- |
| **first-party** | A reserved, in-process source (Apple Calendar/Reminders, Obsidian filesystem, Claude Code). | Read flows easily; write/execute still asks a human. |
| **managed** | A source *you* added through the trusted `/admin` UI (e.g. an Obsidian REST vault). Human-vetted at add-time. | Shares first-party **read** posture; write/exec still pends for a human. |
| **extension** | Wire-registered by an *agent* via `POST /extensions`. The strictest class. | **Any** verb pends for a human. |

A first-party calendar read and an agent-registered shell wrapper are not the same
risk, and Plexus never pretends they are. The gateway *stamps* provenance from the
source — an extension cannot impersonate a first-party id (those ids are reserved).

---

## Sensitivity — the derived risk tier

From `provenance + verb + transport`, the gateway computes a **sensitivity** tier,
purely for honest narration (so the UI and every agent describe the same risk):

- **low** — read on first-party / managed.
- **elevated** — write/exec on first-party / managed, *or* read on an extension.
- **high** — write/exec on an extension, *or* any `cli` / `local-rest` transport with
  write/exec.

Workflows roll up their members' sensitivity (the max wins).

---

## Standing-eligibility follows sensitivity, not origin (ADR-5)

Not every window is available for every capability. **Whether a grant can be *standing*
by default is decided by the capability's own sensitivity** — derived from
`provenance × verb` — never by where it came from:

- A **`read`** capability can be standing: once approved it takes a real window
  (first-party/managed default `7d`; `write` defaults to `1d`), so subsequent in-scope
  reads are frictionless until the window ends or you revoke.
- An **`execute`** (or otherwise **high-sensitivity**) capability defaults to
  **per-use** approval, capped at `once` — a floor no window *the agent* requests can
  lift. Running code (`claudecode.run`, `codex.run`) warrants a fresh human decision
  every time by default. The **owner** may opt a specific agent + capability pair into
  **standing execute** at connect time (default off, double-confirmed); once opted in,
  the grant rides a real window or `until-revoked`.

::: danger Execute is per-use by default — only the owner can lift it
The `once` ceiling on `execute` holds under any window the *agent* requests — the
agent can never lift it itself. Lifting it is a deliberate owner act: an explicit
per-agent, per-capability opt-in at connect time, default off and double-confirmed.
Absent that opt-in, an `execute` capability stays per-use even under an admin-supplied
trust-window; with it, the grant stands until the window ends or you revoke.
:::

Two more owner-side layers compose with the ceiling. **Real launch** is a
machine-level setting on the exec sources (console: What I expose → the source →
"Real launch"; audited on every flip): approving an execute call authorizes it, but
whether it *really* spawns the tool — spending your model quota — or performs the
honest record-mode dry-run is your machine's own switch, record-mode by default. And
exec results are **wire-redacted**: the calling agent gets `ok / launched / sandboxed /
output / exitCode`; the confinement diagnostics (jail path, machine layout, sandbox
argv) appear only in your audit record.

---

## The exposure gate — the owner's outer toggle

![The default-deny funnel — expose, then discover, then grant, then invoke; each gate narrows, and anything not passed is denied](/diagrams/exposure-gate.png)

Grants decide what an agent *may* call; **exposure (what-I-expose) is the owner's outer
gate** sitting in front of them. A capability the owner disables is invisible in
discovery, not grantable, and denied at invoke with `capability_unexposed` — enforced
**before** the grant check. So effective access = **granted ∧ exposed**: revoking
exposure cuts off a capability no matter what standing grants exist.

---

## Visible, revocable, honestly narrated

Standing grants are first-class and **visible from both sides**: the owner sees them in
the `/admin` **Grants** tab; the agent sees *its own* at `GET /grants`. Each row carries
the agent, the capability, the verbs, the provenance, sensitivity, the trust-window, and
the expiry.

- **Revoke at any time.** A human revokes from the **Grants** tab or via
  `POST /grants/revoke` with the connection-key — by `jti`, by `(agentId,
  capabilityId)`, or by `bundleId` for a whole task bundle. An agent may relinquish
  **its own** token by presenting that token and its `jti`.
- **Narration is gateway-authored, never agent prose.** The risk summary the human
  approves is written by the gateway. The agent's optional "why now" purpose is shown
  labeled *"the agent says:"*, is sanitized and truncated, and influences no decision.
  The agent can never spoof the risk summary.
- **Everything is audited.** Every handshake, grant, token, invoke, and revoke —
  including pre-dispatch *denials* — is recorded to an append-only local audit trail
  (`GET /admin/api/audit`), secrets redacted. Treat it as best-effort observability,
  not a tamper-evident ledger.

Behind these mechanics sit two instruments a human reasons with: the **badge** —
the agent's durable identity, the per-agent PAT — and the **ticket** — a
task-scoped consent, approved up front and revocable as one act. The task bundle is the
ticket's 1.0 form; where it goes next is locked as seams in
[authorization extensibility](/architecture/extensibility) (ADR-020).

---

## Where to go next

- **[Read this once](/concepts/)** — the full mental model this page zooms into.
- **[The compile model](/concepts/compile-model)** — how the launcher hides the
  enroll → handshake → grant → invoke chain while the gateway enforces authz live.
- **[The security model](/architecture/security-model)** — the two credentials, the
  threat model, and what Plexus does not protect against.
