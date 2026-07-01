# Agent-Native Capability-Skill Compilation — Domain Model

> The next epic after the federated mesh + integration-legibility work. SSOT for the
> "self-integrating resource" feature. Grounded in a grill-me interview (2026-07-01);
> §8 is the resolved-decisions (ADR) ledger. Same doc-规格 as `federated-mesh-domain-model.md`.

## 0. The reframe (why this exists)

The integration-legibility blind tests proved the problem empirically: even a 10/10
self-describing surface still makes a cold agent **learn a novel protocol on the fly** —
"integrators only know MCP/API; they've never seen a well-defined resource that explains
how to use *itself*." The fix is not a better spec. It is **compiling the resource into the
agent's native idiom and handing it over installed** — so the agent doesn't *figure out*
Plexus, it gets handed "here is exactly how YOU (Claude Code) call THESE capabilities."

**Reframe: resources stop being *integrated* and start *onboarding the agent* — "self-integrating
resources."** Plexus stops being only accessibility + audit and becomes the compiler/distributor
that translates any resource into any agent's most-native form. That compile+distribute layer,
on top of neutrality + long-tail aggregation, is the real moat.

## 1. Domain vocabulary (aggregates)

- **Floor** — the always-present self-describing resource surface: `.well-known/plexus`
  (capability catalog + `requestShapes` + per-cap `io` schemas) + `how-to-use` skills,
  over any transport (http/MCP). Works for *any* agent with no artifact. Just hardened
  (integration-legibility epic). **This is the source of truth.**
- **Agent-integration** — an admin-provisioned binding of `{ agentId, selected cap-set,
  target agent-type }`. Created by "Connect an agent." The unit a skill is compiled for.
- **Enrollment code** — a one-time, short-lived, single-use 256-bit secret the admin issues
  when connecting an agent (an "email-verification-code" for the agent). Bootstraps the PAT.
- **Per-agent PAT** — the durable bearer credential the agent redeems the enrollment code for,
  and self-manages (its own paradigm, e.g. `.env`). The agent's identity from then on.
- **Compiled skill package** — the per-agent-type artifact (v1: a Claude Code plugin dir) that
  projects the selected caps into that agent's native idiom. Contains thin call-scripts that
  encapsulate auth+invoke, a skill/guidance layer, and the enrollment bootstrap.
- **Template library** — hand-authored, per-agent-type templates (CC template first) that
  encode *that agent's best practice*. Deterministically filled from the Floor + cap-set.

## 2. Invariants (treat like mesh Inv A-G)

- **Inv I — Admin-time / admin-host.** Skill generation is what the user-as-administrator does
  in the config/management phase, on the admin machine. Decoupled from the calling side (no
  live CLI-driving in a Connect flow, no runtime latency/non-determinism on the call path).
- **Inv II — Additive projection, never replacement.** The Floor always works for any agent via
  any transport. A skill is a *compiled projection* over the Floor — a cache/shortcut, never a
  replacement. No CC/Codex present → generate nothing, fall back to the Floor.
- **Inv III — Per-agent credential (security boundary).** The `connection-key` is **admin-only**;
  agents never see it. Each agent authenticates with its **own** PAT → the blast radius of a
  leak is one agent's pre-granted caps, independently revocable. This is *the* security boundary.
- **Inv IV — Through-the-primary equivalence.** Access through the primary gateway is
  **origin-agnostic**: whether a capability is served locally or routed to a mesh node is a
  routing detail, invisible to the agent, and irrelevant to the authz model.
- **Inv V — Staleness is safe.** Because a skill is a projection and the gateway enforces authz
  **live**, a stale or mis-generated skill can never exceed the Floor's authz. Worst case is
  cosmetic (mentions a revoked cap → the invoke just fails at the gateway; or misses a new one).
  ⇒ auto-update is a *freshness/UX* feature, not a *safety* feature.
- **Inv VI — Templated auth core.** The auth/invoke mechanics inside any generated artifact are
  **deterministically templated and verifiable against the Floor — never LLM-authored.** (The
  blind tests showed agents get tempted to forge tokens / read on-disk keys when the path is
  unclear; an LLM writing the auth path could ship an over-reach tutorial.) LLM (v2) may write
  only the pedagogical shell (task-framing, examples), never the mechanics.

## 3. Auth model (the load-bearing change)

Today the agent-facing surface authenticates with the shared `connection-key` + a self-asserted
`agentId`. This epic upgrades it to a **per-agent enrollment credential**, universally:

1. **Provision (admin-time).** "Connect an agent" → mint `{ agentId, one-time enrollment code }`
   + grant the selected cap-set to `agentId` (this grant IS the human approval, done once,
   admin-time — Inv I). Grants are **standing** (owner picks the trust window per cap).
2. **Redeem (first run, calling side).** The agent presents the one-time code → receives its
   durable **PAT** → stores it (its own paradigm). Single-use: the code dies on redemption.
3. **Call.** The agent authenticates every call with its PAT (replacing the connection-key at
   `handshake`; the PAT proves the `agentId`, so agentId is no longer merely self-asserted).
   Standing grants **short-circuit** approval → instant scoped token → invoke.
4. **Revoke / loss.** Admin revokes an agent by killing its enrollment row (all its access dies,
   nothing else affected). Lost PAT → admin re-issues a one-time code.

**Reuse:** the mesh `enrollment.ts` primitive (mint one-time 256-bit token → redeem → durable
enrollment ledger, token-is-the-nonce) is exactly this shape — applied to HTTP agents instead of
proxy gateways. `connection-key` reverts to a pure admin/management credential.

**Standing grants (Inv IV):** the admin grants the whole selected cap-set at connect-time, local
and mesh caps alike — all standing. `once`/per-use-approval is a per-cap **sensitivity** policy
(origin-independent); such a cap simply cannot be in a frictionless skill (for any origin).
*(Impl note: remove the current "mesh caps hardcoded to `once`" behavior — that conflated remote
with per-use.)*

## 4. The compiled skill artifact (Inv II + VI in the concrete)

**"Eat the ugliness."** The skill ships **thin encapsulated call-scripts** that hide the entire
`redeem → PAT → handshake → token → invoke` chain; the agent sees only a native command
(`plexus read <path>`), never the plumbing. Three-tier progressive disclosure: a one-liner always
in context → the skill body (guidance, incl. the agent-native key-management advice) → a call
script whose internals never enter the agent's context.

- The **auth/invoke core** of every script is rendered from a **deterministic per-agent-type
  template** filled from the Floor's `requestShapes`/io — never improvised, never LLM'd (Inv VI).
- **skill ↔ Floor equivalence** is guaranteed by construction (the mechanics ARE the Floor's
  flow rendered) and **verifiable**: the hardened `.well-known` is the *oracle* — a build-time
  check asserts a generated skill uses the sanctioned flow, reads the local PAT (never bakes it),
  and references only caps the integration actually granted.
- **"量身定制" (v1)** = the per-agent-TYPE template captures that agent's best practice (precise
  where precise helps, shortcut where a shortcut helps). Per-user-intent LLM personalization is
  v2 (local-agent-as-compiler, prose-only).

## 5. End-to-end flows

**Bespoke (Claude Code):**
```
[admin·config]  Connect an agent → type=CC + select caps (grants them to agentId, standing)
                → mint one-time code → deterministically compile CC plugin from Floor + cap-set
[deliver·P]     admin console shows a copy-able ONE-COMMAND install carrying the one-time code
[agent·first]   run it → plugin lands in project, reload → skill redeems code → PAT → self-store
[agent·use]     `plexus read x` … → script does PAT→token→invoke, plumbing hidden
```
**Generic fallback (deepagent / any agent, Inv II):** the admin still provisions
`{ agentId, one-time code, granted cap-set }`, but **no skill is generated**; the agent
self-enrolls from the **Floor** (which now self-describes the redeem-code→PAT step — §9) and
constructs calls from `.well-known` directly. Same auth path (its own PAT), no bespoke layer.

## 6. v1 scope + acceptance

**In v1:** the full loop for **Claude Code (bespoke)** + **deepagent (generic base-mode)**;
per-agent PAT enrollment as universal agent auth; caps = any standing-granted (local or mesh);
deterministic template assembly.
**Deferred to v2:** auto-update / living-integration (Inv V — safety doesn't need it; v1 skill is
a point-in-time snapshot, regenerate from admin on change); LLM per-intent personalization;
Codex + other agent types.
**Acceptance (the executable proof of Inv II):** two cold blind e2e paths BOTH pass —
(a) Claude Code installs the bespoke plugin, reloads, works with ~zero learning; (b) deepagent
integrates via the generic base-mode. **Both authorization paths (each its own PAT) truly e2e.**

## 7. Where it sits on what exists

The Floor (`.well-known` + `requestShapes` + `how-to-use` + io) — hardened last epic — is
**exactly this compiler's input**. Existing `how-to-use` skills are the template seeds. The mesh
`enrollment.ts` is the reusable enrollment primitive. So this epic is mostly **new surface on
top of proven parts**, plus one real change: agent-facing auth moves from shared connection-key
to per-agent PAT.

## 8. Resolved-decisions ledger (ADR)

- **ADR-1 = Inv I** — admin-time / admin-host generation, decoupled from the call path.
- **ADR-2 = Inv II** — strictly additive projection over the Floor; graceful fallback.
- **ADR-3 = Inv III** — connection-key admin-only; per-agent PAT; per-agent blast radius + revoke.
- **ADR-4** — auth bootstrap: one-time code → durable per-agent bearer PAT → self-managed →
  revocable; lost → admin re-issues a code. Reuse mesh enrollment primitive. *(Chose bearer PAT
  over a keypair for v1: matches the operator's `.env` mental model + simplest; keypair =
  documented v2 hardening.)*
- **ADR-5 = Inv IV** — through-primary equivalence; admin grants the whole cap-set at connect-time
  (all standing, local≡mesh); `once` is per-cap sensitivity, not origin. Remove mesh-forced-`once`.
- **ADR-6 = Inv VI + artifact** — "eat the ugliness": encapsulated call-scripts, agent sees native
  commands; auth/invoke core templated + Floor-verifiable, never LLM'd.
- **ADR-7** — "量身定制" v1 = per-agent-TYPE deterministic template; per-intent LLM = v2, prose-only.
- **ADR-8** — delivery P: admin console shows a copy-able one-command install carrying the code.
- **ADR-9** — the Floor now self-describes the enrollment step (redeem code → PAT), so a skill-less
  generic agent can self-enroll + use base mode (makes the deepagent e2e path stand on its own).
- **ADR-10 = Inv V** — auto-update deferred (staleness is safe); v1 skill is a point-in-time snapshot.

## 9. Open implementation questions (for the skeleton, not product forks)

1. **PAT ⟷ existing flow**: PAT replaces `connection-key` at `handshake`; the rest
   (session → grant short-circuit → scoped-JWT → invoke) is unchanged. Confirm the handshake
   accepts a PAT and binds the session to the PAT's real `agentId` (rejecting spoof).
2. **The enrollment surface**: `POST /agents/enroll` (redeem code → PAT) + admin issuance in
   the console + the enrollment ledger (mirror `mesh/enrollment.ts`).
3. **Floor's enrollment self-description** (ADR-9): extend `.well-known` auth block / `requestShapes`
   with the "how to redeem your code → PAT" step.
4. **Template engine + where templates live**; the deterministic CC-plugin renderer from the Floor.
5. **The build-time skill↔Floor verifier** (uses `.well-known` as the oracle).
6. **The `GET /integration/<agent>` endpoint** (mgmt-gated; serves the install command/artifact;
   the auto-update channel is v2).
