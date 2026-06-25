# Plexus × DeepAgents demo — "一个只属于你的番茄钟"

A remote DeepAgent builds real software on your Mac — and it never has a shell,
never leaves one folder, and you approve every powerful move. See [`GOAL.md`](GOAL.md)
for the full why.

Two layers, do not conflate them:

- **Remote DeepAgent** = the brain (this directory's `agent.py` / `run_demo.py`). It
  plans and drives, and reaches your Mac ONLY through Plexus skills.
- **Claude Code** = a *capability Plexus exposes* (`claudecode.run`), used to actually
  write the app — sandbox-confined to the authorized directory.

The agent holds nothing but a **connection-key**. Every mutating move
(`workspace.write`, `claudecode.run`) **pends for you in the Plexus UI**; the agent
blocks and polls until you approve. It cannot self-approve.

## What's here

| File | Role |
|---|---|
| `plexus_deepagents/` | the **Plexus → DeepAgents** emitter + HTTP helper (compiles capabilities → `SKILL.md`, runs the grant→poll→invoke flow). Generic; not pomodoro-specific. |
| `agent.py` | constructs the persona DeepAgent: emits the Plexus skills, wires `plexus_skills_tools` + `create_deep_agent`. |
| `run_demo.py` | the two-act runner (`--setup`, `--act1`, `--act2`). |
| `seed/` | the demo input: `refs/*.md` (notes on real pomodoro apps) + `me.md` (the user's non-standard taste & 番茄喵 mascot). |
| `tests/` | unit tests that need **no** live Plexus and **no** LLM key. |

## Prerequisites

1. **A running Plexus** on this Mac, configured so its `workspace.*` and
   `claudecode.run` capabilities are pinned to the authorized directory:

   ```bash
   export PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo/pomodoro"   # the authorized dir
   export PLEXUS_CC_HEADLESS_LAUNCH=1                        # let it launch CC headless
   # …start Plexus per the root project's instructions…
   ```

   Plexus prints a **connection-key**. Keep it for the next step. (Plexus also has a
   management/connection key that the agent must never see — that boundary is Plexus's
   job, not this demo's.)

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

## Run it

```bash
cd examples/pomodoro-demo

# Setup — seed the authorized dir from seed/ (owner side; the agent never does this)
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

## What runs without Plexus or a key (the tests)

The agent **constructs** and the Plexus skills **emit + load through deepagents**
against a fake in-process gateway — no running Plexus, no LLM key needed:

```bash
cd examples/pomodoro-demo
python -m pytest tests/ -q
```

`tests/test_agent_build.py` asserts the agent builds (a `CompiledStateGraph` carrying
the Plexus skills + the `plexus_invoke` tool), that the SKILL.md bundle lands under the
named `plexus_skills/` subdir, that construction needs no provider key, and that the
two-act runner wires the right capability calls (read/list + `PRD.html` write in Act 1;
read-back + `claudecode.run` in Act 2). The pre-existing `tests/` cover the
grant-polling state machine + SKILL.md emission.

> **Needs a live Plexus + LLM key (the e2e task's job):** actually running an act —
> the model loop, the real resource-side approval round-trip, the produced `PRD.html`
> and `index.html`, and the CC-confinement negatives (`claudecode.run` locked to the
> dir). This demo verifies everything up to "press play".

## Remote-agent variant (out of scope here)

For the "internet agent" story, the developer runs the agent behind their **own** tunnel
(cloudflared / tailscale) pointing at the loopback Plexus, and sets `PLEXUS_BASE_URL` to
the tunnel URL. The connection-key stays the only auth boundary; **channel security is
the developer's own concern and out of scope for this demo** (per `GOAL.md` §2 / §8).

## deepagents wiring gotcha

Use `FilesystemBackend(root_dir=ROOT, virtual_mode=True)` with a **named** skills
subdirectory — `skills=["/plexus_skills"]`, not a bare `skills=["/"]` at the backend
root (a bare `/` source tripped a path-resolution edge case in deepagents 0.6.12).
`agent.py` does this for you.
