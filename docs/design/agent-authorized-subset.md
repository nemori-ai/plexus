# The Authorized Subset — an agent's world is exactly what the owner granted it

> Developer/design-facing. Audience: someone implementing (or reviewing) the shift from
> "expose-all + agent self-services grants" to "the owner declares each agent's authorized
> capability subset, and the agent sees + uses only that." Status: **IMPLEMENTED (ADR-023,
> 2026-07-08)** — this was the implementation blueprint; the shipped code follows §3–§6.
> Paths are relative to `packages/` unless noted.
>
> The one-sentence version: **an agent never learns that Plexus has more than what it was
> granted. Its discovered surface IS its authorized subset — framed to it as "the
> capabilities Plexus authorized you to access," full stop.**

## 1. Why — the two pain points + the security gap

Today three concerns live in three separate layers that don't line up:

- **Exposure** (`What I expose`) — the owner enables/disables capabilities. Owner-facing.
- **Grant** (per-agent) — an agent requests grants; the `confirm-risky` authorizer
  **auto-allows low-risk first-party reads** and **pends** writes/executes
  (`auth/authorizer.ts`).
- **Discovery** — the agent sees the **full exposed catalog** (`.well-known` capability
  summaries in `core/well-known.ts`) and the full manifest at handshake.

Because discovery shows the whole catalog while grant is a subset, three bad things follow:

1. **See-but-can't-use.** The agent discovers capabilities it has no grant for — dead
   cognitive load for the integrator; a surface it can't act on.
2. **Silent read acquisition.** An agent can bulk `PUT /grants` the whole catalog and
   **auto-receive every first-party read with no human in the loop** — a form of
   self-authorization for reads (the exact thing Plexus exists to stop, leaking through
   the low-friction read door). Observed in the field: one bulk request minted a wall of
   `grant.allow` reads the owner never approved.
3. **Surprise pends.** The agent later uses something → a `grant.pending` pops up →
   the owner is confused ("when did *this* agent ask for *that*?").

Plus a latent one: **pre-auth enumeration** — `.well-known` advertises the whole catalog to
anyone on loopback before they've enrolled.

## 2. The model — three layers, three audiences

| Layer | Audience | Mental model |
| --- | --- | --- |
| **What I expose** | **owner** | "What Plexus is / which capabilities are enabled here." The config surface. |
| **Agent permission config** (at connect) | **owner** | Pick this agent's authorized subset from all exposed capabilities. Default-grant ones pre-checked; add or remove any. |
| **What the agent discovers** | **agent** | "This is the list of capabilities Plexus authorized you to access." Self-contained. |

The agent **never needs to know**: that Plexus has other capabilities it can't use, that
other agents may hold other capabilities, or that "more could be requested." None of it is
surfaced. Even a one-capability agent has a trivially legible world.

## 3. Mechanics

### 3.1 `What I expose` — add a `default-grant` axis (owner-only)

Each capability gains an owner-set flag, orthogonal to the existing exposed/disabled toggle:

- **exposed** — enabled at all (unchanged; `state.exposure.isDisabled`).
- **`default-grant`** — pre-checked when the owner connects a new agent. The owner marks the
  sensible defaults (e.g. the read/list capabilities of the sources they want any agent to
  have). Persisted alongside exposure.

`default-grant` is a *default for the connect UI*, never a runtime authorization by itself —
an agent is authorized a capability only by the connect selection (§3.2), never by this flag
alone.

### 3.2 Connect = declare the authorized subset

The connect wizard's Capabilities step (`web-admin/src/App.tsx`, `admin.ts`
`POST /api/agents/connect`) becomes the single authoritative place the owner defines an
agent's world:

- `default-grant` capabilities are **pre-checked**; the owner can add any other exposed
  capability or remove a default. **This selection IS the agent's authorized subset.**
- **Read / list / write** authorized here → **standing** grants (frictionless; the owner
  already decided — no per-use approval). This makes `write` standing on purpose (a change
  from today's "writes pend for approval").
- **Execute** (`claudecode.run`, `codex.run`, …) → **default per-use** (the `execute→once`
  ceiling stays the default). **But** the owner may opt a specific execute capability into
  **standing ("unlimited use")** for this agent — **default OFF**, gated behind a
  **double-confirm warning** (see §4). Un-opted execute stays per-use.

Growing an agent's subset later is an **owner action in the console** (re-open its
permission config) — never an agent action.

### 3.3 `.well-known` — strip the catalog, keep the lifecycle

`core/well-known.ts` `buildWellKnown` currently ships `capabilities: [...summaries]`. Remove
that. Pre-enroll, unauthenticated `.well-known` advertises only:

- gateway identity + protocol version,
- the **lifecycle endpoints** (`enrollmentUrl`, `handshakeUrl`, `grantsUrl`, `invokeUrl`, …)
  and their request shapes,
- a one-line pointer: *"After you enroll and handshake, you receive the list of
  capabilities Plexus has authorized you to access."*

Security win: no capability enumeration before a caller has proven identity.

> **Naming (open):** the step that returns the authorized list is `handshake`. Options:
> (a) keep `handshake` and let `.well-known` frame it ("handshake → your authorized list"),
> or (b) rename it to something that says "get my capability list." Leaning (a) — `handshake`
> is an established protocol term and renaming is churn; the framing carries the meaning.

### 3.4 Handshake / manifest — scoped to the subset, reframed

`handlers.ts` handshake → `core/manifest.ts` `buildManifest` currently returns all exposed
entries. Scope it to **the agent's authorized subset only** (join the agent's grants).
Frame the manifest to the agent as **"the capabilities Plexus authorized you to access"** —
no catalog, no "requestable elsewhere," no other-agent concepts.

### 3.5 `PUT /grants` — in-subset mints, out-of-subset **denies**

`grant-service.ts` / `auth/authorizer.ts`:

- **In-subset** request → mint. Standing read/write → immediate token. Execute → per-use
  pend (unless the owner opted it standing per §3.2, then immediate).
- **Out-of-subset** request (a capability the agent was never authorized — which it also
  can't see) → **DENY**, not pend. This kills both the silent-auto-read door and the
  surprise-pend, and treats an out-of-band / scanning-attack endpoint hit as the attack it
  is. No owner card, no auto-grant. (Contrast today's `confirm-risky`, which auto-allows any
  first-party read on request.)

The `confirm-risky` "auto-allow first-party reads on request" policy is therefore **retired**
as the agent-facing default: reads are frictionless because the owner *granted them standing
at connect*, not because a request auto-approves them.

### 3.6 The subset grows only via the console

There is no agent self-service. The owner edits the agent's permission config to add/remove
capabilities. (A later, opt-in "this agent may *request* additions" mode can be layered on
as an explicit per-agent privilege — the [[plexus-authz-ux-model]] north-star's ad-hoc mode
becomes an owner-granted privilege, off by default — but it is **not** part of this design.)

## 4. Invariant change — `execute→once` becomes default-with-owner-override

This design **relaxes a load-bearing, widely-documented invariant**. Today, ADR-5 states
`execute` capabilities can **never** be standing — an absolute, repeated in
`docs/README.md`, `docs/concepts.md`, `docs/security.md`,
`docs/design/authz-extensibility.md` (§"Deliberately undecided"), and
`docs/design/architecture.md`.

The new rule: **`execute→once` is the DEFAULT, not an absolute.** The owner may opt a
specific execute capability into standing for a specific agent, subject to:

1. **Default OFF** — a new agent never gets standing execute unconsciously.
2. **Deliberate owner action** — a per-capability-per-agent toggle in the permission config.
3. **Double-confirm warning** — the toggle spells out the blast radius ("this agent will be
   able to run `<cap>` on this machine without per-use approval, until you revoke").

Why this is coherent, not a hole:

- The **default posture is unchanged** — the security floor for a naïve owner is identical
  (execute still pends per use). Only a deliberate, warned owner action lifts it.
- It stays consistent with the *other* constraint the authz-extensibility doc already fixed:
  *"Any relaxation is opt-in per capability, never a blanket power."* This is exactly opt-in
  per capability. What changes is the framing in that doc's constraint #1 ("standing-
  eligibility … never a choice the admin can override") → it **becomes** an explicit,
  audited owner override.

**Downstream doc updates required when this ships:** qualify "execute never standing" →
"execute is per-use by default; an owner may opt a capability into standing (default-off,
double-confirm)" in `docs/README.md`, `docs/concepts.md`, `docs/security.md`,
`docs/design/authz-extensibility.md`, `docs/design/architecture.md`, and the DECISIONS
ledger (a new ADR superseding the absolute clause of ADR-5, referencing this doc).

## 5. Agent-facing framing (the copy that reaches the agent)

The agent's manifest + any instruction says only: **"These are the capabilities Plexus has
authorized you to access."** It never mentions a broader catalog, other agents, or a
request-more path. This is the same discipline as the in-context brief: state what IS,
never introduce a concept (like "the connection-key" or "the full catalog") the reader
doesn't hold — see [[positive-framing-not-negation-emphasis]].

## 6. What changes in code (touchpoints, not full impl)

- `core/well-known.ts` — drop `capabilities` summaries; add the post-handshake pointer line.
- `core/manifest.ts` + `handlers.ts` (handshake) — scope entries to the agent's grants.
- `auth/authorizer.ts` + `core/grant-service.ts` — out-of-subset → deny; retire auto-allow-
  on-request; honor the per-agent standing-execute opt-in.
- `core/admin.ts` (`/api/agents/connect`, exposure/source-settings) — persist `default-grant`;
  connect grants the selected subset (standing for read/write; per-use or opted-standing for
  execute).
- `web-admin/src/App.tsx` — `What I expose`: the `default-grant` toggle. Connect wizard:
  pre-check defaults; the standing-execute opt-in with its double-confirm.
- Exposure store — persist the `default-grant` flag per capability.
- Tests — the well-known/manifest scoping, out-of-subset deny, standing-execute opt-in path.

## 7. Deferred / open

- **Ad-hoc request mode** (agent asks for an addition, owner approves) — deferred; if built,
  it is an explicit, per-agent, off-by-default owner-granted privilege, not a default.
- **`handshake` naming** — see §3.3 (leaning: keep the name, carry the meaning in `.well-known`).
- **Migration** for already-connected agents (their current grants become their subset;
  their manifest scopes on next handshake).
