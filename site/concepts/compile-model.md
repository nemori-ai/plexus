---
title: The compile model
description: The self-describing Floor and the per-agent compiled plugin as a projection over it — the per-agent plexus launcher, and why the command is the agent's only interface.
---

# The compile model

Plexus doesn't stop at making your tools reachable. It hands each agent "here is
exactly how *you* call *these* capabilities," compiled into that agent's native idiom
and installed. This page is the focused read on how that works. For the whole mental
model in context, start with [the concepts](/concepts/).

::: tip Why this exists
Even a perfectly self-describing surface still makes a cold agent **learn a novel
protocol on the fly** — integrators know MCP and REST; they've rarely seen a
well-defined resource that explains how to use *itself*. The fix isn't a better spec.
It's **compiling the resource into the agent's native idiom and handing it over
installed** — so the agent doesn't *figure out* Plexus, it gets handed a native command.
:::

---

## The Floor — the always-present source of truth

The **Floor** is the always-present, self-describing resource surface:

- `GET /.well-known/plexus` — the capability catalog + `requestShapes` + the auth /
  enrollment advertisement,
- per-capability `io` (JSON-Schema input/output),
- attached `how-to-use` **skills** (markdown guidance),

…over plain HTTP (or MCP). **It works for *any* agent with no artifact installed** —
enroll, handshake, grant, and invoke are all discoverable from it. Nothing an agent
needs is hidden behind bespoke tooling. This is the source of truth; everything else is
a view over it.

The Floor even self-describes its own bootstrap: `.well-known/plexus` advertises the
`auth.enrollment` block (the redeem URL/method, `body.code`, `success.pat`, the
`patStorage` instruction, the `errorCodes`), so a **skill-less** agent can self-enroll
from the Floor alone and construct calls straight from `.well-known`.

---

## The compiled plugin — a projection, never a replacement

On top of the Floor, Plexus **compiles a per-agent artifact** (v1: a Claude Code
plugin) that makes the same capabilities feel native to that specific agent. The
artifact is a **projection over the Floor — a cache/shortcut, never a replacement.**

![The self-describing Floor, and the per-agent compiled plugin projected over it](/diagrams/floor-projection.png)

Two invariants keep the projection honest:

- **Additive, never replacement.** The Floor always works for any agent over any
  transport. No Claude Code / Codex present → generate nothing, fall back to the Floor.
- **Staleness is safe.** Because a skill is a projection and the gateway enforces authz
  **live**, a stale or mis-generated skill can *never* exceed the Floor's authority.
  Worst case is cosmetic: it mentions a revoked capability → the invoke fails at the
  gateway; or it misses a newly-exposed one → `list` surfaces it anyway. Auto-update is
  therefore a *freshness/UX* feature, not a *safety* one.

---

## The `plexus-<agentId>` launcher

The compiled plugin ships a **version-isolated per-agent launcher** that hides the
entire `enroll → PAT → handshake → token → invoke` chain — the agent sees only a native
command, never the plumbing. It is **`plexus-<agentId>`** (its own bundled engine + a
baked-in `PLEXUS_AGENT_ID`), **never** a bare global `plexus`, so two agents on one host
never collide and each pins its own engine version.

Its subcommands are the agent's entire vocabulary:

- **`plexus-<agentId> enroll <code>`** — redeem the one-time code → PAT → self-store
  (first run only).
- **`plexus-<agentId> list`** — the **discovery verb**: enumerate this agent's
  capabilities, split into **callable-now** (standing-granted) vs **needs-approval**.
  This is how an agent orients before it acts, instead of guessing capability ids —
  including any capability exposed *after* the plugin was compiled (the Floor is live;
  the projection just caches it).
- **`plexus-<agentId> <capabilityId> [args]`** — invoke a capability (e.g.
  `plexus-<agentId> obsidian.vault.read Welcome.md`).

Three-tier progressive disclosure runs through it: a one-liner always in context → the
skill body (guidance, including agent-native key-management advice) → the launcher whose
internals never enter the agent's context.

---

## The command is your only interface

::: danger A hard rule the compiled skill states outright
Drive **every** interaction through `plexus-<agentId> …`. **Never** hand-roll HTTP
against the gateway, **never** guess an auth header, **never** try to mint or read a
token. The command already encapsulates the sanctioned auth flow; anything else is both
unnecessary and an over-reach the gateway will reject.
:::

This directly answers the failure mode a cold agent falls into: faced with a vague
error, it tries to forge its own credential or read an on-disk key. With the launcher,
there is exactly one advertised forward path — the audited, owner-approved one.

Two guarantees make trusting the command safe:

- **The auth/invoke core is templated, never LLM-authored.** It is rendered from a
  **deterministic per-agent-type template** filled from the Floor's `requestShapes` /
  `io` — never improvised. (An LLM writing the auth path could ship an over-reach
  tutorial; so an LLM may write only the pedagogical shell — task-framing, examples —
  never the mechanics.)
- **No durable secret is ever baked into the artifact.** A build-time verifier
  (`integration/verify-plugin.ts`) checks a rendered plugin against the Floor across
  four axes: the sanctioned auth core is byte-identical, no secret is baked in, only
  advertised/granted capabilities are referenced, and the sanctioned
  enroll/handshake/invoke flow is used. Only the short-lived, single-use enrollment code
  rides the install.

---

## How it fits the credential boundary

The launcher exists **because** the `connection-key` is **admin-only** and each agent
authenticates with its **own** per-agent PAT. Skill generation is an **admin-time,
admin-host** act: it happens in the config/management phase, decoupled from the call
path — no live CLI-driving in a Connect flow, no runtime latency at invoke. The blast
radius of a leaked artifact is bounded to one agent's pre-granted capabilities,
independently revocable — see the [trust model](/concepts/trust-model) and the
[security model](/architecture/security-model).

Extensions are **durable across restarts**: an added source/capability is written to
`~/.plexus/extensions.json` and replayed at boot, so it survives a gateway restart
rather than evaporating with process memory.

---

## Where to go next

- **[Read this once](/concepts/)** — the full mental model, including the two-tier
  self-describe protocol this page builds on.
- **[The trust model](/concepts/trust-model)** — default-deny, the two clocks, and why
  execute can never be standing.
- **[Connect an agent](/guide/connect-an-agent)** — see the launcher drive a real
  Claude Code / Codex agent end to end.
