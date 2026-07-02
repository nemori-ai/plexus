# Plexus for OpenAI Codex CLI

Make **OpenAI's Codex CLI** understand Plexus, discover its capabilities, and call
them — so Codex becomes a real end-to-end entry point that uses Plexus-exposed
capabilities on this machine.

Unlike Claude Code (whose plugin the gateway **compiles per-agent** — see
[`docs/tutorials/connect-an-agent.md`](../../docs/tutorials/connect-an-agent.md)),
Codex integrates the portable way: **AGENTS.md instructions + a shared `plexus`
command on PATH**, driven by `codex exec` (or interactive Codex). Plexus is **not**
an MCP server — there is no `/mcp` wire — so a `[mcp_servers.plexus]` entry in
`~/.codex/config.toml` would have nothing to connect to. Codex already has a capable
shell, so the clean path is: teach Codex via AGENTS.md that the `plexus` command
exists, and let it run it from the shell.

```
enroll <code> (once)  →  list (discover)  →  <capabilityId> [args] (invoke)
  redeem code → PAT       what's callable now    the real result
```

The agent authenticates with its **own per-agent PAT**, redeemed once from a
one-time enrollment code. It never handles the admin connection-key, and the
`plexus` command is its complete interface — it never hand-rolls HTTP or guesses a
credential.

## What's here

| file | what it is |
|---|---|
| `AGENTS.plexus.md` | the drop-in instruction block (teaches Codex WHAT Plexus is, WHEN to use it, HOW via the `plexus` command: enroll → list → invoke). Marker-guarded (`<!-- BEGIN/END PLEXUS -->`), well under Codex's 32 KiB `project_doc_max_bytes` cap. |
| `bin/plexus` | the launcher Codex puts on PATH — a bash shim that resolves its own location and execs the shared CLI engine under Bun. |
| `setup.sh` | idempotent wiring: symlink `bin/plexus` onto PATH + append the AGENTS.md block. |
| `setup.md` | the full setup walkthrough — automatic vs manual, global vs project AGENTS.md. |

## Quickstart

```sh
# 1. Wire it (symlinks bin/plexus onto PATH + appends the AGENTS.md block).
bash integrations/codex/setup.sh
#    (if it warns ~/.local/bin isn't on PATH, add it to your shell rc.)

# 2. Start the Plexus gateway.
bin/plexus

# 3. Connect this agent: in the console's "Connect an agent" flow (or
#    POST /admin/api/agents/connect), pick the "Generic / other agent" type and a
#    starting cap-set. You get a one-time enrollment code (plx_enroll_…). Redeem it once:
plexus enroll plx_enroll_XXXX

# 4. Drive Codex non-interactively against it.
codex exec "Use Plexus to read my note Projects/Plexus.md and show me its contents."
```

> **Codex sandbox + loopback.** Codex sandboxes the commands it runs. The `plexus`
> command talks to the gateway over loopback HTTP (`127.0.0.1`), so Codex's command
> sandbox must permit that network. `codex exec` defaults to `read-only`, which
> blocks the loopback call. Allow it for the session you drive Plexus in — e.g.
> grant network in your Codex sandbox config, or for trusted automation use
> `--dangerously-bypass-approvals-and-sandbox`.

## The workflow Codex follows

With the AGENTS.md block installed and `plexus` on PATH, Codex follows the
discipline the block teaches — **enroll once, list, then invoke**:

```text
exec   plexus list --json                                             succeeded
         → capabilities marked callable-now vs needs-approval, incl.
           obsidian.vault.read (read), cc-master.* …
exec   plexus obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
         → { "ok": true, "output": { "content": "# Plexus\n…" }, "auditId": "evt_…" }
```

**A call that needs approval pends.** If a capability isn't already standing for
this agent — any `write` / `execute`, or any `extension` capability even for a read
— the command reports `grant_pending_user`; Codex relays the gateway's narration and
asks you to approve it in the console (`/admin` → **Pending**, with a trust-window),
then re-runs. A capability already granted at connect time just works.

## The deterministic gate (CI)

`tests/integrations-codex-e2e.test.ts` is the deterministic proof (no LLM in the
loop): it boots a real gateway + real read-only vault, then drives the
**Codex-facing shim by bare name `plexus`** with its dir on PATH (exactly how Codex
resolves it) against real data, and asserts the closed `ErrorCode` union on failure
(e.g. `unknown_capability`). Run it with `bash run-tests.sh`.
