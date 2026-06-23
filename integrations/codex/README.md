# Plexus for OpenAI Codex CLI

Make **OpenAI's Codex CLI** understand Plexus, scan its capabilities, and call
them — so Codex becomes a real end-to-end entry point that uses Plexus-exposed
capabilities (the callable API **and** the usage skills).

The integration is **AGENTS.md instructions + the shared `plexus` CLI on PATH**,
driven by `codex exec` (or interactive Codex). Plexus is **not** an MCP server —
there is no `/mcp` wire — so a `[mcp_servers.plexus]` entry in `~/.codex/config.toml`
would have nothing to connect to. Codex already has a capable shell, so the clean,
available-today path is: teach Codex via AGENTS.md that the `plexus` CLI exists,
and let it call the CLI from the shell.

```
discover (scan)  →  skills <id> (read usage guidance)  →  call <id> --input … (invoke)
       GET /.well-known      handshake + body          handshake → grant → invoke
```

## What's here

| file | what it is |
|---|---|
| `AGENTS.plexus.md` | the drop-in instruction block (teaches Codex WHAT Plexus is, WHEN to use it, HOW via the `plexus` CLI). ~2.5 KiB — well under Codex's 32 KiB `project_doc_max_bytes` cap. Marker-guarded (`<!-- BEGIN/END PLEXUS -->`). |
| `bin/plexus` | the launcher Codex puts on PATH — a bash shim that resolves its own location and execs the shared CLI (`integrations/cli/bin/plexus`) under Bun. One engine, one protocol path. |
| `setup.sh` | idempotent wiring: symlink `bin/plexus` onto PATH + append the AGENTS.md block. |
| `setup.md` | the full setup walkthrough — automatic vs manual, global vs project AGENTS.md. |

## Quickstart

```sh
# 1. Wire it (symlinks bin/plexus onto PATH + appends the AGENTS.md block).
bash integrations/codex/setup.sh
#    (if it warns ~/.local/bin isn't on PATH, add it to your shell rc.)

# 2. Start the Plexus gateway (writes ~/.plexus/connection-key, which the CLI auto-reads).
bin/plexus

# 3. Drive Codex non-interactively against it.
codex exec "Use Plexus to read my note Projects/Plexus.md and show me its contents."
```

> **Codex sandbox + loopback.** Codex sandboxes the commands it runs. The `plexus`
> CLI talks to the gateway over loopback HTTP (`127.0.0.1`), so Codex's command
> sandbox must permit that network. `codex exec` defaults to `read-only`, which
> blocks the loopback call. Allow it for the session you drive Plexus in — e.g.
> grant network in your Codex sandbox config, or for trusted automation use
> `--dangerously-bypass-approvals-and-sandbox`. (See the real run below.)

## Real `codex exec` run (achieved here — not a mock)

Against a booted gateway + real read-only vault, with the AGENTS.md block as
Codex's global instructions (a throwaway `CODEX_HOME`) and `bin/plexus` on PATH,
**Codex (gpt-5.5, ChatGPT auth, codex-cli 0.141.0) drove the full workflow itself**:

```text
$ codex exec --dangerously-bypass-approvals-and-sandbox \
    "Use the plexus CLI to discover the available local capabilities, then read the
     usage skill for the Obsidian vault capability, then read the note
     Projects/Plexus.md and show me its contents. Use --json where helpful."

codex  I’ll use Plexus exactly in its discovery-first order: discover capabilities,
       read the Obsidian vault usage skill, then call the vault read capability…
exec   /bin/zsh -lc 'plexus discover --json'                          succeeded
         → gateway plexus v0.1.0; 10 entries incl. obsidian.vault.read (read) +
           obsidian.vault.how-to-cite (skill), cc-master.* …
codex  …reading that guidance before making the vault call.
exec   /bin/zsh -lc 'plexus skills obsidian.vault.how-to-cite --json'  succeeded
         → the real usage skill body (vault-relative paths, read-only, path-confined)
codex  The usage skill confirms paths are vault-relative … calling the note now.
exec   /bin/zsh -lc "plexus call obsidian.vault.read --input '{\"path\":\"Projects/Plexus.md\"}' --json"
         → { "ok": true, "output": { "content":
             "# Plexus\nPlexus is the user's local capability gateway.
              Codex read THIS note via the protocol.\n" }, "auditId": "evt_…" }
codex  Contents of `Projects/Plexus.md`:
       # Plexus
       Plexus is the user's local capability gateway. Codex read THIS note via the protocol.
```

Codex followed the AGENTS.md discipline exactly: **scan → read the usage skill
BEFORE calling → invoke** — and returned the real note content from the real
protocol. The throwaway `CODEX_HOME` means the user's real `~/.codex` was never
touched.

## The deterministic gate (CI)

`tests/integrations-codex-e2e.test.ts` is the deterministic proof (no LLM in the
loop): it boots a real gateway + real read-only vault, then runs the
**Codex-facing shim by bare name `plexus`** with its dir on PATH (exactly how
Codex resolves it) and asserts real `discover` / `skills` / `call` against real
data, plus the closed `unknown_capability` ErrorCode. Run it with `bash run-tests.sh`.
