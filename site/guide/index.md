---
title: Get running
description: Two decisions get you running — where the gateway runs, and who can reach it. Pick a cell, let your agent drive the setup, then watch the trust loop prove itself.
---

# Get running

Plexus is the **resource side**: a gateway you own that fronts the tools on your machine, so an
AI agent reaches them only through a default-deny, fully-audited boundary — never a raw key. That
model is identical everywhere. What you choose first is only **plumbing**: *where the gateway
runs*, and *who can reach it*.

So pick a cell below — the machine the gateway lives on, and how far its network reaches. Then, in
[**Watch the trust loop**](/guide/run-it), learn the one thing that never changes: how a call is
discovered, granted, invoked, and revoked.

**The fastest way in: let your agent set it up for you.** Pick your cell, copy the prompt, paste it
into Claude Code or Codex — it reads the real runbook and drives the whole setup, narrating each
step and pausing for your decisions and approvals.

<GetStartedSelector />

---

## What every setup shares

Two roles, kept straight throughout — this never changes across machines or wires:

- **You are the admin.** You hold the **connection-key**, the management credential; it
  authenticates the `/admin` console. **You never give it to an agent.**
- **The agent gets its own credential.** When you connect an agent, it enrolls for a durable
  **per-agent PAT** and calls with that — never the connection-key.

Reaching the gateway buys an agent nothing on its own: enrollment needs a code you minted, calls
need grants you approved, `execute` never rides a standing grant, and the connection-key appears on
no agent-reachable route. That's why publishing to a LAN or a tunnel is just reachability, not a new
trust story.

::: tip Platform
macOS (Apple Silicon or Intel) is the primary target; the Apple Calendar / Reminders sources are
macOS-only. A **headless Linux** gateway is verified end-to-end (Ubuntu + Bun, in Docker) and serves
the platform-portable sources — see the
[Linux runbook](https://github.com/nemori-ai/plexus/blob/main/docs/deploy-linux.md).
:::

New to the mental model? **[The concepts](/concepts/)** (Connector → Source → Capability,
provenance, the two clocks, the self-describing Floor) makes the rest click. The authoritative trust
boundary is **[the security model](/architecture/security-model)**.
