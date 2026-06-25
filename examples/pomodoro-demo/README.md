# Plexus × DeepAgents demo — "一个只属于你的番茄钟"

**The one-line aha:** *a remote agent built real software on your Mac — and it never
had a shell, never left one folder, and you approved every powerful move.*

A remote DeepAgent reads your notes, writes a PRD, and then drives Claude Code to build
a working single-page pomodoro app — all on your machine, reaching it ONLY through
Plexus. See [`GOAL.md`](GOAL.md) for the full why.

## What this demo proves

- **资源侧代表 (resource-side authority).** Every mutating move
  (`workspace.write`, `claudecode.run`) **pends for you in the Plexus UI**; the agent
  blocks and polls until you approve. It cannot self-approve, and it cannot even
  perceive that a management key exists.
- **powerful 但被严控 (powerful, tightly confined).** The agent does real software
  engineering, yet it is locked to one authorized directory. Claude Code runs under a
  macOS `sandbox-exec` jail — never a raw shell — kernel-confined to that directory.
- **编译成原生 skill (compiled to the target framework).** Plexus capabilities are
  emitted as DeepAgents `SKILL.md` files; the agent loads them like any native skill.

## Architecture

Two layers — **do not conflate them**:

- **Remote DeepAgent** = the brain (this directory's `agent.py` / `run_demo.py`). It
  plans and drives, and reaches your Mac ONLY through Plexus skills. It holds nothing
  but a **connection-key** — no shell, no filesystem, no management key.
- **Claude Code** = a *capability Plexus exposes* (`claudecode.run`), used to actually
  write the app — `sandbox-exec`-confined to the authorized directory.

The flow:

```
remote DeepAgent ──(connection-key only)──► Plexus skills (compiled SKILL.md)
                                              │
                          ┌───────────────────┴───────────────────┐
                  workspace.list/read/write           claudecode.run({prompt})
                  (path-confined; write PENDS)         (sandbox-exec jail; PENDS)
                                              │
                              all resource-side-approved + confined + audited,
                              pinned to ONE authorized directory
```

| File | Role |
|---|---|
| `plexus_deepagents/` | the **Plexus → DeepAgents** emitter + HTTP helper (compiles capabilities → `SKILL.md`, runs the grant→poll→invoke flow). Generic; not pomodoro-specific. See its [README](plexus_deepagents/README.md). |
| `agent.py` | constructs the persona DeepAgent ("番茄喵工程师"): emits the Plexus skills, wires `plexus_skills_tools` + `create_deep_agent`. |
| `run_demo.py` | the two-act runner (`--setup`, `--act1`, `--act2`). |
| `seed/` | the demo input: `refs/*.md` (notes on real pomodoro apps) + `me.md` (the user's non-standard taste & 番茄喵 mascot). |
| `tests/` | unit tests that need **no** live Plexus and **no** LLM key. |
| `spikes/` | the `sandbox-exec` confinement proof (`SANDBOX-FINDINGS.md` + `cc-confine.sb`). |

## Prerequisites

1. **A running Plexus** on this Mac (the gateway is Bun + TypeScript; install
   [Bun](https://bun.sh) ≥ 1.3.0). Boot it with its `workspace.*` and `claudecode.run`
   capabilities pinned to the authorized directory, and the headless-CC launch gate on:

   ```bash
   export PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo/pomodoro"   # the ONE authorized dir
   export PLEXUS_CC_HEADLESS_LAUNCH=1                        # allow the real sandboxed CC spawn
   # …start Plexus per the root project's instructions (bun run start)…
   ```

   Plexus prints a **connection-key** — keep it for step 4. (Plexus also has a separate
   management/connection key the agent must never see; keeping that boundary is Plexus's
   job, not this demo's.) Claude Code must be installed and logged in on this Mac — the
   sandboxed CC authenticates via its own `~/.claude` config + the macOS Keychain.

2. **Python deps** (a venv is recommended):

   ```bash
   cd examples/pomodoro-demo
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt
   ```

3. **An LLM key for the agent's brain** — the developer brings their own. Default model
   is an Anthropic Claude model, so:

   ```bash
   export ANTHROPIC_API_KEY=sk-ant-…
   # optional: export PLEXUS_DEMO_MODEL=claude-sonnet-4-5
   ```

4. **The agent's connection to Plexus**:

   ```bash
   export PLEXUS_CONNECTION_KEY=<the connection-key Plexus printed>
   export PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo/pomodoro"   # same authorized dir
   # optional: export PLEXUS_BASE_URL=http://127.0.0.1:7077  (default)
   ```

## Run it — the exact command sequence

```bash
cd examples/pomodoro-demo

# Setup — seed the authorized dir from seed/ (OWNER side; the agent never does this)
python run_demo.py --setup

# Act 1 — agent reads refs/ + me.md → synthesizes → writes PRD.html (write PENDS)
python run_demo.py --act1
#   → approve the workspace.write grant in the Plexus UI when it pauses.
#   → then open  $HOME/PlexusDemo/pomodoro/PRD.html  in a browser.

# Act 2 — "build it": agent plans → scaffolds → calls claudecode.run (execute PENDS)
python run_demo.py --act2
#   → approve the claudecode.run grant in the Plexus UI when it pauses.
#   → then open  $HOME/PlexusDemo/pomodoro/index.html  in a browser.
```

Each act narrates what it's doing: the capabilities it compiled as skills, each grant
request, the **pending → polling → approved** wait, and the agent's final report.
`--setup` is the one place the runner (not the agent) copies the seed into the
authorized dir — simulating "the owner put their notes in the folder they chose to
expose." Everything after that goes through Plexus.

## What's verified automatically vs. the live run you drive

**Verified automatically — no live Plexus, no LLM key:**

```bash
cd examples/pomodoro-demo && python -m pytest tests/ -q
```

The Python tests assert the agent **builds** (a `CompiledStateGraph` carrying the Plexus
skills + the `plexus_invoke` tool), that the `SKILL.md` bundle lands under `plexus_skills/`,
that construction needs no provider key, that the two-act runner wires the right
capability calls, and they cover the grant-polling state machine + `SKILL.md` emission
against a fake in-process gateway. The repo's TypeScript gate covers the security
acceptance criteria in-process — resource-side approval (AC2), the live kernel-denial
proof for the sandbox (AC5, in `tests/claudecode-run.test.ts`), path confinement (AC6),
no management key on the agent surface / no self-escalation (AC7), and an auditable trail
(AC8). This demo verifies everything up to "press play."

**The live run you drive yourself** (needs your `ANTHROPIC_API_KEY`, a running Plexus,
and you approving grants in the UI): the actual model loop, the real resource-side
approval round-trips, the produced `PRD.html` and `index.html`, and CC doing real work
confined to the dir (AC1/AC3/AC4/AC9/AC10). Run the three commands above and approve the
grants when each act pauses.

## A note on confinement and CC's own credentials

The confinement claim is about **workspace/project files**, not Claude Code's own
credentials. The sandboxed CC uses ITS OWN `~/.claude` config + the macOS Keychain to
authenticate (a narrow, necessary exception — its OAuth token lives in the login
Keychain and refreshes in place). All *file work* stays kernel-confined to the authorized
dir; the rest of `$HOME` stays denied — `~/.ssh` and a sibling `~/Documents/private.txt`
were both blocked under the seatbelt (proven by [`spikes/SANDBOX-FINDINGS.md`](spikes/SANDBOX-FINDINGS.md)).

## Remote / tunnel note

For the "internet agent" story, the developer runs the agent behind their **own** tunnel
(cloudflared / tailscale) pointing at the loopback Plexus, and sets `PLEXUS_BASE_URL` to
the tunnel URL. This exposes the developer's OWN local Plexus through their OWN tunnel —
it is **NOT** Plexus opening itself to the internet. The **connection-key stays the only
auth boundary**, and **channel security is the developer's own concern, out of scope for
this demo** (per `GOAL.md` §2 / §8).

## deepagents wiring gotcha

Use `FilesystemBackend(root_dir=ROOT, virtual_mode=True)` with a **named** skills
subdirectory — `skills=["/plexus_skills"]`, not a bare `skills=["/"]` at the backend
root (a bare `/` source tripped a path-resolution edge case in deepagents 0.6.12).
`agent.py` does this for you.
