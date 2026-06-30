# Tutorial: The bundled first-party sources

Plexus ships a set of **first-party** capability sources so an agent has something
real to discover the moment you boot the gateway. This tutorial covers each one — its
**capability ids**, the **grants** it requires, how to **enable / configure** it, the
**prerequisites**, and the honest **read-only vs. write** surface.

The sources:

| Source | Access | Prereq |
| --- | --- | --- |
| **Obsidian** (`obsidian-fs`) | read | a vault folder on disk |
| **Obsidian** (`obsidian-rest`) | read + **write** | Obsidian *Local REST API* plugin |
| **Apple Calendar** | read | macOS + Calendar TCC |
| **Apple Reminders** | read + **write** | macOS + Reminders TCC |
| **Things 3** | read + **write** | Things 3 installed |
| **cc-master** | execute / write / read | Claude Code (`claude`) on PATH |
| **Workspace** (`workspace`) | read + **write** | an authorized working directory on disk |
| **Claude Code** (`claudecode`) | **execute** (sandbox-confined) | `claude` on PATH + macOS `sandbox-exec` |
| **Codex** (`codex`) | **execute** (sandbox-confined) | `codex` CLI on PATH + macOS `sandbox-exec` |

> **Two enablement shapes.** The Apple sources, Things, cc-master, and the three
> sandbox-confined demo/agent sources (**Workspace**, **Claude Code**, **Codex**) are
> **compiled in** and **auto-register** — no add step. The Obsidian adapters are
> **managed sources** you add at runtime (CLI or `/admin`). Both are covered below.

> **Safety posture (applies to all of them).** Default-deny: an agent holds *zero*
> call authority until it requests a grant. **Reads on a first-party source
> auto-approve; writes are elevated-sensitivity and PEND for human approval** (the
> `grant_pending_user` dance — see [`connect-an-agent.md`](./connect-an-agent.md)). An
> agent can never self-grant a mutating call. See [`README`](../../README.md) and
> [`docs/getting-started.md`](../getting-started.md) for the trust model.

---

## Obsidian

An Obsidian vault is just a folder of `.md` files. Plexus exposes it two ways — pick
based on whether you need writes.

### `obsidian-fs` — direct, **read-only**, path-confined

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `obsidian.vault.read` | capability | `read` | **read-only by construction** |
| `obsidian.vault.how-to-cite` | skill | — | usage guidance (read as context) |

**Read-only by construction** — there is no write/execute path in the code — and
**path-confined**: a `../` traversal, an absolute path, or a symlink escaping the
vault is rejected, never served.

**Prerequisites:** just a vault folder on disk. **No Obsidian app, no plugin, no
secret.**

**Enable it** (managed source — adds + persists to `~/.plexus/sources.json`,
hot-loads with no restart). From the repo root:

```sh
# via the plexus CLI
bun run packages/cli/src/bin/plexus source add obsidian-fs --vault-path ~/Documents/MyVault

# or the launcher shortcut (persists the same managed source)
bun run start --vault ~/Documents/MyVault
```

You can also add it from the **Sources** tab in `/admin`. Confirm it hot-appeared:

```sh
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus | bun -e \
  'const d = await Bun.stdin.json(); console.log(d.capabilities.map(c => c.id).join("\n"))'
# → … obsidian.vault.read …
```

### `obsidian-rest` — **read + write** via the Local REST API plugin

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `obsidian-rest.vault.list` | capability | `read` | list vault entries |
| `obsidian-rest.vault.read` | capability | `read` | read a note |
| `obsidian-rest.vault.write` | capability | `write` | **create/overwrite a note → PENDS** |
| `obsidian-rest.vault.how-to-use` | skill | — | usage guidance |

**Prerequisites:** the **Obsidian Local REST API** plugin installed and running in
the Obsidian app on the same Mac. The plugin serves **HTTPS on loopback** (default
`https://127.0.0.1:27124`) and authenticates with a **Bearer API key** from its
settings. Plexus accepts the plugin's self-signed cert *only* because the host
resolves to loopback; the transport re-checks loopback before every call.

**Enable it** (the API key is read from **STDIN only** — never argv, which would leak
via `ps` — and stored by NAME in `~/.plexus/secrets/`, never echoed back):

```sh
printf %s "$OBSIDIAN_KEY" | bun run packages/cli/src/bin/plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
```

`obsidian-rest.vault.write` carries a `write` grant, so granting it **pends for a
human** — the agent gets `grant_pending_user`, you approve in the **Pending** tab. The
two reads auto-approve. (Reconfiguring a source's `--base-url`/secret **purges its
grants**, so a prior approval can't carry over to a new endpoint.) Full source
management: [`docs/sources/MANAGING-SOURCES.md`](../sources/MANAGING-SOURCES.md).

---

## Apple Calendar — **read-only**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `apple-calendar.calendars.list` | capability | `read` | list calendars |
| `apple-calendar.events.list` | capability | `read` | list events in a window |
| `apple-calendar.how-to-use` | skill | — | usage guidance |

**Read-only by construction** — the provider exposes only `listCalendars()` /
`listEvents()`; there is no write path. **Auto-registers** (compiled-in, first-party)
— no add step.

**Prerequisites (real macOS):** the Calendar app, and a one-time macOS **TCC** grant.
The **first live call** shells out to `osascript -l JavaScript` (JXA) and triggers the
macOS consent dialog — *System Settings ▸ Privacy & Security ▸ Automation* (and
*Calendars*). If you deny, the call fails with a precise "enable it in System Settings"
message; Plexus cannot re-prompt for you — you re-grant in System Settings.

**Hermetic mode (no macOS, no TCC):** set `PLEXUS_FAKE_APPLE=1` and the source
resolves a **fake provider** with deterministic in-memory fixtures (sample calendars
`Home` / `Work` / `Birthdays` and sample events). This is how the acceptance玩法 and
the test gate run.

```sh
PLEXUS_FAKE_APPLE=1 bun run start     # fake providers — no TCC, deterministic fixtures
```

---

## Apple Reminders — **read + write**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `apple-reminders.lists.list` | capability | `read` | list reminder lists |
| `apple-reminders.reminders.list` | capability | `read` | list reminders |
| `apple-reminders.reminders.create` | capability | `write` | **create a reminder → PENDS** |
| `apple-reminders.reminders.complete` | capability | `write` | **mark a reminder done → PENDS** |
| `apple-reminders.skill.how-to-use` | skill | — | usage guidance |

The two **write** capabilities honestly *mutate the user's Reminders* — their
`describe` says so — and both carry a `write` grant, so they **pend for approval**.
The two reads auto-approve. **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** the Reminders app, and a one-time **TCC** grant
(*System Settings ▸ Privacy & Security ▸ Automation* + *Reminders*). The real provider
shells `osascript` (AppleScript) against `tell application "Reminders"`; the first
live use prompts. **Hermetic mode:** `PLEXUS_FAKE_APPLE=1` (seed lists `Reminders` /
`Groceries`; create/complete mutate the in-memory store).

---

## Things 3 — **read + write**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `things.todos.list` | capability | `read` | list to-dos (AppleScript) |
| `things.projects.list` | capability | `read` | list projects (AppleScript) |
| `things.todos.add` | capability | `write` | **append a to-do → PENDS** |
| `things.how-to-use` | skill | — | usage guidance |

**Surface split worth knowing:** reads go through the AppleScript dictionary
(`tell application "Things3"`), but the write (`things.todos.add`) uses the **Things
URL-scheme** (`things:///add?title=…&notes=…&when=…&list=…`). That makes the write a
well-bounded **append** — not arbitrary mutation — but it still carries a `write`
grant and **pends for approval**. **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** **Things 3 installed** (detected via an `osascript`
version probe). The write opens the `things://` URL via the `open` binary.
**Hermetic mode:** `PLEXUS_FAKE_APPLE=1` (seed to-dos + projects; `add` mutates the
in-memory store).

> **The injectable-provider / TCC story (all three Apple sources).** Each source
> selects its provider through one env check — `process.env.PLEXUS_FAKE_APPLE === "1"`
> → the **fake** provider with fixtures, otherwise the **real** macOS provider (which
> drives `osascript`/JXA or the Things URL-scheme and is gated by macOS TCC on first
> use). The selection is also injectable for unit tests. So `PLEXUS_FAKE_APPLE=1` is
> the single switch for a hermetic, TCC-free run — used by `bash run-tests.sh`, the
> [`tests/harnesses/acceptance-apple`](../../tests/harnesses/acceptance-apple/README.md)玩法, and CI.

> **`osascript` perf, honestly.** The Apple providers drive Calendar / Reminders
> through `osascript`, which is **slow on very large stores** — listing
> hundreds/thousands of items can take noticeable seconds. Scope queries to a window
> or a specific list rather than asking for everything.

---

## cc-master — Claude Code orchestration

cc-master is a **managed launcher** for the Claude Code long-horizon orchestration
plugin. It spawns `claude --plugin-dir <embedded cc-master> -p …` headless and
**never mutates your `~/.claude`** — the plugin is auto-loaded into the managed
session via `--plugin-dir` injection.

| Capability id | Kind | Grants | Notes |
| --- | --- | --- | --- |
| `cc-master.session.launch` | capability | `execute` | launch a headless Claude Code session (always exposed) |
| `cc-master.orchestration.run` | workflow | `execute` | the flagship orchestration workflow |
| `cc-master.board.create` | capability | `write` | create an orchestration board |
| `cc-master.agent.dispatch` | capability | `execute` | dispatch a managed sub-agent |
| `cc-master.board.status` | capability | `read` | read board status |
| `cc-master.skill.orchestrating-to-completion` | skill | — | usage guidance |
| `cc-master.skill.authoring-workflows` | skill | — | usage guidance |
| `cc-master.skill.as-master-orchestrator` | skill | — | usage guidance |
| `cc-master.skill.status` | skill | — | usage guidance |

All the **execute** / **write** capabilities pend for approval (default-deny per
capability); `board.status` is a read. The orchestration surface beyond
`session.launch` is **gated** by a config flag (below) — when off, only
`cc-master.session.launch` is exposed.

**Prerequisites:** the `claude` binary on PATH, with the plugin installed under
`~/.claude/`. Plexus **auto-detects** cc-master when both are present and surfaces the
capabilities.

**Enable / configure:**

- If cc-master isn't enabled yet, use the **Install cc-master** action in `/admin`. It
  performs a first-class, **idempotent, audited** install — it only adds the two
  settings keys that enable the plugin + register its marketplace, never rewriting
  unrelated settings. Already enabled ⇒ safe no-op.
- The exposure gate persists to `~/.plexus/cc-master.json` as `{ "loadCcMaster":
  <bool> }` (default `true`); the `/admin` cc-master config toggles it
  (`GET`/`POST /admin/api/cc-master/config`).

Confirm detection from discovery:

```sh
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus | bun -e \
  'const d = await Bun.stdin.json();
   console.log(d.capabilities.filter(c => c.id.startsWith("cc-master")).map(c => c.id).join("\n"))'
```

> **Launch is gated for safety.** A bare `bun run start` (and the whole test gate)
> runs cc-master in **record-only** mode — `cc-master.agent.dispatch` records the
> dispatch on a real board and returns the **argv it would run** without spawning
> `claude`. The shipped desktop app flips the gate **on**
> (`PLEXUS_CC_HEADLESS_LAUNCH=1`) so launch executes for real; set that env var
> manually to make a bare runtime launch. See
> [`tests/harnesses/acceptance/README.md`](../../tests/harnesses/acceptance/README.md).

---

## Workspace — sandboxed working directory (**read + write**)

`workspace` exposes **one authorized working directory** on disk as a path-confined
filesystem surface — the agent's scratch/output folder for the demo flows. It is the
companion read/write surface to the two sandboxed runners below: an agent lists/reads
files here, has Claude Code or Codex build inside the same jail, then reads the
products back.

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `workspace.list` | capability | `read` | list a directory (read-only) |
| `workspace.read` | capability | `read` | read a file (read-only) |
| `workspace.write` | capability | `write` | **create/overwrite a file → PENDS** |
| `workspace.how-to-use` | skill | — | usage guidance |

**Path-confined** like the Obsidian vault reader: every path resolves under the
workspace root and is rejected if it escapes (`..`, absolute, or symlink-out). The two
reads (`list`/`read`) auto-approve; `workspace.write` carries a `write` grant on a
first-party source, so it **pends for the owner**. **Auto-registers** (compiled-in,
first-party); availability (does the authorized dir exist?) is reported via **health**,
never by hiding the entries.

---

## Claude Code — headless, **sandbox-confined** (`execute`)

`claudecode` exposes the Claude Code CLI as **one sensitive capability**: launch
headless Claude Code to do real coding work, **confined by macOS `sandbox-exec`** to
the authorized directory. The agent never sees a shell or the launch command — only a
`{ prompt }`. Reads/writes outside the jail **fail at the kernel**.

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `claudecode.run` | capability | `execute` | **launch headless Claude Code in the jail → PENDS** |
| `claudecode.how-to-use` | skill | — | usage guidance |

`claudecode.run` is an `execute` on a first-party source, so it is elevated and
**pends for the owner** — issue the call and wait for approval. Verify the products
(via `workspace.read`) between calls. **Auto-registers** (compiled-in, first-party);
whether `claude` + `sandbox-exec` are present surfaces via **health**, not by hiding
the entry.

---

## Codex — headless, **sandbox-confined** (`execute`)

`codex` is the mirror of `claudecode`: it runs the local Codex CLI (`codex exec`)
headless to do real coding work, **confined by macOS `sandbox-exec`** to the
authorized directory. Same posture — only a `{ prompt }` (plus an optional in-jail
`cwd`); reads/writes outside the jail **fail at the kernel**.

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `codex.run` | capability | `execute` | **launch headless `codex exec` in the jail → PENDS** |
| `codex.how-to-use` | skill | — | usage guidance |

`codex.run` is an `execute` on a first-party source, so it **pends for the owner** —
issue the call and wait. If the local `codex` CLI is absent the call reports
`source_unavailable` rather than failing the session. **Auto-registers** (compiled-in,
first-party); presence of `codex` + `sandbox-exec` surfaces via **health**.

---

## Where to go next

- [`connect-an-agent.md`](./connect-an-agent.md) — drive these capabilities end to
  end (raw HTTP **and** a real Codex agent), including the pending → approve dance.
- [`create-an-extension.md`](./create-an-extension.md) — add a capability the gateway
  doesn't ship.
- [`docs/sources/MANAGING-SOURCES.md`](../sources/MANAGING-SOURCES.md) — the full
  managed-source lifecycle (add / enable / disable / reconfigure / remove).
</content>
