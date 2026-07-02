---
title: Connect an agent
description: Connect a real coding agent to a running Plexus end to end — admin connects, one command installs, the agent lists and invokes.
---

# Connect a real coding agent end to end

This tutorial connects a real coding agent to a running Plexus the way you actually
would: **the admin connects the agent, one command installs it, the agent lists what
it can do and calls it.** Two agents, two shapes:

- **Part 1 — Claude Code (compiled plugin).** You connect an agent in the console
  (or one API call), copy the **one-command install**, and the agent gets a plugin
  with a `plexus-<agentId>` launcher and a compiled skill. It runs
  `plexus-<agentId> list` then invokes.
- **Part 2 — Codex (AGENTS.md + shared CLI).** You wire the `plexus` command onto
  Codex's PATH, hand the agent its one-time code to `enroll`, and drive it with
  `codex exec`.

The under-the-hood wire (enroll → handshake → grant → invoke) is an **appendix** at
the end — you never touch it to connect an agent.

If you haven't booted a gateway yet, do [Get running](/guide/) first (install Bun,
`bun run start`).

::: tip The trust model in two credentials
- **Connection-key** (`plx_live_…`) — your **admin** credential. It gates the
  console and `/admin/api/*`. **The agent never sees it.**
- **Per-agent PAT** — the **agent's** durable credential, redeemed **once** from a
  one-time enrollment code (`plx_enroll_…`). The agent's command handles it
  internally — the agent never reads, builds, or presents a credential, and never
  hand-rolls HTTP. Reads on first-party / managed sources can be granted standing
  at connect time; **writes, execute, and anything on an extension pend for a human**.
  Full model: [the security model](/architecture/security-model).
:::

---

## Before you start

Boot a gateway. Run from the repo root:

```sh
# Terminal 1 — keep the gateway running (loopback only, 127.0.0.1:7077).
bun run start --vault ~/Documents/MyVault     # an Obsidian vault is handy for reads
```

You, the local human reaching the connection-key-authenticated console at
`http://127.0.0.1:7077/admin`, are the **admin** and the **approver**. Everything
below is done from there (or via the admin API, which needs the connection-key).

::: warning The `Host` header is mandatory
The gateway pins a **Host/Origin guard** to its bound port and runs it *before* auth
on every endpoint (DNS-rebinding defense). A request whose `Host` is not
`127.0.0.1:7077` is rejected with `host_forbidden` (403). Every `curl` below sends
`-H "Host: 127.0.0.1:7077"`.
:::

---

## Part 1 — Claude Code: connect → install → list → invoke

### 1. Connect the agent (admin)

In the console, open **Connect an agent**. Pick the **Claude Code** agent type, give
the agent an id (e.g. `my-cc`), and select a **starting cap-set** — say
`obsidian.vault.read`. Connecting does two things at once:

- mints a **one-time enrollment code** (`plx_enroll_…`, single-use, ~15 min), and
- **grants** the selected caps to this agent as **standing** grants — *this is the
  human approval, done once*, so those caps are callable without re-prompting.

The API equivalent (needs the connection-key — this is an admin action, not an agent
one):

```sh
export KEY=$(cat ~/.plexus/connection-key)     # ADMIN credential — never given to the agent
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $KEY" \
  -X POST "http://127.0.0.1:7077/admin/api/agents/connect" \
  -d '{"agentId":"my-cc","agentType":"claude-code","capabilities":["obsidian.vault.read"]}'
```

### 2. Copy the one-command install

The console shows a copyable **one-command install** for the connected agent (served
by `GET /integration/:agentId`, connection-key gated). It looks like:

```sh
curl -fsSL http://127.0.0.1:7077/integration/my-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

The one-time code rides the command in an env var (never baked into a file); the
installer lands it in a 0600 scratch file, redeems it for the agent's PAT, then
deletes it. What gets installed is a Claude Code plugin **compiled for this one
agent**: a `plexus-my-cc` launcher (its own bundled, version-pinned engine, never a
bare global `plexus`) plus a compiled `use-plexus` skill.

### 3. The agent lists, then invokes

Once installed, the agent's entire interface is the launcher. Its subcommands:

```sh
plexus-my-cc list                                   # what can I call NOW vs what needs approval
plexus-my-cc obsidian.vault.read path=Projects/Plexus.md
plexus-my-cc obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
```

- **`enroll`** ran for you during install (redeem one-time code → durable PAT, stored
  locally). If the agent is ever unenrolled (fresh machine / reset credential), the
  command tells it to run `plexus-my-cc enroll <code>` — the only time a code is
  involved.
- **`list`** marks each capability **callable-now** (a standing grant) vs
  **needs-approval**. `obsidian.vault.read` is callable now because you granted it at
  connect time.
- **`<capabilityId> [args]`** invokes — positional args bind to the input schema in
  order, or `key=value`, or `--input '<json>'`. Add `--json` to parse the
  `InvokeResponse`; add `--purpose "<one sentence>"` to tell the owner *why* when a
  call may pend.

In a Claude Code session with the plugin active, asking *"read my Obsidian note
`Projects/Plexus.md` via Plexus"* makes the compiled skill run exactly those commands
and return the real note.

::: tip The launcher is the agent's complete and only interface
Never hand-roll HTTP, never guess auth. The compiled skill is a projection over the
gateway's live, self-describing Floor; the enroll→PAT→handshake→token→invoke chain is
templated inside the engine and never enters the agent's context. A stale skill can
never exceed the Floor's live authz — worst case it references a revoked cap and the
invoke just fails.
:::

### 4. When a call needs approval

If the agent calls something you did **not** grant at connect time — any `write` /
`execute`, or any `extension` capability even for a read — the command reports
`grant_pending_user`. The agent relays the gateway-authored narration and asks you to
approve it in the console (**Approvals** tab, where you pick a trust-window):

```
http://127.0.0.1:7077/admin
```

![Approving a grant in the /admin Approvals tab](/diagrams/grant-approval.png)

To broaden a connected agent's standing caps without a pend, grant more from the
console (or re-run **Connect an agent** with a larger cap-set) — `plexus-my-cc list`
then shows them callable-now.

---

## Part 2 — drive a **real** `codex` agent against Plexus

Codex is **not** a compiled-plugin agent. It integrates via an **AGENTS.md block + a
shared `plexus` command on PATH**, driven by `codex exec`. Plexus is **not** an MCP
server (there is no `/mcp` wire), so there is nothing to put in Codex's `config.toml`.

### B1. Wire Codex up + enroll

```sh
# From the repo root — symlinks bin/plexus onto PATH + appends the AGENTS.md block.
bash integrations/codex/setup.sh
#   (if it warns ~/.local/bin isn't on PATH, add it:  export PATH="$HOME/.local/bin:$PATH")
```

Then **connect this agent** and **enroll** it. Connecting a Codex agent is the same
console flow as Part 1, but pick the **Generic / other agent** type — that delivers
the one-time code as raw enrollment coordinates instead of a compiled plugin. Redeem
it once:

```sh
plexus enroll plx_enroll_…        # once — stores THIS agent's PAT locally
plexus list                       # sanity-check: the caps you granted show callable-now
```

(Full setup — automatic vs manual, global vs per-project AGENTS.md — is in
[`integrations/codex/setup.md`](https://github.com/nemori-ai/plexus/blob/main/integrations/codex/setup.md).)

### B2. Why `--dangerously-bypass-approvals-and-sandbox`

**Codex sandboxes the commands it runs.** The `plexus` command talks to the gateway
over **loopback HTTP** (`127.0.0.1`). `codex exec` defaults to a `read-only` sandbox
that **blocks that loopback call**, so Codex can't reach Plexus. For the session that
drives Plexus, Codex has to be allowed to make the call. The blunt way is the flag:

```
codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

The flag removes the sandbox so the agent can talk to a local service — **use it only
for automation you trust on a machine you own.** (The narrower, safer alternative is
to grant network access in your Codex sandbox config instead of removing it wholesale.)
It's a Codex CLI flag, not a Plexus one; Plexus's own authz — standing grants plus the
pending-approval flow — still applies to every call.

### B3. A worked task — *read my calendar / create a reminder*

With the gateway running (boot it with `PLEXUS_FAKE_APPLE=1 bun run start` for the
deterministic Apple fixtures and no macOS TCC prompts — see
[Expose a source](/guide/first-party-sources)):

```sh
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Use the plexus command: run 'plexus list' to see what's available, read today's
   events with apple-calendar.events.list, then create a follow-up reminder for the
   first event with apple-reminders.reminders.create. Use --json."
```

Codex follows the discipline its AGENTS.md teaches — **list, then invoke** — and runs
something like:

```text
exec   plexus list --json                                              succeeded
         → apple-calendar.events.list (read, callable-now),
           apple-reminders.reminders.create (write, needs-approval) …
exec   plexus apple-calendar.events.list --input '{"start":"2026-06-25","end":"2026-06-26"}' --json
         → { "ok": true, "output": { "events": [ { "title": "Team sync", … } ] } }
exec   plexus apple-reminders.reminders.create --input '{"list":"Reminders","title":"Follow up on Team sync"}' --json
```

**The write pends.** `apple-reminders.reminders.create` is a `write`, so unless you
granted it standing at connect time, the command prints a `grant_pending_user` notice
and **polls** while telling you to approve it in `/admin` (Approvals tab + trust-window
picker). Approve it; the command completes the invoke and Codex reports the created
reminder. A pure read (`apple-calendar.events.list`) that you granted at connect time
just works.

### Gotchas

- **macOS TCC (the *first* live Apple call prompts you).** With `PLEXUS_FAKE_APPLE`
  **unset** on a real Mac, the Apple sources shell out to `osascript`/JXA and the
  **first** live use of each triggers the macOS **TCC** consent dialogs. If you deny,
  the call fails with a precise "enable it in System Settings" message. For a hermetic
  run with no TCC, set `PLEXUS_FAKE_APPLE=1`.
- **`osascript` provider perf on huge lists** — Calendar/Reminders through `osascript`
  is slow on very large stores. Scope your queries (a day/week window, a specific list).
- **Codex's sandbox blocks loopback by default** — re-read B2 if `plexus list` inside
  Codex fails with a network error while the same command works in your own shell.

---

## Appendix — under the hood (the PAT wire)

You never touch this to connect an agent — the `plexus` command does it all. But this
is exactly what it does on the wire (authoritative: cited `file:line` in
[the security model](/architecture/security-model) §2).

1. **DISCOVER** — `GET /.well-known/plexus` (unauthenticated). Gateway identity + a
   summary capability list + the `auth` advertisement (the enroll / handshake URLs).
2. **ENROLL** — `POST /agents/enroll { "code": "plx_enroll_…" }`. The **code is the
   credential** here; the connection-key is never accepted. On success it returns the
   durable **PAT** in plaintext **once** — the command stores it locally and it is
   never recoverable again:
   ```sh
   curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
     -X POST "http://127.0.0.1:7077/agents/enroll" \
     -d '{"code":"plx_enroll_…"}'          # → { "pat": "plx_agent_…", "agentId": "my-cc" }
   ```
3. **HANDSHAKE** — `POST /link/handshake` with `Authorization: Bearer plx_agent_…`.
   The PAT is verified and the session is bound to the **real** `agentId` it resolves
   to (a client can never self-assert another agent's identity). Returns a `sessionId`
   + the full manifest.
4. **GRANT** — `PUT /grants` with the `X-Plexus-Session: <sessionId>` header and
   `{ "grants": { "<capabilityId>": "allow" } }`. A capability the admin already made
   standing short-circuits to a scoped token; otherwise the authorizer auto-allows a
   low-sensitivity first-party read or **pends** for the owner (`grant_pending_user` +
   `pendingId`; poll `GET /grants/status?pendingId=…` with the same session header).
5. **INVOKE** — `POST /invoke` with `Authorization: Bearer <scoped-jwt>` and
   `{ "id": "<capabilityId>", "input": { … } }`. One result contract (ADR-017):
   `{ id, ok, output?, error?, auditId }`; a denial is `ok:false` with a closed-union
   `error.code`.

The reference implementation of this exact chain is
[`examples/min-agent/`](https://github.com/nemori-ai/plexus/tree/main/examples/min-agent) — the
bundled engine (`tools/plexus-cli/plexus`) is the sanctioned, Floor-verified version of it that
every compiled plugin ships. Note what an agent is **never** told to do: read an on-disk
key, present the connection-key at handshake, or mint its own token. The only
advertised forward path is the audited, owner-approved one.

---

## Where to go next

- [Author an extension](/guide/create-an-extension) — give an agent a capability the
  gateway doesn't ship (e.g. a vault *write*), and let a coding agent author the
  manifest from a description.
- [Expose a source](/guide/first-party-sources) — the bundled sources (Obsidian,
  Apple Calendar/Reminders, Things, cc-master): capability ids, grants, and prerequisites.
- [The protocol](/protocol/) — the frozen wire contract and ADRs (ADR-016 endpoint
  advertisement, ADR-017 `/invoke`, ADR-018 unified trust model).
