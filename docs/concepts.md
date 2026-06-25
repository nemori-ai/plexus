# Plexus Concepts — the mental model

Plexus is a **local capability gateway**. It runs on your Mac, on `127.0.0.1`
only, and gives any AI agent a single, AI-native protocol to **discover →
understand → be granted → call** the capabilities of the software you already
use — your notes, your calendar, your reminders, your tools.

This is the keystone document. Read it once and the rest of Plexus (the
[getting-started guide](getting-started.md), the [security model](security.md),
and the tutorials) will click into place.

---

## 1. Connector → Source → Capability

Everything in Plexus is organized along one spine. Three words, in Chinese, name
the three questions it answers:

| Layer | 中文 | The question | Example |
| --- | --- | --- | --- |
| **Connector** (连接器) | 怎么接 | *How* does Plexus connect to this kind of thing? | "Obsidian Local REST API", "Obsidian vault (filesystem)", "cc-master" |
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
setup beyond the underlying app's own permission grant:

| Source | Capabilities | Verbs |
| --- | --- | --- |
| `apple-calendar` | `apple-calendar.calendars.list`, `apple-calendar.events.list` | read |
| `apple-reminders` | `apple-reminders.lists.list`, `apple-reminders.reminders.list` | read |
| `apple-reminders` | `apple-reminders.reminders.create`, `apple-reminders.reminders.complete` | **write** |
| `obsidian` (filesystem) | `obsidian.vault.read` | read |
| `cc-master` | `cc-master.orchestration.run`, `cc-master.board.*`, … | execute |

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

### Provenance — the 3-class source-class (the organizing axis)

The single fact that drives *everything* about how cautious Plexus is about a
capability is its **provenance** — where the capability came from:

| Provenance | Means | Default posture |
| --- | --- | --- |
| **first-party** | A reserved, in-process source (Apple Calendar/Reminders, Obsidian filesystem, cc-master). | Read flows easily; write/execute still asks a human. |
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

A crucial honesty property runs through both modes: the **narration the human
reads is authored by the gateway, not the agent.** The agent may attach a
free-text "why now" purpose, but it is shown clearly labeled "the agent says:" and
influences no authorization decision — the gateway sanitizes and truncates it.
The agent can never spoof the risk summary.

For the full threat model and the trust boundary, read
[security.md](security.md). The directional spec behind this UX is the internal
[AUTHZ-UX-MODEL design doc](archive/design/AUTHZ-UX-MODEL.md).

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
provenance — enough to *window-shop*, not enough to *call*), and the **auth
advertisement**: the URLs of every session endpoint (`handshakeUrl`, `grantsUrl`,
`invokeUrl`, …). An agent **reads endpoint URLs from this advertisement** rather
than hard-coding paths. No credential is needed and none is offered — the
connection-key never appears here.

### Tier 2 — the handshake manifest (post-session, full detail)

```
POST /link/handshake   { connectionKey }
```

Exchange the user-pasted connection-key for a **session** and the **full
manifest** — every entry with its complete `describe`, input/output schemas,
required verbs, transport, default trust-window, and attached skill bodies. After
the handshake the agent *knows everything* and *can call nothing*: default-deny
until it requests a grant.

The full agent loop is just four steps:

```
1. DISCOVER    GET  /.well-known/plexus           (summaries + endpoint URLs)
2. UNDERSTAND  POST /link/handshake               (connection-key → session + full manifest)
3. GRANTED     PUT  /grants                        (request scoped access → token, or pend)
4. CALL        POST /invoke                        (Bearer token → result)
```

A complete, dependency-light reference implementation of the agent side lives in
[`examples/min-agent/client.ts`](../examples/min-agent/client.ts); a runnable,
self-contained end-to-end demo is `bun run examples/min-agent/run.ts`.

---

## Where to go next

- **[getting-started.md](getting-started.md)** — install Plexus and connect your
  first agent end to end on macOS.
- **[security.md](security.md)** — the trust boundary, the threat model, and what
  Plexus does and does not protect against.
- **[Project README](../README.md)** — the one-paragraph overview and repo map.
- Tutorials (under `docs/tutorials/`) walk through real first-agent flows.
