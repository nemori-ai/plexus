# Plexus × DeepAgents demo — "一个只属于你的番茄钟"

**The one-line aha:** *a remote agent built real software on your Mac — and it never
had a shell, never left one folder, and you approved every powerful move.*

A remote DeepAgent reads your notes, writes a PRD, and then drives Claude Code to build a
working single-page pomodoro app — all on your machine, reaching it **only** through
Plexus, with **you** approving each powerful step.

> **Want your AI to set this up for you?** Open Claude Code in the repo root and say
> *"read `START-HERE.md` and set up the pomodoro demo."* It installs, starts Plexus,
> configures everything, seeds the demo, and runs both acts while you approve the grants.
> **→ [`../../START-HERE.md`](../../START-HERE.md).** The rest of this page is the
> hands-on walkthrough.

---

## What you'll experience

The demo runs in two acts. **You are the machine owner** — at the powerful moments, the
agent pauses and waits for *you* to click **Approve** in the Plexus admin UI
(`http://127.0.0.1:7077/admin`, or `:7191` for the isolated demo instance). Nothing
mutating happens until you do.

**Act 1 — the agent organizes your notes into a PRD.**
The agent reads the seeded `me.md` (your quirky taste + the pixel-art **番茄喵** mascot) and
your `refs/` notes on real pomodoro apps, synthesizes them, and goes to write `PRD.html`.

- 👀 **What you see:** a console narration of each capability it compiled as a skill, then
  a clear **GRANT PENDING** pause on `workspace.write`.
- ✋ **Where you approve:** the Plexus UI shows *"the agent wants to write `PRD.html`."*
  Click **Approve** → the agent unblocks and the file lands.
- 📄 **What you get:** open `PRD.html` in a browser — a cozy, lo-fi spec that captures
  **both** the standard pomodoro features **and** your non-standard rules (faithfully, not
  a generic template).

**Act 2 — you say "build it," and the agent drives Claude Code to build the app.**
The agent reads the approved PRD back, scaffolds, then calls `claudecode.run` with a
precise prompt. Claude Code does the real engineering — **sandbox-confined to the one
authorized folder**, never a raw shell.

- 👀 **What you see:** a **GRANT PENDING** pause on `claudecode.run` (an *execute*
  capability), then a multi-minute real build. The agent verifies the result and may run a
  focused follow-up (which pends again).
- ✋ **Where you approve:** the Plexus UI shows *"the agent wants to run Claude Code inside
  your authorized folder."* Click **Approve**.
- 🍅 **What gets built:** a single-page **番茄喵** pomodoro app (`index.html`). It's a
  standard timer at its core, but all the value is in your quirks — the pixel-art cat that
  **fattens one level per completed cycle**, and the **4th-pomodoro forced walk**: the UI
  goes **grayscale** until you click **"我回来了"**. Breaks show only the one line you wrote
  yourself. True mute, localStorage only, no account.

**The aha by the end:** a remote agent did real software engineering on your Mac, yet it
held nothing but a connection-key, stayed locked to one folder, and **every** powerful move
was something *you* approved — and all of it is in the audit trail.

> Curious what a finished run looks like before you run your own? Open
> [`e2e-artifacts/`](e2e-artifacts/) — a **real run's output you can open**: the produced
> `PRD.html` and `index.html`, plus an `audit-excerpt.json` showing the approved grants.

---

## Run it yourself — the exact command sequence

**Prerequisites** (the [`START-HERE.md`](../../START-HERE.md) agent flow handles all of
this for you):

1. **A running Plexus** on this Mac, demo-configured — the authorized dir pinned and the
   headless-CC launch gate on. From the repo root:

   ```bash
   export PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo/pomodoro"   # the ONE authorized dir
   export PLEXUS_CC_HEADLESS_LAUNCH=1                        # allow the real sandboxed CC spawn
   # To keep the demo off your main instance, run an isolated one:
   #   export PLEXUS_HOME="$(mktemp -d -t plexus-demo)"  PLEXUS_PORT=7191
   bun install && bun run start                             # prints the URL; stays running
   ```

   Read the connection-key from `<PLEXUS_HOME>/connection-key` (default
   `~/.plexus/connection-key`, or `bun run print-key`). Claude Code must be installed and
   logged in — the sandboxed CC authenticates via its own `~/.claude` + the macOS Keychain.

2. **The agent (the brain)** — Python ≥ 3.11, a venv, + an LLM key you bring yourself.
   **Use a frontier model** (Anthropic Sonnet 4.6+ or OpenAI GPT-5.x) — weaker models
   (`gpt-4.1*`, `anthropic/claude-sonnet-4`) can't reliably drive the agent (they loop,
   give up enumerating files, or hang):

   ```bash
   cd examples/pomodoro-demo
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

   export ANTHROPIC_API_KEY=sk-ant-…                         # defaults to claude-sonnet-4-6
   #   export OPENROUTER_API_KEY=sk-or-…                     # OR, via OpenRouter:
   #   export PLEXUS_DEMO_MODEL=anthropic/claude-sonnet-4.6  #   (or openai/gpt-5.1)

   export PLEXUS_CONNECTION_KEY="<the key Plexus printed>"
   export PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo/pomodoro"  # SAME authorized dir
   #   export PLEXUS_BASE_URL=http://127.0.0.1:7191         # isolated instance only (default :7077)
   ```

**The three commands:**

```bash
cd examples/pomodoro-demo

# Setup — seed the authorized dir from seed/ (OWNER side; the agent never does this)
.venv/bin/python run_demo.py --setup

# Act 1 — agent reads refs/ + me.md → synthesizes → writes PRD.html (write PENDS)
.venv/bin/python run_demo.py --act1
#   → approve the workspace.write grant in the Plexus UI when it pauses.
#   → then open  $PLEXUS_WORKSPACE_DIR/PRD.html  in a browser.

# Act 2 — "build it": agent plans → scaffolds → calls claudecode.run (execute PENDS)
.venv/bin/python run_demo.py --act2
#   → approve the claudecode.run grant in the Plexus UI when it pauses.
#   → then open  $PLEXUS_WORKSPACE_DIR/index.html  in a browser.
```

Each act narrates what it's doing: the capabilities it compiled as skills, each grant
request, the **pending → polling → approved** wait, and the agent's final report.
`--setup` is the one place the runner (not the agent) copies the seed into the authorized
dir — simulating "the owner put their notes in the folder they chose to expose."
Everything after that goes through Plexus.

---

## What this demo proves

- **资源侧代表 (resource-side authority).** Every mutating move
  (`workspace.write`, `claudecode.run`) **pends for you in the Plexus UI**; the agent
  blocks and polls until you approve. It cannot self-approve, and it cannot even perceive
  that a management key exists.
- **powerful 但被严控 (powerful, tightly confined).** The agent does real software
  engineering, yet it is locked to one authorized directory. Claude Code runs under a
  macOS `sandbox-exec` jail — never a raw shell — kernel-confined to that directory.
- **编译成原生 skill (compiled to the target framework).** Plexus capabilities are emitted
  as DeepAgents `SKILL.md` files; the agent loads them like any native skill.

---

## Architecture

Two layers — **do not conflate them**:

- **Remote DeepAgent** = the brain (this directory's `agent.py` / `run_demo.py`). It plans
  and drives, and reaches your Mac ONLY through Plexus skills. It holds nothing but a
  **connection-key** — no shell, no filesystem, no management key.
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
| `e2e-artifacts/` | a real run's output you can open (`PRD.html`, `index.html`, an audit excerpt). |
| `tests/` | unit tests that need **no** live Plexus and **no** LLM key. |
| `spikes/` | the `sandbox-exec` confinement proof (`SANDBOX-FINDINGS.md` + `cc-confine.sb`). |

---

## How it was built (for the curious)

This demo is the deliverable of a build spec — read these if you want to go deeper than
running it:

- **[`GOAL.md`](GOAL.md)** — the full "why": the strategy points it坐实s, the role/boundary
  model, the capability surface, and the acceptance criteria (AC1–AC10) the whole thing is
  contracted against.
- **[`spikes/SANDBOX-FINDINGS.md`](spikes/SANDBOX-FINDINGS.md)** + `spikes/cc-confine.sb` —
  the `sandbox-exec` confinement spike that proves CC's *file work* stays kernel-confined to
  the authorized dir while `~/.ssh` and a sibling `~/Documents/private.txt` stay denied.

**Acceptance criteria, at a glance** (full text + endpoint-verifiable detail in `GOAL.md`):

| AC | Claim |
|---|---|
| AC1 Connect | with only the connection-key, the agent discovers capabilities as skills and can invoke a read with no extra wiring. |
| AC2 Resource-side approval | `workspace.write` does not execute until the owner approves; the agent blocks; rejection aborts cleanly. |
| AC3 Non-standard captured | `PRD.html` reflects **both** standard pomodoro features and the non-standard items from `me.md`. |
| AC4 Real artifact | the Act-2 single-page app opens, runs, and implements the quirky 4th-pomodoro rule. |
| AC5 CC confined | `claudecode.run` runs CC locked to the dir; a probe proves out-of-dir read/write FAILS; no generic shell. |
| AC6 Path confinement | no exposed capability can read/write outside the dir; traversal attempts are rejected. |
| AC7 No self-escalation | the agent cannot self-grant; no management key is reachable via any API it can see. |
| AC8 Auditable | `GET /grants` + the audit trail show every grant (who/why/when/approved-by) and every invoke. |
| AC9 Remote posture | the chain works with the agent treated as remote; it holds only the connection-key. |
| AC10 Reproducible | one documented runner brings up Plexus + the example agent and drives both acts. |

### What's verified automatically vs. the live run you drive

**Verified automatically — no live Plexus, no LLM key:**

```bash
cd examples/pomodoro-demo && .venv/bin/python -m pytest tests/ -q
```

The Python tests assert the agent **builds** (a `CompiledStateGraph` carrying the Plexus
skills + the `plexus_invoke` tool), that the `SKILL.md` bundle lands under `plexus_skills/`,
that construction needs no provider key, that the two-act runner wires the right capability
calls, and they cover the grant-polling state machine + `SKILL.md` emission against a fake
in-process gateway. The repo's TypeScript gate (`bash run-tests.sh` from the repo root)
covers the security acceptance criteria in-process — resource-side approval (AC2), the live
kernel-denial proof for the sandbox (AC5, in `tests/claudecode-run.test.ts`), path
confinement (AC6), no management key on the agent surface / no self-escalation (AC7), and an
auditable trail (AC8). This demo verifies everything up to "press play."

**The live run you drive yourself** (needs your LLM key, a running Plexus, and you
approving grants in the UI): the actual model loop, the real resource-side approval
round-trips, the produced `PRD.html` and `index.html`, and CC doing real work confined to
the dir (AC1/AC3/AC4/AC9/AC10). Run the three commands above and approve the grants when
each act pauses.

### A note on confinement and CC's own credentials

The confinement claim is about **workspace/project files**, not Claude Code's own
credentials. The sandboxed CC uses ITS OWN `~/.claude` config + the macOS Keychain to
authenticate (a narrow, necessary exception — its OAuth token lives in the login Keychain
and refreshes in place). All *file work* stays kernel-confined to the authorized dir; the
rest of `$HOME` stays denied — `~/.ssh` and a sibling `~/Documents/private.txt` were both
blocked under the seatbelt (proven by [`spikes/SANDBOX-FINDINGS.md`](spikes/SANDBOX-FINDINGS.md)).

### Remote / tunnel note

For the "internet agent" story, the developer runs the agent behind their **own** tunnel
(cloudflared / tailscale) pointing at the loopback Plexus, and sets `PLEXUS_BASE_URL` to
the tunnel URL. This exposes the developer's OWN local Plexus through their OWN tunnel — it
is **NOT** Plexus opening itself to the internet. The **connection-key stays the only auth
boundary**, and **channel security is the developer's own concern, out of scope for this
demo** (per `GOAL.md` §2 / §8).

### deepagents wiring gotcha

Use `FilesystemBackend(root_dir=ROOT, virtual_mode=True)` with a **named** skills
subdirectory — `skills=["/plexus_skills"]`, not a bare `skills=["/"]` at the backend root
(a bare `/` source tripped a path-resolution edge case in deepagents 0.6.12). `agent.py`
does this for you.
