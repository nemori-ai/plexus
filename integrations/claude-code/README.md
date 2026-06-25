# Plexus for Claude Code — make Claude Code use your local capabilities

This is a **Claude Code plugin** that turns Claude Code into a real entry point for
**Plexus**, the user's local capability gateway. It teaches Claude Code what Plexus
is and how to use it (a SKILL), and puts the shared `plexus` CLI on Claude Code's
Bash PATH (a `bin/`), so Claude Code can **scan → read the usage skill → call** any
local capability the user has registered — read their Obsidian vault, run cc-master
orchestration, anything Plexus exposes.

Plexus is **not** an MCP server (there is no `/mcp` wire), so this plugin does *not*
register an `mcpServers` entry. It integrates via the two confirmed Claude Code
plugin mechanisms instead: a **SKILL** (teach) + a **`bin/` executable on PATH**
(run).

## What's in here

```
integrations/claude-code/
├── .claude-plugin/plugin.json     # plugin manifest (name "plexus")
├── skills/use-plexus/SKILL.md     # teaches CC the discover → skill → call workflow
│                                  #   (auto-invokes from its description; allowed-tools: Bash)
├── bin/plexus                     # shim → `bun integrations/cli/bin/plexus "$@"`
│                                  #   (joins CC's Bash PATH while the plugin is active)
└── README.md                      # you are here
```

The `bin/plexus` shim forwards to the **shared** Plexus integration CLI
(`integrations/cli/`), which wraps the real discover → handshake → grant → invoke
protocol. One engine, one protocol path — this plugin is a thin teach-and-run shell.

## Prerequisites

- **Bun** on PATH (`https://bun.sh`) — the CLI runs with `bun`.
- A **running Plexus gateway** (`bin/plexus` in the Plexus repo; see
  `docs/getting-started.md`). It writes a connection-key to
  `~/.plexus/connection-key`, which the CLI auto-reads — a local agent needs no
  manual paste.

## Install into Claude Code

**Local dev (fastest):** point Claude Code at this directory.

```bash
claude --plugin-dir /path/to/plexus/integrations/claude-code
```

**Via a marketplace:** add the plugin to a Claude Code marketplace and install it by
name (`plexus`). Either way, once the plugin is active:

- the `use-plexus` SKILL is available and auto-invokes when a task needs a local
  capability, and
- `plexus` is on the Bash PATH, so the SKILL can run `plexus discover` / `plexus
  skills <id>` / `plexus call <id> …`.

## 60-second walkthrough — read a vault note via Plexus

1. **Start the gateway** with an Obsidian vault registered (see
   `docs/getting-started.md`). Confirm it's up:
   ```bash
   bun /path/to/plexus/integrations/cli/bin/plexus discover
   ```
   You should see `obsidian.vault.read` and a `…how-to-cite` skill.

2. **Launch Claude Code with this plugin:**
   ```bash
   claude --plugin-dir /path/to/plexus/integrations/claude-code
   ```

3. **Ask Claude Code:**
   > Use Plexus to read my Obsidian note `Projects/Plexus.md`.

   The `use-plexus` SKILL kicks in and Claude Code runs, over Bash:
   ```bash
   plexus discover                                # scan: finds obsidian.vault.read
   plexus skills obsidian.vault.how-to-cite       # reads how to cite the vault
   plexus call obsidian.vault.read --input '{"path":"Projects/Plexus.md"}'
   ```
   and returns the **real** note content.

4. **If a capability needs approval**, the call returns `grant_pending_user`; Claude
   Code will tell you to open the Plexus management UI (`http://127.0.0.1:7077/admin`)
   and approve it. Once approved, it proceeds.

## How it's verified

- **Deterministic gate** — `tests/integrations-cc-e2e.test.ts` boots a real gateway
  + a real read-only Obsidian vault and drives **this plugin's `bin/plexus` shim** as
  a subprocess through the exact `discover` → `skills` → `call` mechanism the SKILL
  instructs, asserting real discovery, a real skill body, and a real note read back.
- **Agent-driven demo** — drive headless Claude Code against a booted gateway:
  ```bash
  claude -p "Use Plexus to read my Obsidian note Projects/Plexus.md" \
    --plugin-dir /path/to/plexus/integrations/claude-code
  ```
  and watch it discover + call the capability for real.
