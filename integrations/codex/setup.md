# Wiring Plexus into Codex — setup

Two things make Codex able to use Plexus:

1. the **`plexus` command** — the repo shim at `integrations/codex/bin/plexus`,
   which Codex runs by its **absolute path** (the AGENTS.md block spells it out), and
2. the **AGENTS.md instruction block** (so Codex knows it exists and how to use it).

Plexus is **not** an MCP server — there is no `/mcp` wire — so there is nothing to
put in `~/.codex/config.toml`'s `[mcp_servers]`. The integration is purely
"command + AGENTS.md instructions", driven by `codex exec` (or interactive Codex).

Codex authenticates with its **own per-agent PAT** — redeemed once from a one-time
enrollment code (the command's `enroll <code>`), never the admin connection-key.
Connect the agent first via the console's "Connect an agent" flow (pick
**Generic / other agent**) or `POST /admin/api/agents/connect` to get that code.

## Automatic vs manual

| Step | `setup.sh` does it? | Notes |
|---|---|---|
| Land the AGENTS.md block | ✅ automatic | into `./AGENTS.md` at the root of the project you run it from (override with `AGENTS_FILE=`), marker-guarded |
| Teach the command | ✅ automatic | the block names the shim's **absolute path** (`<repo>/integrations/codex/bin/plexus`) — no PATH entry needed |
| Symlink the shim into a PATH dir | ✳️ opt-in | only when you explicitly set `BIN_DIR=` (no default) |
| Start the Plexus gateway | ⚠️ manual | run `bin/plexus` in the repo (see `docs/getting-started.md`) |
| Connect the agent + enroll | ⚠️ manual | connect it in the console (or `POST /admin/api/agents/connect`) for a one-time code, then `<repo>/integrations/codex/bin/plexus enroll <code>` once to store this agent's PAT |
| `config.toml` `[mcp_servers]` entry | ❌ none | intentionally — Plexus has no MCP wire |

## Quick path

```sh
# from the PROJECT you run Codex in — the block lands at ./AGENTS.md there
bash /path/to/plexus/integrations/codex/setup.sh
```

Then make sure the gateway is running (in the repo):

```sh
bin/plexus          # boots the gateway on 127.0.0.1:7077
```

Enroll this agent once (redeem the one-time code from the Connect-an-agent flow),
then verify — by the shim's absolute path, exactly as the block teaches Codex:

```sh
/path/to/plexus/integrations/codex/bin/plexus enroll plx_enroll_XXXX   # once — stores this agent's PAT locally
/path/to/plexus/integrations/codex/bin/plexus list                     # lists the local capabilities (callable-now vs needs-approval)
```

## Manual path (if you prefer no script)

1. **Know the command.** Codex runs the shim `integrations/codex/bin/plexus` by its
   absolute path — the AGENTS.md block names that path, so there is nothing to wire.
   The shim resolves its own location and execs the shared CLI under Bun, so it
   works from anywhere as long as the repo stays in place. (Bun must be installed.)

2. **Add the AGENTS.md block.** Append the contents of
   `integrations/codex/AGENTS.plexus.md` to the `AGENTS.md` at the root of the
   project you run Codex in. The block is wrapped in
   `<!-- BEGIN PLEXUS --> … <!-- END PLEXUS -->` markers, ~2 KiB — well within
   Codex's `project_doc_max_bytes` (default 32 KiB) cap.

3. **Run the gateway**, then **connect + enroll this agent**: get a one-time code
   from the console's "Connect an agent" flow (or `POST /admin/api/agents/connect`)
   and run `<abs-shim-path> enroll <code>` once. That stores this agent's durable PAT
   locally; the command uses it on every later call. The agent never touches the
   admin connection-key.

## Per-project vs global AGENTS.md

- **Project** (`./AGENTS.md` at the project root — the default): only that
  project's Codex sessions see the block. Codex discovers it by itself (its
  AGENTS.md discovery walks git-root→cwd), so the project file alone is enough.
- **Global** (`AGENTS_FILE=~/.codex/AGENTS.md` — an explicit opt-in): **every**
  Codex session on this machine learns about this one agent's integration. Choose
  it only when you really want that machine-wide reach.

Codex merges global + project AGENTS.md, so both can coexist.
