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
`—`), and **transport**. Read the `describe` to choose the right capability for
the task. `kind:"skill"` entries are not callable — they are usage guidance (see
next step).

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
```

On success you get the **real result** (note content, workflow output, …). Use
`--json` whenever you need to parse the output into your answer — it prints the
full `InvokeResponse` (`ok`, `output`, `auditId`).

## Grants are default-deny — respect them

Plexus is secure by default: every call needs a **grant** (a short-lived, scoped
token). Many local-read capabilities auto-approve. Some require the user to
approve. If a call returns **`grant_pending_user`**, the CLI prints an approval
notice to stderr and polls. When you see this, **tell the user**: "Plexus needs
you to approve this capability — open the Plexus management UI at `/admin` (e.g.
`http://127.0.0.1:7077/admin`) and approve it; I'll continue once it's granted."
Do not try to bypass a grant.

## Failure handling — branch on the closed ErrorCode

On failure the CLI exits non-zero and prints a **closed `ErrorCode`**. Branch on
it deterministically (use `--json` so you can read `error.code`):

- `unknown_capability` → the id is wrong; re-run `plexus discover` for current ids.
- `grant_required` / `grant_pending_user` → ask the user to approve in `/admin`.
- `schema_validation_failed` → your `--input` is wrong; check the usage skill
  (`plexus skills <id>`) or `plexus manifest` for the input schema.
- `source_unavailable` → the backing local app isn't running; ask the user to
  start it.
- `no_connection_key` → the gateway isn't running; ask the user to start Plexus.

## Quick reference

| step | command |
|---|---|
| scan | `plexus discover` (`--json` to parse) |
| read usage guidance | `plexus skills <id>` |
| full schemas | `plexus manifest` (`--json`) |
| invoke | `plexus call <id> --input '<json>'` (`--json` to parse) |

Default to `--json` when you need to extract specific values; default to the
human format when you just need to read describes/skill bodies.
