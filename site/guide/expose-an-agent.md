---
title: Expose an agent to other agents
description: The second use of Plexus — publish a coding agent (Claude Code, Codex) as a capability other agents call across machines, with every execution approved per use.
---

# Expose an agent to other agents

::: warning Sketch — full walkthrough coming
The trust loop this builds on is the same one in [Watch the trust loop](/guide/run-it). This page
is a skeleton of the second major use; the end-to-end recipe lands after the core guide.
:::

So far Plexus fronted your **files and tools**. But a running **coding agent** is itself a
capability. Machine A can expose its Claude Code (or Codex) execution entry point through Plexus, and
an agent on machine B can call it — a fan-out where one orchestrator drives many workers, each behind
its owner's gate.

## Why execution is the higher-stakes case

Reads can stand; a folder read is low-risk and you pre-decided it. **Execution never stands.** An
`execute` capability is approved **per use, every time** — it can never become a standing grant, not
even by you. Handing another agent the ability to *run code on your machine* is the sharpest edge
Plexus governs, so the gate stays in front of every single call, and the [Activity](/guide/run-it)
trail records each one.

## The shape

1. **Machine A exposes its coding agent** as an execute source — a `claudecode` / `codex` capability.
2. **Machine B's agent discovers and enrolls** exactly as in the core loop: a code you minted, a
   per-agent PAT, no raw keys.
3. **Every invocation pends for A's owner.** B asks; A decides; the run happens only after approval,
   and the exit is auditable.

## Where this goes

- **Multiple instances, one machine.** Expose an Opus entry point and a Sonnet entry point as
  distinct capabilities — the caller picks the worker by capability id, you gate each independently.
- **A pool for a fleet.** The same pattern, fronted by an always-on neutral gateway, is the
  team-scale direction.

**More to come.** Until this page is filled in, the mechanics — enrollment, per-use approval, the
audit trail — are exactly the [trust loop](/guide/run-it); only the capability being called changes
from a file read to a code run. See also [Connect an agent](/guide/connect-an-agent) and
[the security model](/architecture/security-model).
