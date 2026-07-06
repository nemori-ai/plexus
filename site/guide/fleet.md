---
title: Level 3 · A resource pool for a fleet
description: The enterprise direction — an always-on, neutral parent gateway fronts capabilities borne by many workload machines that dial out to it. Overview and where the full recipe lives.
---

# Level 3 · A resource pool for a fleet

**Who this is for:** the resources belong to a **team**, not a person. Instead of one
person's machine being the front door ([Level 2](/guide/home)), an **always-on, neutral
parent gateway** on cloud compute fronts capabilities borne by many **workload machines** —
a Mac, a Linux box, a CI runner — that each dial *out* to it. The agent talks only to the
parent; where a capability actually lives is a routing detail invisible to the authorization
model.

This is the direction the [federated mesh](/architecture/mesh) and the reserved enterprise
fields in [ADR-020](/architecture/extensibility) point at (`Attribution.principal` /
`policyRef` — "on whose behalf", "which policy rule"). It is the natural home for
role-scoped and policy-evaluated authorization on top of the same default-deny core.

::: warning Not for individuals
If you're one person publishing your own machine, you don't need any of this — the natural
gateway is *your own computer*, and the far simpler [Level 2 · home-gateway](/guide/home) is
the recipe (no cloud parent, no mesh, verified end-to-end). Come here when the resources are
a fleet's, not yours.
:::

## The shape

```
                         ┌──────────────────────────────────────────┐
   agent  ──── https ────┤   edge (your domain)  → parent gateway    │
                         └──────────────────────────────────────────┘
                                        ▲ the parent dials nothing inbound
                                        │
                         ┌──────────────┴───────────────┐
                         │  always-on PARENT (cloud)     │  holds grants, runs the
                         │  neutral: bears no resources  │  authorizer, sinks audit
                         └───────────────────────────────┘
                             ▲                         ▲
              dials OUT       │                         │       dials OUT
             ┌────────────────┴─────┐      ┌────────────┴───────────────┐
             │  workload: a Mac     │      │  workload: a Linux box      │
             │  (codex, a vault…)   │      │  (sysinfo, a service…)      │
             └──────────────────────┘      └─────────────────────────────┘
```

Each workload dials a persistent, mutually-authenticated tunnel to the parent — **no inbound
port on any workload host** (NAT-friendly). Authority terminates at the parent: an invoke
forwarded to a workload is already authorized, and the workload re-checks only its *local*
gates (exposure, schema, health). Each gateway keeps its own authoritative audit; workload
events bubble up to the parent's mirror. The full model is the
[federated mesh](/architecture/mesh).

## The full recipe

The flagship example ships this topology end to end — a cloud agent scans a Linux box over
the mesh, hands the log to Codex on a Mac workload, writes the verdict into a vault, all
owner-approved, with a per-host audit split and a fail-closed revoke:

**→ [`examples/mesh-security-audit/cloud`](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit/cloud)**
— an always-on parent on Fly.io + a Cloudflare Tunnel edge on your own domain, with Mac and
Linux workload children.

::: tip Honest status
The recipe is complete and every `PLEXUS_*` flag is cross-checked against the runtime, and the
join → mount → revoke flow is the same one the [local hero topology](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit/local)
verifies end-to-end. But the **cloud** path needs *your* Fly + Cloudflare accounts (it costs
money) and has not been run end-to-end by us — the risk is entirely in the edge/compute
environment, not in Plexus's mechanism. Treat it as a production template you complete, not a
one-click demo.
:::

## Next steps

- **[The federated mesh](/architecture/mesh)** — the developer-facing code map (primary vs
  proxy, the tunnel-trust boundary, audit bubbling).
- **[Authorization extensibility](/architecture/extensibility)** — the seams (ticket/badge,
  `principal`/`policyRef`) that grow this into enterprise authorization.
- **[The security model](/architecture/security-model)** — the authoritative trust & auth model.
