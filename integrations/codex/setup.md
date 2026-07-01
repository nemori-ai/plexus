# Wiring Plexus into Codex — setup

Two things make Codex able to use Plexus:

1. the **`plexus` command on Codex's shell PATH** (so Codex can run it), and
2. the **AGENTS.md instruction block** (so Codex knows it exists and how to use it).

Plexus is **not** an MCP server — there is no `/mcp` wire — so there is nothing to
put in `~/.codex/config.toml`'s `[mcp_servers]`. The integration is purely
"command on PATH + AGENTS.md instructions", driven by `codex exec` (or interactive Codex).

Codex authenticates with its **own per-agent PAT** — redeemed once from a one-time
enrollment code (`plexus enroll <code>`), never the admin connection-key. Connect the
agent first via the console's "Connect an agent" flow (pick **Generic / other agent**)
or `POST /admin/api/agents/connect` to get that code.

## Automatic vs manual

| Step | `setup.sh` does it? | Notes |
|---|---|---|
| Symlink `bin/plexus` onto PATH | ✅ automatic | into `~/.local/bin` (override with `BIN_DIR=`) |
| Append the AGENTS.md block | ✅ automatic | into `~/.codex/AGENTS.md` (override with `AGENTS_FILE=`), marker-guarded |
| Ensure your `BIN_DIR` is on `$PATH` | ⚠️ manual | script warns + prints the `export PATH=…` line if it isn't |
| Start the Plexus gateway | ⚠️ manual | run `bin/plexus` in the repo (see `docs/getting-started.md`) |
| Connect the agent + enroll | ⚠️ manual | connect it in the console (or `POST /admin/api/agents/connect`) for a one-time code, then `plexus enroll <code>` once to store this agent's PAT |
| `config.toml` `[mcp_servers]` entry | ❌ none | intentionally — Plexus has no MCP wire |

## Quick path

```sh
# from the repo root
bash integrations/codex/setup.sh
# if it warns that ~/.local/bin isn't on PATH, add it to your shell rc:
#   export PATH="$HOME/.local/bin:$PATH"
```

Then make sure the gateway is running (in the repo):

```sh
bin/plexus          # boots the gateway on 127.0.0.1:7077
```

Enroll this agent once (redeem the one-time code from the Connect-an-agent flow),
then verify:

```sh
plexus enroll plx_enroll_XXXX      # once — stores this agent's PAT locally
plexus list                        # lists the local capabilities (callable-now vs needs-approval)
```

## Manual path (if you prefer no script)

1. **Put the shim on PATH.** Symlink (or copy) `integrations/codex/bin/plexus`
   into a directory on your PATH, e.g.:

   ```sh
   ln -sf "$PWD/integrations/codex/bin/plexus" ~/.local/bin/plexus
   ```

   The shim resolves its own location and execs the shared CLI under Bun, so it
   works from anywhere as long as the repo stays in place. (Bun must be installed.)

2. **Add the AGENTS.md block.** Append the contents of
   `integrations/codex/AGENTS.plexus.md` to your global Codex instructions at
   `~/.codex/AGENTS.md`, or to a project-level `AGENTS.md`. The block is wrapped in
   `<!-- BEGIN PLEXUS --> … <!-- END PLEXUS -->` markers, ~2 KiB — well within
   Codex's `project_doc_max_bytes` (default 32 KiB) cap.

3. **Run the gateway**, then **connect + enroll this agent**: get a one-time code
   from the console's "Connect an agent" flow (or `POST /admin/api/agents/connect`)
   and run `plexus enroll <code>` once. That stores this agent's durable PAT locally;
   the command uses it on every later call. The agent never touches the admin
   connection-key.

## Per-project vs global AGENTS.md

- **Global** (`~/.codex/AGENTS.md`): every Codex session on this machine knows
  about Plexus. Recommended for a personal machine.
- **Project** (`./AGENTS.md` at a repo root): only that project's Codex sessions
  see it. Use this if you only want Plexus available in specific repos.

Codex merges global + project AGENTS.md (walking from the git root down to cwd),
so both can coexist.
