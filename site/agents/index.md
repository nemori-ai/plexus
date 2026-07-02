---
title: How an agent uses Plexus
description: Once connected, a coding agent drives everything through one launcher — enroll once, list to discover, then invoke by capability id. The command is its complete and only interface.
---

# How an agent uses Plexus

This page is for the agent — or the person configuring one. It assumes you have
already been **connected**: an owner ran "Connect an agent," granted you a starting
capability set, and handed you a one-command install that carried a one-time
enrollment code. If that hasn't happened yet, start at
[Connect an agent](/guide/connect-an-agent).

Once the plugin is installed you have exactly one interface: a
**version-isolated launcher named `plexus-<agentId>`**. It bundles its own engine
and bakes in your `PLEXUS_AGENT_ID`, so two agents on one host never collide and
each launcher pins its own version. There is never a global `plexus` on the call
path.

::: tip The one rule
The launcher is your **complete and only** interface. Drive every interaction
through `plexus-<agentId> …`. Never hand-roll HTTP against the gateway, never guess
an auth header, never try to mint or read a token. The command already encapsulates
the sanctioned `enroll → handshake → grant → invoke` flow — **if something can't be
done through the command, it isn't authorized that way**, and the gateway will
reject the attempt.
:::

## The three verbs

<!-- DIAGRAM: the agent lifecycle through the launcher — `enroll` (once, redeem code → PAT) → `list` (discover: callable-now vs needs-approval) → `<capabilityId>` (invoke); the launcher hides redeem→PAT→handshake→token→invoke -->

### `plexus-<agentId> enroll` — once

```
plexus-<agentId> enroll
```

The first-run bootstrap. It redeems the one-time enrollment code for your **durable
per-agent PAT** (`plx_agent_…`) and stores it yourself, in your own paradigm
(e.g. an `.env`), `0600`. The code is single-use and dies on redemption; the PAT is
returned exactly once and is your identity from then on. You run this exactly
**once** — every later session starts authenticated from the stored PAT.

### `plexus-<agentId> list` — to discover

```
plexus-<agentId> list
```

The discovery verb, and how you orient before you act. It enumerates *your*
capabilities, split into two groups:

- **callable-now** — capabilities you hold a standing grant for. Invoke them
  directly.
- **needs-approval** — capabilities that will pend for the owner the first time you
  ask (every `write`/`execute`, and anything on an extension source).

Use `list` instead of guessing capability ids. It is the ergonomic front for what
the launcher can already tell you about itself — a projection over the
always-present, self-describing Floor.

### `plexus-<agentId> <capabilityId>` — to invoke

```
plexus-<agentId> fs.read '{ "path": "notes/plexus.md" }'
```

Invoke a capability by its id. Under the hood the launcher performs the whole
`PAT → scoped-token → invoke` chain and hands you back the result; the plumbing
never enters your context. If a capability needs approval, the invoke surfaces a
structured pending state pointing at the owner's console — **you cannot mint your
own token**, and no error will ever suggest that you can.

## Why this shape

The launcher exists so you never have to reason about the wire. Its auth/invoke
core is rendered from a deterministic per-agent-type template and byte-verified
against the Floor at build time — it is not LLM-authored and cannot ship an
over-reaching auth path. Everything you can legitimately do is reachable through the
three verbs above; everything else the gateway refuses by design.

The skill that ships with the plugin is a *projection* over the Floor, not a
replacement for it — so even if the skill is stale, the gateway's live
authorization is the only thing that decides what actually runs. That is why you can
trust `list` and act on it directly.

## Going deeper

- [Connect an agent](/guide/connect-an-agent) — the owner-side flow that produced
  your install command.
- [The compile model](/concepts/compile-model) — why the resource onboards *you*,
  in your own idiom, instead of making you learn a protocol.
