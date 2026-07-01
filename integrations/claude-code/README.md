# Plexus for Claude Code — generated per-agent by the gateway

> **This hand-written plugin is superseded.** The Claude Code integration is now
> **compiled per-agent by the gateway**, not hand-wired here.

To connect a Claude Code agent to Plexus, use the **Connect-an-agent** flow —
[`docs/tutorials/connect-an-agent.md`](../../docs/tutorials/connect-an-agent.md).
An admin picks the agent + a starting cap-set (the console wizard, or
`POST /admin/api/agents/connect`); the gateway then compiles that granted cap-set
into a ready-to-install Claude Code plugin and hands back a **one-command install**
(`GET /integration/:agentId`). The produced plugin ships:

- a **`plexus-<agentId>` launcher** — its own bundled, version-pinned engine, unique
  per agent so no global `plexus` can shadow it. It redeems a one-time enrollment
  code for the agent's durable PAT, then handshakes/grants/invokes — all inside the
  binary. The agent never sees a credential and never hand-rolls HTTP.
- a **compiled `use-plexus` skill** — a projection over the gateway's live,
  self-describing Floor, with the auth/invoke core templated (never LLM-authored).

The agent's whole interface is that one launcher: `plexus-<agentId> enroll <code>`
(once) → `plexus-<agentId> list` (what's callable now vs needs approval) →
`plexus-<agentId> <capabilityId> [args]`.

Do **not** re-add a hand-written `skills/use-plexus/SKILL.md` or a shared bare
`plexus` + connection-key path here — both contradict the compiled per-agent model
(command name, identity binding, and the credential rule). See
[`docs/design/security-model.md`](../../docs/design/security-model.md) and
[`docs/design/agent-skill-compile-domain-model.md`](../../docs/design/agent-skill-compile-domain-model.md).
