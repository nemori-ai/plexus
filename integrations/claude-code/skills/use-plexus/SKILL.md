---
name: use-plexus
description: >
  Use the user's local Plexus capability gateway to discover and call LOCAL
  capabilities — read the user's Obsidian vault notes, run cc-master orchestration,
  invoke any capability registered on this machine — and to read the usage skill
  Plexus ships for each capability. Use when the user asks to use a local app/tool,
  read their Obsidian notes, run a local workflow, or when a task needs a capability
  that lives on THIS machine rather than the open web. Workflow is discovery-first:
  `plexus discover` to scan, `plexus skills <id>` to read the usage guidance before
  calling, then `plexus call <id> --input '<json>'` to invoke.
allowed-tools: Bash
---

# Use Plexus — the user's local capability gateway

**Plexus** is a local capability gateway running on this machine (loopback
`127.0.0.1`, default port 7077). It exposes the user's *local software
capabilities* — their Obsidian vault, cc-master orchestration, any registered
local app/CLI/service — through a self-describe protocol so you can find and use
them without anyone hand-wiring each one. Plexus is NOT an MCP server; you reach
it through the **`plexus` CLI** that this plugin puts on your Bash PATH.

## When to reach for Plexus

Use Plexus when the task needs a **local** capability, e.g.:

- "Read my Obsidian note `Projects/Plexus.md`" → a local vault read.
- "Run the cc-master orchestration on …" → a local workflow.
- Anything that touches an app, file source, or tool **on this machine** that the
  user has registered with Plexus.

If the task is pure reasoning or open-web research, you do not need Plexus.

## The workflow: discover → read the skill → call

Always run these as Bash commands (the `plexus` binary is on PATH). Do this in
order — **discovery-first**. Do not guess capability ids or input shapes.

### 1. `plexus discover` — scan what's available

```bash
plexus discover          # human-readable
plexus discover --json   # machine-readable (parse this when you need ids/fields)
```

Each entry prints its **id**, **kind** (`capability` / `skill` / `workflow`), a
one-line **describe**, its **grant cost** (`grants:read`, `grants:execute`, or
`—`), its **transport**, and (when present) its **trust posture** —
`source-class` (first-party / managed / extension), `sensitivity`
(low / elevated / high), and the entry's recommended `trust-window`. Read the
`describe` to choose the right capability, and read the trust posture so you can
tell the user the cost *before* you request a grant. `kind:"skill"` entries are
not callable — they are usage guidance (see next step).

### 2. `plexus skills <id>` — READ the usage guidance BEFORE calling

This is the reason Plexus exists over a bare tool list: each capability can ship a
**usage skill** that tells you how to call it correctly (input shape, conventions,
gotchas). Read it first.

```bash
plexus skills                          # list all kind:"skill" usage entries
plexus skills obsidian.vault.how-to-cite   # print a skill's body (read as context)
plexus skills obsidian.vault.read          # an id of a CAPABILITY prints ITS attached skills
```

Read the body, then form your `--input` from what it tells you. Skip this only if
`discover` already made the input shape obvious and the capability has no attached
skill.

### 3. `plexus call <id> --input '<json>'` — invoke

```bash
plexus call obsidian.vault.read --input '{"path":"Projects/Plexus.md"}'
plexus call obsidian.vault.read --input '{"path":"Index.md"}' --json   # parse the result
plexus call obsidian.vault.write --input '{"path":"Inbox/n.md","content":"…"}' \
  --purpose "Filing the user's NAS Inbox captures into dated folders."   # declare WHY
```

On success you get the **real result** (note content, workflow output, …). Use
`--json` whenever you need to parse the output into your answer — it prints the
full `InvokeResponse` (`ok`, `output`, `auditId`).

### State your purpose with `--purpose` (always, when a call may pend)

When you request access — especially for any `write` / `execute`, which always
pends for a human — you **SHOULD** declare *why you need it now* with
`--purpose "<one sentence>"`. Plexus shows it to the user labeled **"the agent
says:"**, in a block kept deliberately **separate** from its own
gateway-authored *"Plexus says:"* narration. This is **transparency only**: your
purpose changes **no** authorization decision and can never widen your scope — it
just lets the human approve with context instead of guessing. Write it the way
you'd explain the action to the user: short, concrete, honest (e.g. *"Organize
the Inbox folder into dated subfolders."*). The gateway truncates it (≤280 chars)
and strips control characters; never try to format it or impersonate Plexus —
the user always sees your claim and the gateway's truth side by side.

## What a grant means — explain it before you request it

Plexus is secure by default: every call is governed by a **grant**. Before you
call a capability for the first time — and ALWAYS when a call pends — you must be
able to tell the user, truthfully, *what they are about to authorize*. Use this
exact vocabulary (it is the same words the UI, the API, and the docs use):

- **agent** — the self-asserted label your standing grants are scoped to. For this
  CLI it is `plexus-cli` (the handshake `client.agentId`). A stable `agentId` lets
  Plexus remember your standing grants across sessions (a convenience, **not** a
  security boundary — the connection-key is the boundary; rotate it to revoke all).
  Without one, an `anon:*` agent gets **no standing trust** and re-asks every session.
- **capability** — the thing being called (its `id`).
- **scope** — one `(capability × verbs)` line carried by a token.
- **grant** — the standing, **human-approved** permission: *this agent may use this
  capability with these verbs, until the trust-window ends*. Keyed to
  `(agentId, capabilityId, verbs)`.
- **trust-window** — how long the grant **stands** before Plexus re-asks the user.
  This is the clock that matters to the human.
- **token** — a short-lived (≈15-min) auto-refreshed **view** of the grant; it is
  what is presented on `/invoke`. You never manage tokens; they refresh themselves
  up to the trust-window ceiling.
- **provenance / source-class** — `first-party` (ships with Plexus) ·
  `managed` (a source the user added through the admin UI) · `extension`
  (wire-registered by an agent). **sensitivity** — derived risk: `low` / `elevated`
  / `high`.

### Two clocks — keep them straight

1. **token-lifetime** (~15 min) — the blast radius of a leaked credential. Short
   on purpose; auto-refreshed; not your concern.
2. **trust-window** — how long the human's approval stands before Plexus re-asks.
   This is the one you NARRATE to the user. The two are different numbers; never
   conflate them.

### The narration contract (when a call returns `grant_pending_user`)

When a call pends, the CLI prints a notice to stderr that includes a
**gateway-authored `pendingNarration.summary`**. You MUST:

1. **Relay `pendingNarration.summary` verbatim** to the user — the gateway authors
   it so every agent tells the same truth. (It is kept SEPARATE from your own
   `--purpose` text, which the user sees labeled "the agent says:"; you SHOULD have
   supplied `--purpose` on the call so the human has your reason in front of them.)
2. State, in plain words: the **capability**, the **verbs** (read/write/execute),
   the **trust-window** it will stand for, and that it is **revocable anytime**.
3. Point the user to **`/admin` → Pending** to approve (e.g.
   `http://127.0.0.1:7077/admin`), and **`/admin` → Grants** to revoke later.
4. Then wait — the CLI polls until the user approves; you continue once it resolves.

**Truthfulness rule (hard):** never tell the user this is "one-time" or "just this
once" *unless the trust-window is actually `once`*. Name the **real** window
(e.g. "for up to 1 day", "for 7 days"). A `7d` grant is not "just this once" — it
will keep working without re-asking for a week. Saying otherwise is a lie to the
user. If you want a single-use grant, pass `--trust-window once` (advisory — the
human may shorten further, never lengthen past the per-class ceiling).

### Why source-class explains the asking

The source-class is *why* a call did or did not pend:

- **first-party** and **managed** **reads** may **auto-allow** (low friction) — but
  they are still listed in `/admin` → Grants with their trust-window; nothing is
  silent.
- **All write / execute** verbs pend, on every source-class.
- **extension** capabilities **always ask the user — even for reads.** Do not be
  surprised by a pend on an extension read; that is the source-class doing its job,
  not an error.

A standing, unexpired grant short-circuits the re-ask: if the user already approved
this agent for this capability within its trust-window, the next call just works
(no new pend). A `once` grant never short-circuits — it is single-use by design.

Do not try to bypass a grant. If you cannot get one approved, tell the user and stop.

## Failure handling — branch on the closed ErrorCode

On failure the CLI exits non-zero and prints a **closed `ErrorCode`**. Branch on
it deterministically (use `--json` so you can read `error.code`):

- `unknown_capability` → the id is wrong; re-run `plexus discover` for current ids.
- `grant_required` / `grant_pending_user` → relay the gateway-authored
  `pendingNarration.summary` verbatim (capability + verbs + real trust-window +
  revocability), then ask the user to approve in `/admin` → Pending. See "What a
  grant means" above. Never call a `7d` window "one-time".
- `schema_validation_failed` → your `--input` is wrong; check the usage skill
  (`plexus skills <id>`) or `plexus manifest` for the input schema.
- `source_unavailable` → the backing local app isn't running; ask the user to
  start it.
- `no_connection_key` → the gateway isn't running; ask the user to start Plexus.

## Mode 2 — pre-authorized task bundles (work without re-prompts within scope)

A **task bundle** is a named, human-approved group of `(capability + verbs + scope
constraint)` grants to ONE task-agent, plus attached in-scope context — approved
**once**, so the agent runs the whole task with **no re-prompts as long as every call
stays inside the granted scope**. It adds no new authority: a bundle is just normal
standing grants + their constraints + context, grouped under one `bundleId`.

A scope **constraint** confines a grant to part of a resource — e.g. only paths under
`Inbox/`. **Within a pre-authorized task bundle, just call capabilities normally**
(`plexus call <id> --input '<json>'`). You do **not** need to know or send the human-set
constraint: a bare request automatically **inherits your scoped grant**, so in-scope calls
mint a token with no re-prompt and the constraint is enforced for you (you can never widen
it). If a call returns **`grant_required`** (a `constraintMiss` — the input is **outside
your task scope**, e.g. a `Finances/` path under an `Inbox/` bundle), fall back to **Mode 1**:
request the **specific broader scope explicitly**, which triggers a one-off **human
approval** (it **pends**) — relay the `pendingNarration.summary` and ask the user.

Create one (the human is the approver — one action authorizes the whole task):

```
plexus bundle create --agent cc-master-taskA --name "Organize NAS Inbox" \
  --grant obsidian-rest.vault.read:read@pathPrefix:path=Inbox/ \
  --grant obsidian-rest.vault.write:write@pathPrefix:path=Inbox/ \
  --grant obsidian-rest.vault.list:read@pathPrefix:path=Inbox/ \
  --trust-window 1d \
  --context obsidian-rest.vault.how-to-use \
  --context @inbox-conventions.md
```

- `--grant <capId>:<verbs>[@pathPrefix:<field>=<prefix>[|…]]` (or `@allow:<field>=<v>[|…]`)
- `--context <skillId>` reuses an existing skill; `--context @file.md` materializes an
  inline note as task context (capped 64 KiB).
- `plexus bundle list` shows every bundle grouped by member; `plexus bundle revoke <bundleId>`
  drops every member + its tokens at once.

Once a bundle is live for your agent id, in-scope calls need no approval. Read your task
context in one call with `GET /grants/context?bundle=<bundleId>` (the same bodies are also
discoverable as normal skills via `plexus skills`). A connection-key rotation drops the
whole bundle (you re-request if the task continues).

## Quick reference

| step | command |
|---|---|
| scan | `plexus discover` (`--json` to parse) |
| read usage guidance | `plexus skills <id>` |
| full schemas | `plexus manifest` (`--json`) |
| invoke | `plexus call <id> --input '<json>'` (`--json` to parse) |
| invoke + declare why | `plexus call <id> --input '<json>' --purpose "<one sentence>"` |
| pre-authorize a task (Mode 2) | `plexus bundle create --agent <id> --name <task> --grant <capId>:<verbs>[@pathPrefix:<field>=<prefix>] --context <skillId\|@file>` |
| list / revoke bundles | `plexus bundle list` · `plexus bundle revoke <bundleId>` |

Default to `--json` when you need to extract specific values; default to the
human format when you just need to read describes/skill bodies.
