# Plexus — developer guide

This is the front door to Plexus's documentation. It orients you, gets you running from
zero, and lays out a reading path that takes you from the core idea to the whole system —
in the order the pieces actually build on each other.

**Plexus is a local, user-installed capability gateway.** You (the owner) expose a few of
your own local capabilities — an Obsidian vault, a workspace directory, Apple Calendar,
running Claude Code — and an AI agent calls them *through Plexus* instead of being handed
raw keys and filesystem access. Plexus represents the **resource side**: it holds the
default-deny boundary, the per-agent identity, and the audit trail, so an agent stops
self-authorizing and starts asking.

Two audiences run through every doc — keep them straight:

- **The admin** (you, the owner): exposes capabilities, connects agents, approves grants.
  Holds the **connection-key** — the management credential and the trust boundary.
- **The agent** (the AI tool): discovers and calls capabilities. Holds its **own per-agent
  credential** (a PAT), never the connection-key.

---

## The idea in 60 seconds

- A **capability** is one narrow, named action — `obsidian.vault.read`, `workspace.write`,
  `claudecode.run`. It has a verb class (read / write / execute) and a sensitivity.
- Everything is **default-deny**. Exposing a capability makes it *discoverable*; it does not
  grant it. A human still approves every grant.
- Plexus **self-describes**: a public `.well-known/plexus` "floor" advertises every exposed
  capability, its input shape, and how to use it. Any agent — with or without a plugin —
  can read the floor and call in.
- For agents that have a native idiom (Claude Code), Plexus **compiles** a per-agent plugin:
  a projection *over* that same floor that makes the capabilities feel native. The floor is
  always the source of truth; the plugin is a cache/shortcut, never a replacement.
- Sensitive actions can't be pre-approved. **Execute capabilities can never be standing** —
  they are approved per use, every time (even the admin can't waive this).

If those five bullets land, the rest is detail. `docs/concepts.md` is where they're
explained properly.

---

## From zero — get it running

Follow **[`getting-started.md`](./getting-started.md)** for the full hands-on: install →
start the gateway → expose a source → connect your first agent → watch a real call get
approved. The shape of it:

```bash
bun install
bun run start --vault ~/my-vault        # gateway on 127.0.0.1:7077, console at /admin
```

Then, in the console (`http://127.0.0.1:7077/admin`), **Connect an agent**: name it, pick a
starting capability set, and copy the one-command install. That's the whole onboarding — no
key-pasting.

---

## How an agent connects (the shipped flow)

This is the path a real agent travels. Every step is code, not aspiration.

1. **Admin connects the agent** — the console wizard (or `POST /admin/api/agents/connect`)
   names the agent, grants a starting cap-set as *standing*, and mints a **one-time
   enrollment code** (`plx_enroll_…`, single-use, ~15 min).
2. **One-command install** — `GET /integration/:agentId` serves a copy-able command backed
   by a public `install.sh`. It materializes a per-agent Claude Code plugin, redeems the
   code for a **durable per-agent PAT** (`plx_agent_…`, stored `0600`), and deletes the code.
3. **The agent calls** — through its bundled launcher **`plexus-<agentId>`**:

   ```bash
   plexus-<agentId> list                      # discover: what you can call now + what needs approval
   plexus-<agentId> obsidian.vault.read Welcome.md
   ```

   The launcher is version-isolated (it execs *its own* bundled engine, never a global
   `plexus`) and binds the agent's identity. **The command is the agent's complete and only
   interface** — it never hand-rolls HTTP, never touches enrollment/handshake by hand, never
   guesses at auth. The credential is handled for it. If something can't be done through the
   command, the agent isn't authorized to do it that way — it asks the user or requests a grant.

**Two credentials, never conflated:**

| | held by | what it is | obtained |
|---|---|---|---|
| **connection-key** `plx_live_…` | the admin | management credential + trust boundary (rotate ⇒ revoke all) | printed by the gateway; read from `~/.plexus/connection-key` |
| **per-agent PAT** `plx_agent_…` | each agent | that agent's durable call credential, independently revocable | redeemed once from a one-time enrollment code |

The authoritative treatment is **[`design/security-model.md`](./design/security-model.md)**.

---

## Reading path — from first principles to the whole system

Read these in order; each uses the vocabulary the previous one established.

1. **[`concepts.md`](./concepts.md)** — the mental model. Connector → Source → Capability,
   provenance, sensitivity, the two clocks (token vs grant), the exposure gate, the
   self-describing floor + the compile projection. *Read this once and the rest clicks.*
2. **[`design/security-model.md`](./design/security-model.md)** — the trust & auth model,
   and the **single source of truth** for credentials: connection-key (admin) vs per-agent
   PAT, enrollment, the execute-never-standing ceiling (ADR-5), PAT-binds-real-agentId.
3. **The mesh** — Plexus federates across machines through a primary:
   - [`design/federated-mesh-domain-model.md`](./design/federated-mesh-domain-model.md) — the
     ubiquitous language, bounded contexts, and invariants.
   - [`design/mesh-model.md`](./design/mesh-model.md) — the same model mapped onto the
     enforcing code (file:line). The best "how it actually works" doc.
   - Subsystem deep-dives: [`networking-resilience`](./design/networking-resilience.md),
     [`mesh-health-reporting`](./design/mesh-health-reporting.md),
     [`linux-confinement`](./design/linux-confinement.md),
     [`capability-appliance`](./design/capability-appliance.md).
4. **The compile epic** (self-integrating agents) —
   [`design/agent-skill-compile-domain-model.md`](./design/agent-skill-compile-domain-model.md):
   how an admin-granted cap-set becomes a per-agent plugin over the floor, with the
   [`cc-plugin-artifact-spec`](./design/cc-plugin-artifact-spec.md) for the concrete artifact.
5. **The wire contract** — [`protocol/PLEXUS-PROTOCOL.md`](./protocol/PLEXUS-PROTOCOL.md):
   the endpoints, the enroll → handshake → grant → invoke loop, the frozen types.
6. **Extending it** — [`extension-authoring.md`](./extension-authoring.md) (the served,
   hands-on authoring guide) and [`extensions/EXTENSION-SPEC.md`](./extensions/EXTENSION-SPEC.md)
   (the normative reference).

**Do it, don't just read it** — the tutorials:
[connect-an-agent](./tutorials/connect-an-agent.md) ·
[create-an-extension](./tutorials/create-an-extension.md) ·
[first-party-sources](./tutorials/first-party-sources.md).

**Reference:** [`security.md`](./security.md) (the readable threat model — defers to
security-model.md) · [`sources/MANAGING-SOURCES.md`](./sources/MANAGING-SOURCES.md) ·
[`KNOWN-LIMITATIONS.md`](./KNOWN-LIMITATIONS.md) (the honesty ledger — what's verified vs pending).

---

## Where the code lives

| Path | What |
|---|---|
| `packages/runtime/` | the gateway — HTTP server, capability registry, grants, enrollment, sources, the integration/compile renderer (`src/integration/`) |
| `packages/web-admin/` | the admin console (React) served at `/admin` |
| `packages/protocol/` | the frozen protocol types (the wire contract's source of truth) |
| `tools/plexus-cli/plexus` | the zero-dep agent engine (`enroll` / `list` / invoke) that the compiled plugin bundles per-agent |
| `integrations/` | Codex integration (AGENTS.md-based); Claude Code is compiled per-agent by the gateway |
| `examples/` | runnable demos (min-agent, pomodoro-demo, mesh-demo, appliance, agent-view) |

To build on Plexus, start the gateway and read [`concepts.md`](./concepts.md); to hack on it,
read **[`../CONTRIBUTING.md`](../CONTRIBUTING.md)** for the monorepo layout, the build/test
gate, and the additive-only protocol rule.
