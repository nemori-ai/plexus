---
title: How Plexus works inside
description: A map of the Plexus internals — the compile model, the federated mesh, the security spine, and the wire protocol — and where to read each one in depth.
---

# How it works inside

The [guide](/guide/) shows you how to run Plexus and the [concepts](/concepts/) give
you the mental model. This section is the engineer's floor below that: **what the
internals actually are, and how the load-bearing claims are enforced in code.**

Everything here rests on one shape. Plexus is a local, user-installed **capability
gateway**: a single loopback process that a human owns, that fronts the tools on
their machine, and that lets an AI agent reach those tools only through a
default-deny, fully-audited boundary — never by handing over a raw key. The four
areas below are how that single sentence is made true.

## The four internal surfaces

### The compile model — the self-integrating resource

A cold agent, even facing a perfect self-describing surface, still has to *learn a
novel protocol on the fly*. Plexus removes that step: it **compiles the resource
into the agent's own idiom and hands it over installed**. An always-present
**Floor** (`.well-known/plexus` + request shapes + per-capability schemas +
how-to-use skills) is the source of truth for any agent; on top of it, Plexus
deterministically renders a per-agent artifact (v1: a Claude Code plugin) that
projects the selected capabilities into that agent's native form.

The projection is a cache, never a replacement — a stale skill can never exceed the
Floor's live authorization, so the gateway stays the single enforcement point. Read
the [concepts / compile model](/concepts/compile-model) for the mental model, and
the DDD SSOT
[`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md)
for the full domain ledger.

### The federated mesh — one front door, many homes

A capability need not live on the same machine as the gateway the agent talks to.
A **primary** gateway (the agent's front door: it holds grants, runs the
authorizer, sinks audit) can mount capabilities borne by any number of **proxy**
gateways that live next to real services and dial a single persistent tunnel
outward — no inbound hole on a proxy host. The agent invokes a mounted capability
exactly as it would a local one; origin is a routing detail invisible to the
authorization model.

→ [The federated mesh](/architecture/mesh) — the developer-facing code map.

### The security model — two trust boundaries

There are exactly two trust boundaries, held by two different parties. The
**connection-key** is the owner's admin credential and agents never hold it. Each
**agent** authenticates with its **own durable per-agent PAT**, redeemed once from
a one-time enrollment code, so the blast radius of a leaked agent credential is one
agent's pre-granted capabilities — independently revocable. Sensitive actions can't
be pre-approved: running code (`execute`) can never ride a standing grant, not even
under an admin-supplied trust window.

→ [The security model](/architecture/security-model) — the authoritative trust and
authorization model, cited to code.

### The protocol — the wire contract

The stable, AI-native contract everything types off:
**DISCOVER → ENROLL → HANDSHAKE → GRANT → INVOKE**, at contract version `0.1.3`.

→ [The protocol](/protocol/) and its [decision log](https://github.com/nemori-ai/plexus/blob/main/docs/protocol/DECISIONS.md).

## Deeper design docs

These live in the repository — they are the design SSOTs behind the pages above:

- [`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md) — the mesh DDD SSOT (language + invariants A–G).
- [`agent-skill-compile-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/agent-skill-compile-domain-model.md) — the compile-model SSOT.
- [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md) — the containerization appliance ("expose a capability, not a system").
- [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md) — the seatbelt → bwrap exec-confinement mapping.
- [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) · [`networking-resilience.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/networking-resilience.md) · [`mesh-health-reporting.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/mesh-health-reporting.md) — mesh transport, resilience, and health.
