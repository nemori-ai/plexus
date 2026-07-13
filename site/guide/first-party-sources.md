---
title: Expose a source
description: The bundled first-party sources — capability ids, grants, prerequisites, and the honest read-only vs. write surface.
---

# The bundled first-party sources

Plexus ships a set of **first-party** capability sources so an agent has something
real to discover the moment you boot the gateway. This page covers each one: its
capability ids, the grants it requires, how to enable and configure it, its
prerequisites, and the honest read-only vs. write surface.

The sources:

| Source | Access | Prereq |
| --- | --- | --- |
| **Obsidian** (`obsidian-fs`) | read | a vault folder on disk |
| **Obsidian** (`obsidian-rest`) | read + **write** | Obsidian *Local REST API* plugin |
| **Apple Calendar** | read | macOS + Calendar TCC |
| **Apple Reminders** | read + **write** | macOS + Reminders TCC |
| **Apple Notes** | read + **create-only write** | macOS + Automation TCC |
| **Apple Mail** | **read-only** | macOS + Automation TCC |
| **Apple Contacts** | read-only | macOS + Automation TCC |
| **Apple Photos** | read (`export` writes one file into a confined directory) | macOS + Automation TCC |
| **Shortcuts** (`shortcuts`) | read + **execute** (record-mode by default) | macOS `shortcuts` CLI |
| **Browser** (`browser`) | read-only (Safari + Chrome) | macOS (Safari history needs Full Disk Access) |
| **Workspace** (`workspace`) | read + **write** | an authorized working directory on disk |
| **Claude Code** (`claudecode`) | **execute** (sandbox-confined) | `claude` on PATH + macOS `sandbox-exec` |
| **Codex** (`codex`) | **execute** (sandbox-confined) | `codex` CLI on PATH + macOS `sandbox-exec` |

::: tip Two enablement shapes
The Apple sources (**Calendar**, **Reminders**, **Notes**, **Mail**, **Contacts**,
**Photos**), **Shortcuts**, **Browser**, and the three sandbox-confined demo/agent
sources (**Workspace**, **Claude Code**, **Codex**) are compiled in and auto-register
— no add step. The Obsidian adapters are **managed sources** you add at runtime (CLI
or `/admin`). Both shapes are covered below.
:::

::: warning Safety posture (applies to all of them)
Default-deny, scoped to what you authorized: when you connect an agent you pick the
exact capability subset it may reach, and a grant request outside that subset is
denied outright — never pended. Inside the subset, a **read** you select at connect
becomes a **standing** grant, while a selected side-effecting capability
(**write** / **execute**) stays **per-use** — each call pends for human approval (the
`grant_pending_user` dance — see [Connect an agent](/guide/connect-an-agent)) —
unless you opt that specific capability into standing at connect or later approve
its request with a real trust window. An agent can never self-grant a mutating call. See the [project README](https://github.com/nemori-ai/plexus/blob/main/README.md)
and [Watch the trust loop](/guide/run-it) for the trust model.
:::

---

## Obsidian

An Obsidian vault is just a folder of `.md` files. Plexus exposes it two ways; pick
based on whether you need writes.

### `obsidian-fs` — direct, **read-only**, path-confined

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `obsidian.vault.read` | capability | `read` | **read-only by construction** |
| `obsidian.vault.search` | capability | `read` | case-insensitive substring search of note paths + contents (default 20 hits, max 100) |
| `obsidian.vault.how-to-cite` | skill | — | usage guidance (read as context) |

**Read-only by construction** — there is no write/execute path in the code — and
**path-confined**: a `../` traversal, an absolute path, or a symlink escaping the
vault is rejected, never served.

**Prerequisites:** a vault folder on disk. No Obsidian app, no plugin, no secret.

**Enable it** (a managed source — it persists to `~/.plexus/sources.json` and
hot-loads with no restart). From the repo root:

```sh
# via the plexus CLI
bun run packages/cli/src/bin/plexus source add obsidian-fs --vault-path ~/Documents/MyVault

# or the launcher shortcut (persists the same managed source)
bun run start --vault ~/Documents/MyVault
```

You can also add it from the **What I expose** tab in `/admin`. Confirm it hot-appeared:

```sh
bun run packages/cli/src/bin/plexus source list
# → … obsidian-fs … enabled · live … capabilities:…
```

The same source shows up in the **What I expose** tree in `/admin`, and an agent you
authorized for it sees `obsidian.vault.read` in its own `list`.

### `obsidian-rest` — **read + write** via the Local REST API plugin

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `obsidian-rest.vault.list` | capability | `read` | list vault entries |
| `obsidian-rest.vault.read` | capability | `read` | read a note |
| `obsidian-rest.vault.search` | capability | `read` | text-search the vault (`POST /search/simple/`) |
| `obsidian-rest.vault.write` | capability | `write` | **create/overwrite a note — REPLACES the whole note → PENDS** |
| `obsidian-rest.vault.append` | capability | `write` | **append to a note's end (creates it if missing) → PENDS** |
| `obsidian-rest.vault.how-to-use` | skill | — | usage guidance |

**Prerequisites:** the **Obsidian Local REST API** plugin installed and running in
the Obsidian app on the same Mac. The plugin serves HTTPS on loopback (default
`https://127.0.0.1:27124`) and authenticates with a Bearer API key from its settings.
Plexus accepts the plugin's self-signed cert only because the host resolves to
loopback; the transport re-checks loopback before every call.

**Enable it.** The API key is read from STDIN only — never argv, which would leak via
`ps` — and stored by name in `~/.plexus/secrets/`, never echoed back:

```sh
printf %s "$OBSIDIAN_KEY" | bun run packages/cli/src/bin/plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
```

**A write warning worth taking literally:** `obsidian-rest.vault.write` **REPLACES
the whole note** (`PUT /vault/{path}` with the full markdown body) — read the note
first and resend everything you want kept. For additive edits — log entries,
follow-ups, captured items — prefer `obsidian-rest.vault.append`, which adds to the
note's end and preserves what is already there (and creates the note if it does not
exist yet).

Both writes (`vault.write` / `vault.append`) carry a `write` grant, so granting them
**pends for a human**: the agent gets `grant_pending_user`, you approve in the
**Approvals** tab. The three reads auto-approve. Reconfiguring a source's
`--base-url` or secret **purges its grants**, so a prior approval can't carry over to
a new endpoint. Full source management:
[`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md).

---

## Apple Calendar — **read-only**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `apple-calendar.calendars.list` | capability | `read` | list calendars |
| `apple-calendar.events.list` | capability | `read` | list events in a window |
| `apple-calendar.how-to-use` | skill | — | usage guidance |

**Read-only by construction** — the provider exposes only `listCalendars()` /
`listEvents()`; there is no write path. **Auto-registers** (compiled-in, first-party);
no add step.

**Prerequisites (real macOS):** the Calendar app, and a one-time macOS **TCC** grant.
The first live call shells out to `osascript -l JavaScript` (JXA) and triggers the
macOS consent dialog — *System Settings ▸ Privacy & Security ▸ Automation* (and
*Calendars*). If you deny, the call fails with a precise "enable it in System
Settings" message; Plexus cannot re-prompt for you, so you re-grant in System
Settings.

**Hermetic mode (no macOS, no TCC):** set `PLEXUS_FAKE_APPLE=1` and the source
resolves a fake provider with deterministic in-memory fixtures (sample calendars
`Home` / `Work` / `Birthdays` and sample events). This is how the acceptance playbook
and the test gate run.

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

The two write capabilities mutate the user's Reminders — their `describe` says so —
and both carry a `write` grant, so they **pend for approval**. The two reads
auto-approve. **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** the Reminders app, and a one-time **TCC** grant
(*System Settings ▸ Privacy & Security ▸ Automation* + *Reminders*). The real provider
shells `osascript` (AppleScript) against `tell application "Reminders"`; the first
live use prompts. **Hermetic mode:** `PLEXUS_FAKE_APPLE=1` (seed lists `Reminders` /
`Groceries`; create/complete mutate the in-memory store).

---

## Apple Notes — **read + create-only write**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `apple-notes.folders.list` | capability | `read` | list folders (per account) |
| `apple-notes.notes.search` | capability | `read` | bounded title/body search (default 20 hits, hard cap 50) |
| `apple-notes.notes.read` | capability | `read` | one note's content by id or exact title (`text` + raw `html`) |
| `apple-notes.notes.create` | capability | `write` | **create a NEW note → PENDS** |
| `apple-notes.skill.how-to-use` | skill | — | usage guidance |

**Create-only write surface, by construction:** the *only* write is creating a
**new** note — there is no update, no delete, no move, no rename entry, and none
exists anywhere in the source (the provider seam has no such method, the bridge has
no such handler). Existing notes cannot be modified or removed through Plexus.
`apple-notes.notes.create` still carries a `write` grant and **pends for approval**;
the three reads auto-approve. Search returns hit summaries (id, title, folder,
modification date, short snippet — never full bodies); pass a hit's `id` to
`notes.read` for the actual content. **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** the Notes app, and a one-time **TCC** grant (*System
Settings ▸ Privacy & Security ▸ Automation*) — the provider drives `osascript`/JXA.
**Hermetic mode:** `PLEXUS_FAKE_APPLE=1` (deterministic in-memory fixtures; `create`
mutates the in-memory store).

---

## Apple Mail — **strictly read-only**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `apple-mail.mailboxes.list` | capability | `read` | accounts + mailboxes with unread counts |
| `apple-mail.messages.search` | capability | `read` | bounded search within ONE mailbox (default 20, hard cap 50) |
| `apple-mail.message.read` | capability | `read` | one message's plain text by id (body capped at 20,000 chars) |
| `apple-mail.how-to-use` | skill | — | usage guidance |

**Strictly read-only by construction** — every capability carries `read`, and the
provider seam has **no draft/send/move/delete method**: a drafting or sending
capability does not exist in this source, rather than being merely denied. Search
works within **one mailbox at a time** (default `INBOX` = the unified inbox), filters
by sender/subject substring and/or a received-date range, and returns newest-first
with ~200-char snippets plus a `truncated` flag; prefer a date range or sender filter
on large mailboxes. **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** the Mail app, and a one-time **TCC** grant (*System
Settings ▸ Privacy & Security ▸ Automation*). **Hermetic mode:**
`PLEXUS_FAKE_APPLE=1` (deterministic in-memory fixtures).

---

## Apple Contacts — **read-only**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `apple-contacts.contacts.search` | capability | `read` | bounded name/email/phone substring search (default 20, hard cap 50) |
| `apple-contacts.contacts.read` | capability | `read` | the full card for one contact id |
| `apple-contacts.how-to-use` | skill | — | usage guidance |

**Read-only by construction** — the provider seam has no create/update/delete
method; no write capability of any kind exists in this source. Search matches a
case-insensitive substring of a name, email address, or phone number (phone matching
compares digits — the query needs ≥ 3 digits to match a phone); `contacts.read`
returns the full card (name, organization, birthday, labeled emails/phones/postal
addresses). **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** the Contacts app, and a one-time **TCC** grant
(*System Settings ▸ Privacy & Security ▸ Automation*). **Hermetic mode:**
`PLEXUS_FAKE_APPLE=1` (deterministic in-memory fixtures).

---

## Apple Photos — read posture, **jailed export**

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `apple-photos.albums.list` | capability | `read` | albums + folders with item counts (at most 200 per level) |
| `apple-photos.search` | capability | `read` | **metadata-only** media search (default 20, max 100) |
| `apple-photos.export` | capability | `read` | export ONE item into the `~/.plexus/exports/photos/` jail |
| `apple-photos.how-to-use` | skill | — | usage guidance |

All three carry `read` — the provider seam has **no method that mutates the photo
library**. `apple-photos.search` is **metadata only** (album, capture-date range,
filename/keyword substring — no content/ML search, so it cannot find "photos of
dogs"), and an unscoped search over more than 5,000 items is rejected — scope with
`album`. `apple-photos.export` has a **declared disk side effect**: it writes exactly
**one** file, and *only* into the gateway-owned jail directory
`~/.plexus/exports/photos/` (created if missing; a fresh subdirectory per export). It
can never write anywhere else and never modifies the library itself — which is why it
honestly stays a `read` grant, with the side effect stated verbatim in its `describe`
text. **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** the Photos app, and a one-time **TCC** grant
(*System Settings ▸ Privacy & Security ▸ Automation ▸ Photos*). **Hermetic mode:**
`PLEXUS_FAKE_APPLE=1` (deterministic in-memory fixtures).

::: tip The injectable-provider / TCC story (all the Apple sources)
Each source selects its provider through one env check:
`process.env.PLEXUS_FAKE_APPLE === "1"` → the **fake** provider with fixtures,
otherwise the **real** macOS provider (which drives `osascript`/JXA and is gated by
macOS TCC on first use). The selection is also injectable for unit tests.
`PLEXUS_FAKE_APPLE=1` is therefore the single switch for a hermetic, TCC-free run —
used by `bash run-tests.sh`, the
[`tests/harnesses/acceptance-apple`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance-apple/README.md)
playbook, and CI. (**Shortcuts** and **Browser** mirror the same pattern with their
own switches: `PLEXUS_FAKE_SHORTCUTS=1` and `PLEXUS_FAKE_BROWSER=1`.)
:::

::: tip `osascript` performance, honestly
The Apple providers drive their apps through `osascript`, which is slow on very
large stores — listing or searching hundreds or thousands of items can take
noticeable seconds. Scope queries to a window, a specific list/mailbox, or an album
rather than asking for everything.
:::

---

## Shortcuts — read + **execute** (record-mode by default)

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `shortcuts.list` | capability | `read` | list shortcut names + folder names |
| `shortcuts.run` | capability | `execute` | **run ONE named shortcut → PENDS; record-mode by default** |
| `shortcuts.how-to-use` | skill | — | usage guidance |

A shortcut is a **user-defined automation** — it can do anything the owner built it
to do (send messages, move files, control apps) — so `shortcuts.run` is
**owner-gated twice**: it carries an `execute` grant and **pends for the owner**, and
even an approved call defaults to **record mode** — it returns `launched: false` plus
the exact `shortcuts run` command that *would* have run, recorded and audited but
**not executed** — until the owner enables **real launch** for this source in the
Plexus console (*What I expose ▸ Shortcuts ▸ Real launch*). `shortcuts.list` is
read-only discovery (it never runs anything) and auto-approves; always list before
you run — `run` takes the shortcut name **verbatim**.

**Prerequisites (real macOS):** the macOS `shortcuts` CLI (present on modern macOS).
**Auto-registers** (compiled-in, first-party); whether the CLI is present surfaces
via **health**, not by hiding the entries. **Hermetic mode:**
`PLEXUS_FAKE_SHORTCUTS=1`.

---

## Browser — **read-only** (Safari + Chrome)

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `browser.tabs.list` | capability | `read` | the currently open tabs of Safari + Chrome |
| `browser.bookmarks.search` | capability | `read` | bookmarks by title/url substring, bounded (default 20, hard cap 200) |
| `browser.history.search` | capability | `read` | history by substring + optional date range, newest first, bounded |
| `browser.how-to-use` | skill | — | usage guidance |

**Read-only by construction** — the provider seam has no navigate/open/close/write/
delete method anywhere, and the bookmark/history sqlite files are only ever **copied
to a temp path** and read there (so a running Chrome never blocks the read). Results
merge Safari + Chrome with **per-browser graceful degradation**: every result carries
`browsers.safari` / `browsers.chrome` status sections, and a browser that is not
installed, not running, or unreadable contributes an empty list plus a note — it
never breaks the other browser's rows. **Auto-registers** (compiled-in, first-party).

**Prerequisites (real macOS):** listing tabs needs a one-time **Automation** TCC
grant per browser; **Safari history (and bookmarks) need Full Disk Access** — without
it the Safari half degrades to `unavailable` while Chrome results still return.
**Hermetic mode:** `PLEXUS_FAKE_BROWSER=1` (deterministic in-memory fixtures).

---

## Workspace — sandboxed working directory (**read + write**)

`workspace` exposes one authorized working directory on disk as a path-confined
filesystem surface — the agent's scratch/output folder for the demo flows. It is the
companion read/write surface to the two sandboxed runners below: an agent lists and
reads files here, has Claude Code or Codex build inside the same jail, then reads the
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
first-party); availability — does the authorized directory exist? — is reported via
**health**, never by hiding the entries.

---

## Claude Code — headless, **sandbox-confined** (`execute`)

`claudecode` exposes the Claude Code CLI as one sensitive capability: launch headless
Claude Code to do real coding work, confined by macOS `sandbox-exec` to the
authorized directory. The agent never sees a shell or the launch command — only a
`{ prompt }`. Reads and writes outside the jail **fail at the kernel**.

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `claudecode.run` | capability | `execute` | **launch headless Claude Code in the jail → PENDS** |
| `claudecode.how-to-use` | skill | — | usage guidance |

`claudecode.run` is an `execute` on a first-party source, so it is elevated and
**pends for the owner**: issue the call and wait for approval. Verify the products
between calls via `workspace.read`. **Auto-registers** (compiled-in, first-party);
whether `claude` + `sandbox-exec` are present surfaces via **health**, not by hiding
the entry.

---

## Codex — headless, **sandbox-confined** (`execute`)

`codex` is the mirror of `claudecode`: it runs the local Codex CLI (`codex exec`)
headless to do real coding work, confined by macOS `sandbox-exec` to the authorized
directory. Same posture — only a `{ prompt }` (plus an optional in-jail `cwd`), and
reads and writes outside the jail **fail at the kernel**.

| Capability id | Kind | Grants | Surface |
| --- | --- | --- | --- |
| `codex.run` | capability | `execute` | **launch headless `codex exec` in the jail → PENDS** |
| `codex.how-to-use` | skill | — | usage guidance |

`codex.run` is an `execute` on a first-party source, so it **pends for the owner**:
issue the call and wait. If the local `codex` CLI is absent, the call reports
`source_unavailable` rather than failing the session. **Auto-registers** (compiled-in,
first-party); presence of `codex` + `sandbox-exec` surfaces via **health**.

---

## Where to go next

- [Connect an agent](/guide/connect-an-agent) — drive these capabilities end to end
  (raw HTTP **and** a real Codex agent), including the pending → approve dance.
- [Author an extension](/guide/create-an-extension) — add a capability the gateway
  doesn't ship.
- [`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)
  — the full managed-source lifecycle (add / enable / disable / reconfigure / remove).
