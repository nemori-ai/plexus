# Tutorial: Connect a real coding agent end to end

This tutorial connects a real coding agent to a running Plexus the way you actually
do it — **admin connects the agent, one command installs it, the agent lists what it
can do and calls it.** Two agents, two shapes:

- **Part 1 — Claude Code (compiled plugin).** You connect an agent in the console
  (or one API call), copy the **one-command install**, and the agent gets a plugin
  with a `plexus-<agentId>` launcher and a compiled skill. It runs
  `plexus-<agentId> list` then invokes.
- **Part 2 — Codex (project AGENTS.md + the `plexus` CLI).** You land the AGENTS.md
  block in the project you run Codex from (it teaches the `plexus` command by
  absolute path), hand the agent its one-time code to `enroll`, and drive it with
  `codex exec`.

The under-the-hood wire (enroll → handshake → grant → invoke) is an **appendix** at
the end — you never touch it to connect an agent.

If you have not booted a gateway yet, do
[`docs/getting-started.md`](../getting-started.md) first (install Bun,
`bun run start`).

> **The trust model in two credentials.**
> - **Connection-key** (`plx_live_…`) — your **admin** credential. It gates the
>   console and `/admin/api/*`. **The agent never sees it.**
> - **Per-agent PAT** — the **agent's** durable credential, redeemed **once** from a
>   one-time enrollment code (`plx_enroll_…`). The agent's command handles it
>   internally — the agent never reads, builds, or presents a credential, and never
>   hand-rolls HTTP. Any capability you select at connect time — read or write, any
>   provenance — becomes a **standing** grant: that selection *is* the human approval.
>   `execute` stays per-use unless you opt that specific capability into standing at
>   connect (off by default, double-confirmed); a request for anything you didn't
>   select is denied. Full model:
>   [`docs/design/security-model.md`](../design/security-model.md).

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

> **The `Host` header is mandatory.** The gateway pins a **Host/Origin guard** to its
> bound port and runs it *before* auth on every endpoint (DNS-rebinding defense). A
> request whose `Host` is not `127.0.0.1:7077` is rejected with `host_forbidden`
> (403). Every `curl` below sends `-H "Host: 127.0.0.1:7077"`.

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

The console shows a copy-able **one-command install** for the connected agent (served
by `GET /integration/:agentId`, management-key gated). It looks like:

```sh
curl -fsSL http://127.0.0.1:7077/integration/my-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

The one-time code rides the command in an env var (never baked into a file); the
installer lands it in a 0600 scratch file, redeems it for the agent's PAT, then
deletes it. What gets installed is a Claude Code plugin **compiled for this one
agent**: a `plexus-my-cc` launcher (its own bundled, version-pinned engine — never a
bare global `plexus`) plus a compiled `use-plexus` skill.

Paste the command **in the project you use Claude Code in** — the plugin registers
into that project (`--scope local`: `.claude/settings.local.json`, a personal file
that stays out of the repo). Already inside a `claude` session there? Run
`/reload-plugins` and it activates immediately, no restart. For a one-off session
anywhere: `claude --plugin-dir ~/.plexus/plugins/plexus@<agentId>` — session-only,
nothing persisted.

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

**The launcher is the agent's complete and only interface — never hand-roll HTTP,
never guess auth.** The compiled skill is a projection over the gateway's live,
self-describing Floor; the enroll→PAT→handshake→token→invoke chain is templated inside
the engine and never enters the agent's context. A stale skill can never exceed the
Floor's live authz — worst case it references a revoked cap and the invoke just fails.

### 4. When a call needs approval

A capability outside the agent's authorized subset is simply not there: it never
appears in `plexus-my-cc list`, and a grant request for it is denied outright — no
approval card, no pend. What pends is an in-subset **`execute`** capability: execute is
approved per use by default (unless you opted that specific capability into standing at
connect), so the command reports `grant_pending_user`, relays the gateway-authored
narration, and asks you to approve it in the console (**Approvals** tab; for an
un-opted execute, whatever trust-window you pick resolves to `Once`):

```
http://127.0.0.1:7077/admin
```

![Approving a grant in the /admin Approvals tab](../assets/screenshots/grant-approval.png)

To broaden a connected agent's reach, grant more from the console (or re-run
**Connect an agent** with a larger cap-set) — `plexus-my-cc list` then shows the new
caps callable-now.

---

## Part 2 — drive a **real** `codex` agent against Plexus

Codex is **not** a compiled-plugin agent. It integrates via an **AGENTS.md block at
the project root + a `plexus` command it runs by absolute path**, driven by
`codex exec`. Plexus is **not** an MCP server (there is no `/mcp` wire), so there is
nothing to put in Codex's `config.toml`.

### B1. Wire Codex up + enroll

```sh
# From the project you run Codex in — lands the AGENTS.md block at ./AGENTS.md,
# teaching the shim's absolute path (<repo>/integrations/codex/bin/plexus).
bash <repo>/integrations/codex/setup.sh
```

Then **connect this agent** and **enroll** it. Connecting a Codex agent is the same
console flow as Part 1, but pick the **Generic / other agent** type — that delivers
the one-time code as raw enrollment coordinates instead of a compiled plugin. Redeem
it once, by the shim's absolute path (exactly the command the block teaches Codex):

```sh
<repo>/integrations/codex/bin/plexus enroll plx_enroll_…   # once — stores THIS agent's PAT locally
<repo>/integrations/codex/bin/plexus list                  # sanity-check: granted caps show callable-now
```

(Full setup — automatic vs manual, project-root (default) vs global AGENTS.md — is in
[`integrations/codex/setup.md`](../../integrations/codex/setup.md).)

### B2. Why `--dangerously-bypass-approvals-and-sandbox`

**Codex sandboxes the commands it runs.** The `plexus` command talks to the gateway
over **loopback HTTP** (`127.0.0.1`). `codex exec` defaults to a `read-only` sandbox
that **blocks that loopback call**, so Codex can't reach Plexus. You have to let Codex
make the loopback call for the session you drive Plexus in. The blunt way is the flag:

```
codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

(The narrower, safer alternative is to grant network in your Codex sandbox config
instead of removing it wholesale.) It removes the sandbox so the agent can talk to a
local service — **use it only for automation you trust on a machine you own.** It's a
Codex CLI flag, not a Plexus one; Plexus's own authz (standing grants + the
pending-approval dance) still applies to every call.

### B3. A worked task — *read my calendar / create a reminder*

With the gateway running (boot it with `PLEXUS_FAKE_APPLE=1 bun run start` for the
deterministic Apple fixtures and no macOS TCC prompts — see
[`first-party-sources.md`](./first-party-sources.md)), and the Codex agent connected
with both `apple-calendar.events.list` **and** `apple-reminders.reminders.create` in
its cap-set:

```sh
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Use the plexus command: run 'plexus list' to see what's available, read today's
   events with apple-calendar.events.list, then create a follow-up reminder for the
   first event with apple-reminders.reminders.create. Use --json."
```

Codex follows the discipline its AGENTS.md teaches — **list, then invoke** — running,
e.g.:

```text
exec   <repo>/integrations/codex/bin/plexus list --json                succeeded
         → apple-calendar.events.list (read, callable-now),
           apple-reminders.reminders.create (write, callable-now) …
exec   <repo>/integrations/codex/bin/plexus apple-calendar.events.list --input '{"start":"2026-06-25","end":"2026-06-26"}' --json
         → { "ok": true, "output": { "events": [ { "title": "Team sync", … } ] } }
exec   <repo>/integrations/codex/bin/plexus apple-reminders.reminders.create --input '{"list":"Reminders","title":"Follow up on Team sync"}' --json
         → { "ok": true, … }
```

**Both calls just work — you approved them at connect.** The caps you selected at
connect time (the read *and* the write) are standing grants: that selection was the
human approval, so neither call re-prompts you. What still pends per use is an
in-subset `execute` capability you did not opt into standing at connect (e.g.
`claudecode.run`): there the command prints a `grant_pending_user` notice and
**polls** while telling you to approve it in `/admin` (Approvals tab). And a
capability you did not select at connect is outside this agent's authorized subset —
it doesn't show up in `plexus list` at all, and a request for it is denied.

### Gotchas — honestly

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
[`docs/design/security-model.md`](../design/security-model.md) §2).

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
[`examples/min-agent/`](../../examples/min-agent/) — the bundled engine
(`tools/plexus-cli/plexus`) is the sanctioned, Floor-verified version of it that every
compiled plugin ships. Note what an agent is **never** told to do: read an on-disk
key, present the connection-key at handshake, or mint its own token. The only
advertised forward path is the audited, owner-approved one.

---

## Where to go next

- [`create-an-extension.md`](./create-an-extension.md) — give an agent a capability
  the gateway doesn't ship (e.g. a vault *write*), and let a coding agent author the
  manifest from a description.
- [`first-party-sources.md`](./first-party-sources.md) — the bundled sources
  (Obsidian, Apple Calendar/Reminders/Notes/Mail/Contacts/Photos, Shortcuts, browser, Claude Code): capability ids, grants,
  and prerequisites.
- [`docs/protocol/`](../protocol/) — the frozen wire contract and ADRs (ADR-016
  endpoint advertisement, ADR-017 `/invoke`, ADR-018 unified trust model).
