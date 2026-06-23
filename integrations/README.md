# Plexus integrations — let mainstream coding agents USE Plexus

This directory is the **integration layer**: the tools that let mainstream coding
agents (Claude Code and OpenAI Codex CLI) actually USE the capabilities Plexus
exposes — both **callable API capabilities** and **usage skills** — and serve as
real **end-to-end test entry points** that drive the live protocol.

Plexus is a local capability gateway (`bin/plexus`, loopback `127.0.0.1:7077`) that
speaks its own AI-native protocol:

```
DISCOVER  GET  /.well-known/plexus     →  capability/skill/workflow summaries (scan)
UNDERSTAND POST /link/handshake        →  the FULL manifest (describe / io / skills)
GRANTED   PUT  /grants                 →  a short-lived, per-capability scoped token
CALL      POST /invoke                 →  the real result
```

…plus the **usage-skill layer MCP does not have** (`kind:"skill"` entries whose
markdown body is read **as context**, not invoked).

## The core integration insight: Plexus is NOT an MCP server

The obvious-looking path — drop a `{ "mcpServers": { ... "url": ".../mcp" } }`
entry into Claude Code's `.mcp.json` or Codex's `config.toml` — **does not work**,
because Plexus does not expose an `/mcp` Streamable-HTTP wire. MCP is an
*ingestion transport* Plexus runs as a **client** (to pull tools from MCP servers
into its own entry model); Plexus's *outward* surface is its own
discover→grant→invoke protocol. (A future MCP-server *façade* output adapter is
designed-for but not built — see `docs/protocol/PLEXUS-PROTOCOL.md` §6.)

So the clean, available-today integration for both agents is the **shared `plexus`
CLI driven over the agent's Bash/shell tool**. The CLI wraps the agent-side
`PlexusClient` (the exact engine in `examples/min-agent/client.ts`) and turns the
whole protocol into four shell-friendly verbs. Both agents:

1. learn Plexus exists and what it is for (a SKILL.md for CC, AGENTS.md for Codex),
2. **scan + call** Plexus capabilities by running `plexus discover` / `plexus call`,
3. receive Plexus's **usage skills** as context by running `plexus skills <id>`.

This keeps ONE engine and ONE protocol path; the per-agent wrappers are thin
"teach the agent + put the CLI on PATH" shells, not re-implementations.

## Layout

```
integrations/
├── README.md                  ← you are here (approach, layout, wrapper plans)
├── cli/                        ← the SHARED client engine (built; e2e-verified)
│   ├── plexus-cli.ts           ← the CLI: discover · manifest · skills · call
│   ├── bin/plexus              ← the executable both wrappers put on PATH
│   └── README.md
├── claude-code/                ← the Claude Code plugin (SKILL + bin/plexus) — SHIPPED
│   ├── .claude-plugin/plugin.json  skills/use-plexus/SKILL.md  bin/plexus
│   └── README.md
└── codex/                      ← the Codex integration (AGENTS.md + bin/plexus) — SHIPPED
    ├── AGENTS.plexus.md  bin/plexus  setup.sh  setup.md
    └── README.md
```

The e2e proof lives in `tests/integrations-cli-e2e.test.ts` (part of the gate):
it boots a real gateway with a real read-only Obsidian vault and drives the actual
CLI binary as a subprocess, asserting real discovered ids, a real fetched skill
body, and a real note's content through invoke.

## The shared `plexus` CLI (`integrations/cli/`)

Run it with Bun: `bun integrations/cli/bin/plexus <command>`. It auto-reads the
connection-key from `~/.plexus/connection-key` (a *local* agent needs no manual
paste), targets the gateway via `--url` / `PLEXUS_URL` / `PLEXUS_PORT`, always
sends the loopback `Host` header (the gateway's host/origin guard), and maps every
failure to the closed `ErrorCode` union so the wrapping agent branches
deterministically. `--json` makes any command machine-parseable.

| command | what it does | protocol |
|---|---|---|
| `discover` | **The scan.** One line per entry: id, kind, label, one-line describe, grant cost, transport. | `GET /.well-known/plexus` (pre-session, no key) |
| `manifest` | The FULL manifest — full describe / io / attached skills per entry. | `POST /link/handshake` |
| `skills [<id>]` | List `kind:"skill"` entries; with `<id>`, **FETCH that skill's body** (the usage knowledge). The "skill" half of "API + skill". | handshake + body (inline or `ref`) |
| `call <id> [--input <json>]` | handshake → request grant → if `grant_pending_user`, tell the user to approve in `/admin` and **poll** until resolved → invoke → print the REAL result. | full loop |

### Real transcript (against a booted gateway)

```
$ plexus discover
gateway: plexus v0.1.0 (protocol 0.1) @ http://127.0.0.1:52396
discovered 10 entries:
  • obsidian.vault.read
      capability · grants:read · transport:ipc · Read Obsidian vault "Vault"
      Read notes from the Obsidian vault "Vault" READ-ONLY.
  • obsidian.vault.how-to-cite
      skill · grants:— · transport:skill · How to cite an Obsidian vault
      Usage guidance for obsidian.vault.read: read notes by vault-relative path…
  • cc-master.orchestration.run  (workflow · grants:execute) …  + members + skills

$ plexus skills obsidian.vault.how-to-cite
──── obsidian.vault.how-to-cite — How to cite an Obsidian vault ────
# How to cite an Obsidian vault (read-only)
`obsidian.vault.read` exposes the user's Obsidian vault as a path-confined,
read-only view … (real bundled skill body)

$ plexus call obsidian.vault.read --input '{"path":"Projects/Plexus.md"}'
✓ obsidian.vault.read ok  (auditId evt_e7331d32-…)
──── output ────
{ "type": "file", "relativePath": "Projects/Plexus.md",
  "content": "# Plexus\nPlexus is a local capability gateway. The agent read THIS note via the protocol.\n",
  "bytes": 90, "modifiedAt": "2026-06-23T08:55:36.319Z" }
```

---

## Claude Code plugin (`integrations/claude-code/`) — SHIPPED

**Mechanism (confirmed).** A Claude Code *plugin* is a directory with
`.claude-plugin/plugin.json` (required: `name`, `description`; optional `version`,
`author`) plus, at the plugin root, any of: `skills/<name>/SKILL.md`, `commands/`,
`hooks/`, `.mcp.json`, and a `bin/` dir whose executables are **added to the Bash
tool's PATH while the plugin is active**. Skills auto-invoke from their
frontmatter `description`; `allowed-tools` can restrict a skill (e.g. to `Bash`).
Local dev load: `claude --plugin-dir <path>` (or the marketplace path). This
mirrors the existing `plugins/plexus-ext` and the installed `cc-master` plugin.

**Why a plugin (not `.mcp.json`).** Per the insight above, Plexus has no `/mcp`
wire — so the plugin does **not** ship an `mcpServers` entry. It teaches CC about
Plexus via a SKILL and exposes the `plexus` CLI on PATH for CC to run via Bash.

**What shipped:**

```
integrations/claude-code/
├── .claude-plugin/plugin.json     # name "plexus", description "Use the user's
│                                  # local Plexus capability gateway: scan, read
│                                  # usage skills, and call granted capabilities."
├── bin/plexus                     # shim → bun integrations/cli/bin/plexus "$@"
│                                  #   (so `plexus …` is on CC's Bash PATH)
└── skills/use-plexus/SKILL.md     # the teaching skill (below)
```

`skills/use-plexus/SKILL.md` frontmatter + body:
- `description`: *"Use the user's local Plexus capability gateway to discover and
  call local capabilities (read notes, run orchestrations, …) and to read Plexus's
  usage skills. Use when the user asks to use a local app/tool, read their Obsidian
  vault, or when a task needs a capability on this machine."*
- `allowed-tools: Bash`
- Body teaches the **discovery-first workflow**: (1) `plexus discover` to scan,
  (2) `plexus skills <id>` to read the usage knowledge BEFORE calling, (3)
  `plexus call <id> --input '<json>'` to invoke; parse with `--json`; on a
  `grant_pending_user` notice, tell the user to approve in `/admin`; branch on the
  closed `ErrorCode` printed on failure. Emphasize: read the attached skill first
  (that is Plexus's reason to exist over raw MCP).

**Acceptance:** in a CC session loaded with `--plugin-dir integrations/claude-code`,
asking "read my Obsidian note Projects/Plexus.md via Plexus" makes CC run
`plexus discover` → `plexus skills obsidian.vault.how-to-cite` → `plexus call
obsidian.vault.read --input '{"path":"Projects/Plexus.md"}'` and return the real note.

---

## Codex integration (`integrations/codex/`) — SHIPPED

**Mechanism (confirmed, codex-cli 0.141.0).** Codex reads instruction context from
**AGENTS.md** — global `~/.codex/AGENTS.md` and per-project `AGENTS.md` (walking
from the git root down to cwd; closer + `.override.md` files win; combined cap
`project_doc_max_bytes`, default 32 KiB). Codex consumes external tools via
`[mcp_servers.<name>]` in `~/.codex/config.toml` (stdio: `command`/`args`/`env`/
`startup_timeout_sec`; streamable-HTTP: `url`/`bearer_token_env_var`) — added with
`codex mcp add <name> -- <cmd…>` or `--url <url>`. Codex also has a skills
mechanism (`SKILL.md` under `.agents/skills/`, `~/.agents/skills/`) and a plugin
system (`.codex-plugin/plugin.json`). Non-interactive driving for e2e:
`codex exec [--sandbox …] [--ask-for-approval never] [-m <model>] "<prompt>"`
(prompt also via stdin; `--json` for event output; `-o <file>` for the last message).

**Why AGENTS.md + shell (not an MCP entry).** Same insight: Plexus has no `/mcp`
wire, so a `[mcp_servers.plexus]` entry has nothing to connect to. Codex already
has a capable shell; the clean path is to **teach Codex via AGENTS.md** that the
`plexus` CLI exists, and let it call the CLI from the shell.

**What shipped:**

```
integrations/codex/
├── AGENTS.plexus.md     # a drop-in instruction block teaching Codex the plexus CLI
│                        #   (the user appends/symlinks it into ~/.codex/AGENTS.md
│                        #    or a project AGENTS.md).
├── bin/plexus           # shim → bun integrations/cli/bin/plexus "$@" (put on PATH,
│                        #   e.g. symlink into ~/.local/bin or reference by abs path)
├── setup.sh             # idempotent: symlink bin/plexus onto PATH + append the
│                        #   AGENTS.md block (guarded by a marker comment).
└── setup.md             # the full setup walkthrough.
```

The `AGENTS.plexus.md` block teaches the same discovery-first workflow as the CC plugin, in Codex's
voice: *"This machine runs a local Plexus capability gateway. To use local
capabilities, run the `plexus` CLI from the shell: `plexus discover` to scan,
`plexus skills <id>` to read a capability's usage skill BEFORE calling it, then
`plexus call <id> --input '<json>'` to invoke. Use `--json` to parse. If a call
prints a `grant_pending_user` notice, tell the user to approve it in the Plexus
management UI (`/admin`). On failure, branch on the closed ErrorCode printed."*

**Acceptance:** with the AGENTS.md block installed and `plexus` on PATH,
`codex exec --ask-for-approval never "use Plexus to read my note Projects/Plexus.md"`
drives `plexus discover` → `plexus skills …` → `plexus call obsidian.vault.read …`
and returns the real note. (For a deterministic CI smoke, the wrapper can also call
the CLI directly without an LLM in the loop, asserting the same real output the
shared e2e test asserts.)

---

## Confirmed agent-mechanism findings (for the wrapper authors)

- **Claude Code** consumes external capability via: **plugins** (`plugin.json` +
  `skills/SKILL.md` + `bin/` on Bash PATH + optional `.mcp.json`). Skills
  auto-invoke from `description`; `bin/` executables join the Bash PATH while the
  plugin is active. ⇒ `claude-code/` = a plugin: SKILL (teach) + `bin/plexus` (run).
- **Codex CLI** consumes external capability via: **`config.toml` `[mcp_servers]`**
  (stdio or streamable-HTTP), **AGENTS.md** instruction context (global + project),
  a **skills** mechanism, and a plugin system; non-interactive `codex exec`.
  ⇒ `codex/` = AGENTS.md (teach) + `bin/plexus` on PATH (run), driven by `codex exec`.
- **Both** therefore integrate cleanly through the **same shared `plexus` CLI** over
  the shell — no `/mcp` wire needed, no per-agent protocol re-implementation.
```
