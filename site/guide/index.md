---
title: Get running
description: Choose your setup — Plexus runs the same trust model whether the agent and resources share one Mac, sit on two machines across a tunnel, or span a fleet.
---

# Get running

Plexus is the **resource side**: a gateway you own that fronts the tools on your machine, so
an AI agent reaches them only through a default-deny, fully-audited boundary — never a raw
key. That model is identical in all three setups below; what changes is **where the agent is
relative to your resources**.

**The fastest way in: let your agent set it up for you.** Pick a scenario, copy the prompt,
paste it into Claude Code or Codex — it reads the real runbook and drives the whole setup,
narrating each step and pausing for your decisions and approvals.

<GetStartedSelector />

Prefer to read first, or want the three scenarios side by side? Here they are — pick the one
that matches you and follow its walkthrough by hand.

<div class="level-cards">

### [Level 1 · Everything on one Mac →](/guide/local)

**The agent and your resources share one machine.** Nothing leaves the Mac. This is the
install baseline and the best place to *learn the model* — connect an agent, watch a read
flow and a write pend for approval, revoke.
<br>**Start here if** you're new to Plexus, or building/testing locally.
*Examples: `min-agent`, `mesh-security-audit/local`.*

### [Level 2 · Reach it from anywhere →](/guide/home)

**Your agent is on a *different* machine from your resources.** Publish your home gateway
under one hostname (a Cloudflare tunnel on your own domain — or any edge you bring) and let
your office Claude Code discover, enroll, and call home capabilities from anywhere. Reads
stand; the write pends for *you*; one revoke fails everything closed.
<br>**Start here if** your resources are at home and your agent is elsewhere.
*Example: `home-gateway` (verified end-to-end on a real domain).*

### [Level 3 · A resource pool for a fleet →](/guide/fleet)

**Resources belong to a team, not a person.** An always-on, neutral parent gateway fronts
capabilities borne by many workload machines that dial out to it — the enterprise direction.
<br>**Start here if** you're pooling capabilities across a fleet.
*Example: `mesh-security-audit/cloud` (overview + recipe).*

</div>

---

## What every setup shares

Two roles, kept straight throughout — this never changes across the levels:

- **You are the admin.** You hold the **connection-key**, the management credential; it
  authenticates the `/admin` console. **You never give it to an agent.**
- **The agent gets its own credential.** When you connect an agent, it enrolls for a durable
  **per-agent PAT** and calls with that — never the connection-key.

::: tip Platform
macOS (Apple Silicon or Intel) is the shipped target. The Apple Calendar / Reminders sources
are macOS-only. [Level 1](/guide/local) has the full prerequisites + install.
:::

New to the mental model? **[The concepts](/concepts/)** (Connector → Source → Capability,
provenance, the two clocks, the self-describing Floor) makes the rest click. The authoritative
trust boundary is **[the security model](/architecture/security-model)**.
