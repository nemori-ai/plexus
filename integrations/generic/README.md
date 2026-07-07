# Plexus for any agent (generic integration)

Make **any AI agent with a shell** understand Plexus, discover its capabilities, and
call them — so the agent becomes a real end-to-end entry point that uses Plexus-exposed
capabilities on this machine. This is the **portable** integration: it works for any
agent that isn't Claude Code (which gets a bespoke compiled plugin instead).

The integration is two pieces:

- **an instruction block** (`AGENTS.plexus.md`) you drop into your agent's instructions,
  teaching it WHAT Plexus is, WHEN to use it, and HOW — via the `plexus` command; and
- **a `plexus` command on PATH** the agent runs. Plexus is **not** an MCP server and not
  an HTTP API you call directly — there is no wire to configure. The agent already has a
  shell, so the clean path is: teach it the `plexus` command exists, and let it run it.

```
enroll <code> (once)  →  list (discover)  →  <capabilityId> [args] (invoke)
  redeem code → PAT       what's callable now    the real result
```

The agent authenticates with its **own per-agent PAT** (`plx_agent_…`), redeemed once
from a one-time enrollment code. It never handles the admin connection-key, and the
`plexus` command is its complete interface — it never hand-rolls HTTP or guesses a
credential.

## What's here

| file | what it is |
|---|---|
| `AGENTS.plexus.md` | the drop-in instruction block (teaches the agent WHAT Plexus is, WHEN to use it, HOW via the `plexus` command: enroll → list → invoke). Marker-guarded (`<!-- BEGIN/END PLEXUS -->`). Agent-agnostic. This is the SAME text the gateway serves as the copy-able instruction in the console's **Connect an agent** flow. |
| `bin/plexus` | the launcher the agent puts on PATH — a bash shim that resolves its own location and execs the shared CLI engine under node/bun. |
| `setup.sh` | idempotent, repo-mode wiring: symlink `bin/plexus` onto PATH + land the AGENTS.plexus.md block. |

## Two ways to install

### 1. From the Plexus console (recommended)

In the console's **Connect an agent** flow, pick the **Generic / other agent** type and a
starting cap-set. Step 3 hands you a **self-contained setup command**:

```sh
curl -fsSL <gateway>/integration/<agentId>/setup.sh | bash
```

That served `setup.sh` is self-contained (it inlines the sanctioned engine — no repo
needed), **code-free**, and **key-free**: it installs the `plexus` CLI on PATH, pins the
gateway, and lands the filled-in `AGENTS.plexus.md`. The console also shows your **one-time
enroll code** separately — after setup, run once:

```sh
plexus enroll plx_enroll_XXXX
```

The full instruction text is copy-able in the console too, if you'd rather paste it
straight into your agent.

### 2. From this repo

```sh
# Wire it (symlinks bin/plexus onto PATH + lands the AGENTS.plexus.md block).
bash integrations/generic/setup.sh
#    (if it warns ~/.local/bin isn't on PATH, add it to your shell rc.)

# Ask your administrator for a one-time code, then redeem it once:
plexus enroll plx_enroll_XXXX
```

## The deterministic gate (CI)

`tests/integrations-generic-e2e.test.ts` is the deterministic proof (no LLM in the loop):
it boots a real gateway + real read-only vault, fetches the served `setup.sh`, runs it in
an **isolated** agent home, then drives the installed `plexus` command by bare name against
real data — enroll (with the mgmt-only code) → list → invoke — and asserts the admin
connection-key is **absent** from the agent home and from every served file (ADR-019).
