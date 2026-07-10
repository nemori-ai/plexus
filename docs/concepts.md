# Plexus Concepts — the mental model

Plexus is a **local capability gateway**. It runs on your Mac, **loopback by
default** — a non-loopback bind is opt-in and user-confirmed (LAN bind via
`network.json`; publishing under a tunnel-fronted hostname via `publicHostnames` /
`PLEXUS_PUBLIC_HOSTNAME`, see [`examples/home-gateway`](../examples/home-gateway/);
connection-key as the trust boundary) — and gives any AI agent a
single, AI-native protocol to **discover → understand → be granted → call** the
capabilities of the software you already use — your notes, your calendar, your
reminders, your tools. A federated multi-host topology is a documented design
direction (draft) — see
[`docs/design/federated-mesh-domain-model.md`](design/federated-mesh-domain-model.md).

This is the keystone document. Read it once and the rest of Plexus (the
[getting-started guide](getting-started.md), the [security model](security.md),
and the tutorials) will click into place.

---

## 1. Connector → Source → Capability

Everything in Plexus is organized along one spine. Three words, in Chinese, name
the three questions it answers:

| Layer | 中文 | The question | Example |
| --- | --- | --- | --- |
| **Connector** (连接器) | 怎么接 | *How* does Plexus connect to this kind of thing? | "Obsidian Local REST API", "Obsidian vault (filesystem)", "Claude Code (sandboxed)" |
| **Source** (源) | 接了什么 | *What* did you actually connect? | your specific vault at `~/Documents/MyVault`; your running REST plugin |
| **Capability** (能力) | 能干什么 | *What can an agent do* with it? | `obsidian.vault.read`, `apple-calendar.events.list` |

- A **Connector** is a *type* Plexus knows how to talk to. It is pure catalog
  data — it declares the config fields that drive the "Add…" form, the resulting
  transport, and a one-liner of what it exposes. It carries no secret and
  registers nothing on its own. Browse the catalog at
  `GET /admin/api/connectors`.

- A **Source** is a *configured instance* of a connector — the real thing you
  added. Sources are **managed**: you add / remove / enable / disable /
  reconfigure them at runtime, they **persist** to `~/.plexus/sources.json`, and
  they **hot-reload** into the live registry with no gateway restart. List them
  at `GET /admin/api/sources`.

- A **Capability** is one callable operation a source contributes — identified
  by a stable dotted id like `obsidian.vault.read` or
  `apple-calendar.events.list`. Each capability declares its input/output schema,
  the **verbs** it requires (`read` / `write` / `execute`), a human-readable
  `describe`, and — optionally — attached **skills** (markdown usage guidance an
  agent can read to learn how to use it well).

The same Obsidian *connector* (the Local REST API kind) can back many *sources*
(different vaults), each exposing the same *capabilities*
(`obsidian-rest.vault.{list,read,write}`).

### First-party capabilities ship in the box

Some sources are **first-party** — reserved, in-process, and present without any
setup beyond the underlying app's own permission grant (the workspace and
sandboxed-run sources need the owner to authorize a directory first):

| Source | Capabilities | Verbs |
| --- | --- | --- |
| `apple-calendar` | `apple-calendar.calendars.list`, `apple-calendar.events.list` | read |
| `apple-reminders` | `apple-reminders.lists.list`, `apple-reminders.reminders.list` | read |
| `apple-reminders` | `apple-reminders.reminders.create`, `apple-reminders.reminders.complete` | **write** |
| `workspace` | `workspace.list`, `workspace.read` (`workspace.how-to-use` skill) | read |
| `workspace` | `workspace.write` | **write** |
| `claudecode` | `claudecode.run` (`claudecode.how-to-use` skill) | **execute** |
| `codex` | `codex.run` (`codex.how-to-use` skill) | **execute** |

The Apple sources are **read-only by construction** for their list operations
(the underlying provider has no write path at all for calendar/list reads).
Reminders adds two **write** capabilities, which an agent can never self-grant —
see the trust model below.

---

## 2. The trust model — default-deny, scoped, time-boxed

Plexus's central promise: **an agent that can reach the gateway still has zero
authority by default.** Reaching the gateway, even handshaking successfully, buys
an agent *knowledge* of what exists — never the right to call anything. Authority
is something a human grants, scoped and time-boxed, and can revoke at any moment.

### Two clocks, not one

Plexus deliberately separates **how long your approval stands** from **how long a
single token lives**:

- **Trust-window** — the lifetime of *your decision*. When you approve a grant
  you pick a window: `once`, `1h`, `1d`, `7d`, `until-revoked`, or a `custom`
  duration. Until that window ends (or you revoke), the agent does not have to
  re-ask. This is the "standing grant."

- **Scoped token** — the **blast radius**. Every actual call carries a
  short-lived bearer token, default **15 minutes**
  (`DEFAULT_TOKEN_LIFETIME_MS`, clamped to `[1m, 60m]`). When it expires the
  agent silently re-mints a fresh one from the standing grant via
  `POST /grants/refresh` — **no connection-key, no re-prompt** — as long as the
  trust-window still stands. A leaked token is therefore worthless within minutes.

A `once` grant is special: it stands for exactly one use (`expiresAt =
grantedAt`), cannot be refreshed, and never short-circuits a future approval.

### Standing-eligibility follows sensitivity, not origin (ADR-5, execute relaxed by ADR-023)

Not every window is offerable for every capability. **Whether a grant can be
*standing* at all is decided by the capability's own sensitivity** — derived from
`provenance × verb` — never by where it came from:

- A **`read`** capability can be standing: once approved it takes a real window
  (first-party/managed default `7d`; `write` defaults to `1d`), so subsequent
  in-scope reads are frictionless until the window ends or you revoke.
- An **`execute`** (or otherwise **high-sensitivity**) capability is **per-use by
  default**, capped at `once` — a longer trust-window an agent proposes is ignored, and
  running code (`claudecode.run`, `codex.run`) is approved afresh every time. The one way
  to lift this is a **deliberate owner opt-in** at connect (per agent, per capability,
  **default-off + double-confirm**, ADR-023): the owner may grant a *specific* execute
  capability a standing window for a *specific* agent it trusts to run it unattended.
  Absent that explicit, warned action the `once` floor holds — a naïve owner never gets
  standing execute by accident, and an agent can never self-elevate to it.

So the trust-window picker offers a durable window for a read, but an `execute`
grant is `once` by default — the standing story is a property of the *capability*,
never something the agent can self-elevate, and standing execute exists only as a
deliberate, warned, per-agent owner override (ADR-023), never a blanket power.

### Provenance — the 3-class source-class (the organizing axis)

The single fact that drives *everything* about how cautious Plexus is about a
capability is its **provenance** — where the capability came from:

| Provenance | Means | Default posture |
| --- | --- | --- |
| **first-party** | A reserved, in-process source (Apple Calendar/Reminders, Obsidian filesystem, Claude Code). | Read flows easily; write/execute still asks a human. |
| **managed** | A source *you* added through the trusted `/admin` UI (e.g. an Obsidian REST vault). Human-vetted at add-time. | Shares first-party **read** posture; write/exec still pends for a human. |
| **extension** | Wire-registered by an *agent* via `POST /extensions`. The strictest class. | **Any** verb pends for a human. |

Provenance is the organizing axis because trust should follow origin. A first-party
calendar read and an agent-registered shell wrapper are not the same risk, and
Plexus never pretends they are. The gateway *stamps* provenance from the source —
an extension cannot impersonate a first-party id (those ids are reserved).

### Sensitivity — the derived risk tier

From provenance + verb + transport, the gateway computes a **sensitivity** tier,
purely for honest narration (so the UI and every agent describe the same risk):

- **low** — read on first-party / managed.
- **elevated** — write/exec on first-party / managed, *or* read on an extension.
- **high** — write/exec on an extension, *or* any `cli` / `local-rest` transport
  with write/exec.

Workflows roll up their members' sensitivity (the max wins).

### The grant ledger and revocation

Standing grants are first-class and **visible from both sides**:

- The user sees them in the `/admin` **Grants** tab.
- The agent sees *its own* standing grants at `GET /grants` (session-authenticated).

Each row carries the agent, the capability, the verbs, the provenance,
sensitivity, the trust-window, and the expiry. Revoke at any time:

- A human revokes from the **Grants** tab, or via `POST /grants/revoke` with the
  management connection-key (by `jti`, by `(agentId, capabilityId)`, or by
  `bundleId` for a whole task bundle).
- An agent may relinquish **its own** token by presenting that token and its
  `jti` to the same endpoint.

### The exposure gate — the owner's outer toggle

Grants decide what an agent *may* call; **exposure (what-I-expose) is the owner's
outer gate** sitting in front of them. A capability the owner disables is
invisible in discovery, not grantable, and denied at invoke with
`capability_unexposed` — enforced **before** the grant check. So effective access
= **granted ∧ exposed**: revoking exposure cuts off a capability no matter what
standing grants exist. (Shipped: `packages/runtime/src/core/exposure.ts`, with the
denial wired in `pipeline.ts`.)

### The two-mode authorization UX

Plexus supports two complementary ways for a human to approve work:

1. **Ad-hoc (per-operation) approval.** The agent requests a grant when it needs
   one; the gateway either auto-approves (e.g. a first-party read) or **pends**
   for you (`grant_pending_user`). You see a gateway-authored card — *not* agent
   prose — telling you exactly who wants to do what, for how long, with a "revoke
   anytime" reminder. You approve and pick a trust-window, or deny.

2. **Scoped task bundles.** Instead of approving operations one at a time, you
   pre-authorize a *named bundle* of grants (plus their scope constraints and any
   attached in-scope context) to one agent up front. The bundle is purely a
   *grouping* of standing grants under a shared `bundleId` — it confers no
   authority beyond its members, but it lets you reason about, and revoke, a whole
   task at once. The agent can pull the bundle's attached context in one call via
   `GET /grants/context?bundle=<id>`.

   The two modes reflect two instruments a human reasons with: the **badge** (工牌)
   — the agent's durable identity, the per-agent PAT — and the **ticket** (门票) —
   a task-scoped consent, approved up front and revocable as one act. The bundle is
   the ticket's 1.0 form; where the ticket model goes next (lifecycle, enterprise
   attribution, pluggable policy) is locked as seams in
   [`design/authz-extensibility.md`](design/authz-extensibility.md) (ADR-020).

A crucial honesty property runs through both modes: the **narration the human
reads is authored by the gateway, not the agent.** The agent may attach a
free-text "why now" purpose, but it is shown clearly labeled "the agent says:" and
influences no authorization decision — the gateway sanitizes and truncates it.
The agent can never spoof the risk summary.

For the full threat model and the trust boundary, read
[security.md](security.md), and the authoritative trust & auth model in
[design/security-model.md](design/security-model.md).

---

## 3. MCP vs Plexus — "what functions" vs "how to use me"

Plexus is not a competitor to [MCP](https://modelcontextprotocol.io); it answers a
different question.

- **MCP describes *what functions* a server exposes** — a list of tools with
  schemas an agent can call. It is a tool-calling transport.
- **Plexus describes *how to use the user's machine* — and gates it.** It adds the
  things a tool list alone doesn't carry: a pre-session **discovery** tier so an
  agent can window-shop before authenticating; **provenance / sensitivity** so
  risk is legible; **scoped, time-boxed, human-approved grants** so authority is
  default-deny; **attached skills** so an agent learns *how to use* a capability
  well, not just its signature; and a standing-grant **ledger** so trust is
  auditable and revocable.

**Status: the MCP transport/client layer exists and is tested, but the user-facing
"wrap an MCP server as a source" path is not shipped yet** (no MCP source module in
the production registry) — today you expose capabilities via first-party sources or
by authoring an extension. See [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md). The design
direction below describes where this is headed.

Concretely: MCP servers can be *ingested* into Plexus as a `transport:"mcp"`
source, and their tools become Plexus capabilities (with lossless MCP provenance
preserved so Plexus can round-trip back to the origin server). MCP is one of the
transports Plexus speaks; Plexus is the trust + discovery + capability layer on
top.

---

## 4. The self-describe protocol — two tiers

Plexus's discovery is **tiered** so an agent reveals exactly as much as the moment
warrants:

### Tier 1 — the `.well-known` summary (pre-session, unauthenticated)

```
GET /.well-known/plexus
```

Returns the gateway identity, a **summary** capability list (id + label +
provenance — enough to *window-shop*, not enough to *call*), the **auth
advertisement** (the URLs of every session endpoint — `handshakeUrl`, `grantsUrl`,
`invokeUrl`, …), and the **enrollment self-description** (`auth.enrollment`: how to
redeem a one-time code for a PAT). An agent **reads endpoint URLs from this
advertisement** rather than hard-coding paths. No credential is needed and none is
offered — the **connection-key never appears here** (it is admin-only). This public,
self-describing surface is the **Floor** (see [§5](#5-the-compile-model--the-floor-and-its-projections)).

### Tier 2 — the handshake manifest (post-session, full detail)

An agent opens a session with **its own per-agent PAT** — never the connection-key:

```
POST /link/handshake     Authorization: Bearer plx_agent_…
```

The gateway resolves the PAT to the agent's **real** `agentId` (a client can't
self-assert another agent's identity) and returns a **session** plus the **full
manifest** — every entry with its complete `describe`, input/output schemas, required
verbs, transport, default trust-window, and attached skill bodies. After the handshake
the agent *knows everything* and *can call nothing*: default-deny until it requests a
grant.

Where does the PAT come from? The agent redeems it **once**, before its first
handshake, from a **one-time enrollment code** the admin minted when connecting it
(see [§5](#5-the-compile-model--the-floor-and-its-projections)). The connection-key is
the admin/management credential and gates the *admin* path of the handshake — it is not
what an agent presents.

The full agent loop, end to end:

```
0. DISCOVER    GET  /.well-known/plexus           (summaries + endpoint URLs + enrollment self-description)
1. ENROLL      POST /agents/enroll                (one-time code → durable per-agent PAT, stored 0600)
2. HANDSHAKE   POST /link/handshake               (Bearer PAT → real agentId → session + full manifest)
3. GRANT       PUT  /grants                        (request scoped access → token, or pend for a human)
4. INVOKE      POST /invoke                        (Bearer scoped token → result → audit event)
```

Step 0 is unauthenticated; step 1 runs **once** per agent; steps 2–4 repeat. A
complete, dependency-light reference implementation of the agent side lives in
[`examples/min-agent/client.ts`](../examples/min-agent/client.ts); a runnable,
self-contained end-to-end demo is `bun run examples/min-agent/run.ts`.

---

## 5. The compile model — the Floor and its projections

Everything above (`.well-known` + `requestShapes` + per-capability *how-to-use* + I/O
schemas) is the **Floor**: the always-present, self-describing resource surface. The
Floor works for **any** agent over plain HTTP, with **no** plugin installed — enroll,
handshake, grant, invoke are all discoverable from it. Nothing an agent needs is hidden
behind bespoke tooling.

On top of the Floor, Plexus **compiles a per-agent artifact** (v1: a Claude Code
plugin) that makes the same capabilities feel native to that specific agent. The
artifact is a **projection over the Floor — a cache/shortcut, never a replacement.**
It ships a **version-isolated per-agent launcher `plexus-<agentId>`** (its own bundled
engine + a baked-in `PLEXUS_AGENT_ID`, so two agents on one host never collide and each
pins its own engine version — never a bare/global `plexus`). Its subcommands:

- **`plexus-<agentId> enroll <code>`** — redeem the one-time code → PAT → self-store (first run only).
- **`plexus-<agentId> list`** — the **discovery verb**: enumerate this agent's
  capabilities, split into **callable-now** (standing-granted) vs **needs-approval**,
  with **skills** (usage guidance, read-as-context — never wire-invoked) grouped in
  their own section. This is how an agent orients — including any capability exposed
  *after* the plugin was compiled (the Floor is live; the projection just caches it).
- **`plexus-<agentId> <capabilityId> [args]`** — invoke a capability. A call that needs
  approval **waits**: the launcher blocks on the advertised status endpoint and invokes
  the moment the owner approves — call once and wait, never retry-loop (`--no-wait`
  opts out for callers that manage their own retries). `plexus-<agentId> <skillId>`
  prints the skill's guidance body.

**The launcher is the agent's complete and only interface.** The compiled skill states
this as a hard rule: drive every interaction through `plexus-<agentId> …`; **never**
hand-roll HTTP against the gateway, **never** guess an auth path. The auth/invoke core
inside the launcher is deterministically templated from the Floor and verified against
it — never LLM-authored, and **no durable secret is ever baked into the distributed
artifact** (only the short-lived, single-use code rides the install). Because a skill is
a projection and the gateway enforces authz **live**, a stale or mis-generated skill can
never exceed the Floor's authority — worst case it references a revoked capability and
the invoke simply fails at the gateway.

---

## Where to go next

- **[getting-started.md](getting-started.md)** — install Plexus and connect your
  first agent end to end on macOS.
- **[security.md](security.md)** — the trust boundary, the threat model, and what
  Plexus does and does not protect against.
- **[design/security-model.md](design/security-model.md)** — the canonical, code-cited
  credential model: connection-key (admin) vs per-agent PAT, and the `execute→once` ceiling.
- **[Project README](../README.md)** — the one-paragraph overview and repo map.
- Tutorials (under `docs/tutorials/`) walk through real first-agent flows.
