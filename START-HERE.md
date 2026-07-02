# START HERE — hand this repo to your AI

> **The AI-native way to onboard.** Open Claude Code (or any coding agent) in this
> repo and say:
>
> > **"read `START-HERE.md` and set up the pomodoro demo for me"**
>
> The agent does the whole thing conversationally — installs, builds, starts Plexus,
> configures it (asking you for the variable bits), seeds the demo, and runs both acts
> — while **you approve each grant in the Plexus UI** so you *feel* the resource-side
> trust model. By the end you'll have watched a remote agent build real software on your
> Mac, with no shell, locked to one folder, and every powerful move approved by you.
>
> Prefer to drive by hand? Everything below is also a normal copy-paste runbook —
> just skip the 🧑 prompts and pick the defaults.
>
> New here and want the *model* first (not the demo)? Read
> **[`docs/README.md`](docs/README.md)** — the developer reading path — then come back.

---

## For the agent reading this

You are setting up and running the **Plexus × DeepAgents pomodoro demo**. Execute the
steps below **in order**. They are **idempotent** — safe to re-run if a step already
happened. **Narrate each step in plain language** so the human watching follows along.

**Pause at every `🧑 ASK THE USER:`** — these are the decision points only the human can
answer (a folder, an API key, and — the heart of the demo — clicking **Approve** in the
Plexus UI). Do not guess past them.

What you're wiring up (so you understand the two layers and don't conflate the two
credentials):

- **The remote DeepAgent** (`examples/pomodoro-demo/`) is the *brain*. It plans and
  drives, and it reaches the Mac **only** through Plexus. It holds **its own per-agent
  PAT** (`plx_agent_…`), which it redeems **once** from a one-time enrollment code the
  admin mints for it — then stores and reuses. It **never** sees the admin
  **connection-key**, has no shell, no filesystem, no management access. (In a Claude Code
  agent this same "the PAT is the agent's only credential" role is embodied by a compiled
  `plexus-<agentId>` launcher on the Bash PATH; here it's the demo's Python client.)
- **Plexus** is the *resource-side gateway* on this Mac. The machine owner runs it and is
  the **admin** — the connection-key is theirs, and it reaches the management console. The
  owner exposes exactly two things to the agent: read/list/write to **one** authorized
  directory (`workspace.*`), and the ability to run **Claude Code** inside that directory
  (`claudecode.run`). Every mutating move **pends for the human** in the Plexus UI.

---

### Step 0 — Prerequisite checks

Run these and report what's missing before continuing.

```bash
bun --version       # need Bun ≥ 1.3.0 — https://bun.sh  (curl -fsSL https://bun.sh/install | bash)
claude --version    # Claude Code CLI — the demo's claudecode.run capability spawns it
python3 --version   # need Python >= 3.11 for the agent (deepagents requires it)
```

- **`bun` missing** → 🧑 ASK THE USER whether to install it
  (`curl -fsSL https://bun.sh/install | bash`), then re-check.
- **`claude` missing or not logged in** → the `claudecode.run` capability in Act 2 needs a
  working, authenticated Claude Code on this Mac (the sandboxed CC authenticates with its
  **own** `~/.claude` config + the macOS Keychain). 🧑 ASK THE USER to install Claude Code
  and run `claude` once to log in. (Act 1 does **not** need it — you can proceed and only
  block at Act 2 if it's still missing.)
- **`python3` missing or < 3.11** → 🧑 ASK THE USER to install Python ≥ 3.11 (deepagents
  requires it) before continuing.

### Step 1 — Install + (optional) confirm a healthy checkout

```bash
bun install                 # workspace monorepo install (idempotent)
```

🧑 ASK THE USER (optional): "Run the test gate to confirm a clean checkout?" If yes:

```bash
bash run-tests.sh           # the canonical gate: strict typecheck + bun test
bun run coverage            # (optional) line/function coverage report
```

This is a confidence check only — skip it if the user just wants the demo.

### Step 2 — START THE GATEWAY (owner / admin side)

You (the machine owner) start Plexus. **To avoid disturbing any Plexus the user already
runs, prefer an isolated instance** — its own state (connection-key, grants, audit) on its
own port, so it **never touches their main `~/.plexus` or port 7077**.

🧑 ASK THE USER two things:

1. **Which folder should the agent be allowed to touch?** (the ONE authorized directory)
   Default: `~/PlexusDemo/pomodoro`
2. **Isolated demo instance, or your existing Plexus?**
   Default (recommended): **isolated** — `PLEXUS_HOME=<temp dir>` + `PLEXUS_PORT=7191`,
   so this demo gets its own connection-key / audit and leaves their real instance alone.

Then start it (this command stays running — launch it in the background or a second
terminal). Substitute the chosen workspace dir; the isolated-instance values are shown:

```bash
# --- isolated demo instance (recommended) ---
export PLEXUS_HOME="$(mktemp -d -t plexus-demo)"        # throwaway state dir
export PLEXUS_PORT=7191                                  # off the default 7077
export PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo/pomodoro"  # the ONE authorized dir (the chosen folder)
export PLEXUS_CC_HEADLESS_LAUNCH=1                       # allow the REAL sandboxed Claude Code spawn

bun run start                                           # boots the gateway; stays running (Ctrl-C to stop)
```

> Using the user's **existing** Plexus instead? Omit `PLEXUS_HOME` and `PLEXUS_PORT`
> (it binds the default `127.0.0.1:7077`), but still set `PLEXUS_WORKSPACE_DIR` and
> `PLEXUS_CC_HEADLESS_LAUNCH=1`. Be aware this writes grants + audit into their real
> `~/.plexus`.

Open the admin UI so the user has the **approval surface** ready for later:

- Isolated instance: `http://127.0.0.1:7191/admin`
- Default instance: `http://127.0.0.1:7077/admin`

Tell the user: *"This is where you'll click **Approve** when the agent asks to write or to
run Claude Code."*

### Step 3 — CONNECT THE AGENT (admin side — mint a code + grant a starting cap-set)

This is the resource-side move: **the owner-as-admin connects the agent**. Plexus grants it
a starting cap-set and mints a **one-time enrollment code** — and that code (never the
connection-key) is the *only* thing the agent receives.

The console has a **Connect an agent** wizard (`/admin` → *Connect an agent*) that does
exactly this with clicks. To keep the runbook scriptable, drive it over the management API.
First capture the **admin connection-key** — the owner's management credential, read
straight from the instance's home (no server round-trip, and it **never** goes to the agent):

```bash
KEY=$(cat "$PLEXUS_HOME/connection-key")     # isolated instance
# default instance: KEY=$(cat ~/.plexus/connection-key)   (or: bun run print-key)
```

Now connect an agent named `pomodoro-demo`, granting **only the two reads** as standing:

```bash
curl -fsS -X POST "http://127.0.0.1:7191/admin/api/agents/connect" \
  -H "Host: 127.0.0.1:7191" \
  -H "X-Plexus-Connection-Key: $KEY" \
  -H "content-type: application/json" \
  -d '{"agentId":"pomodoro-demo","capabilities":["workspace.list","workspace.read"]}'
# → { "ok":true, "agentId":"pomodoro-demo", "code":"plx_enroll_…", "granted":[…], "skipped":[…] }
```

Read the `code` (`plx_enroll_…`) out of that response — it is single-use and expires in
**15 minutes**, so connect the agent right before Step 4.

Why grant **only** `workspace.list` + `workspace.read` here? Because the demo's whole point
is to *feel* the pending/approve moments:

- `workspace.write` is a **write** — we deliberately leave it ungranted so Act 1 **pends**.
- `claudecode.run` is an **execute** — it can **never** be standing (sensitivity ceiling,
  ADR-5): even if you listed it here it would come back under `skipped`, and it **pends per
  use**. That's the guarantee the demo shows off in Act 2.

### Step 4 — SET UP THE AGENT (the brain — enroll with the one-time code)

Build the Python venv and install the calling-side deps:

```bash
cd examples/pomodoro-demo
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

🧑 ASK THE USER for an LLM key for the agent's brain (they bring their own). **Use a frontier
model** — driving this agent (multi-step tool calls without dropping required args, enumerating
files, planning) needs **Anthropic Sonnet 4.6+** or **OpenAI GPT-5.x**. Weaker models
(`gpt-4.1` / `gpt-4.1-mini`, `anthropic/claude-sonnet-4`) were observed to loop to the recursion
limit, give up enumerating files, or hang — don't use them for this demo. `agent.py` supports
**both** key paths:

- **Anthropic direct:** `export ANTHROPIC_API_KEY=sk-ant-…` (defaults to `claude-sonnet-4-6`)
- **OpenRouter:** `export OPENROUTER_API_KEY=sk-or-…` (defaults to `anthropic/claude-sonnet-4.6`;
  or e.g. `export PLEXUS_DEMO_MODEL=openai/gpt-5.1`)

Now hand the agent its **one-time enrollment code** (from Step 3) — **not** the
connection-key. On first run the agent redeems the code (`POST /agents/enroll`) for its own
durable **PAT**, stores it in a local `.env` (mode 0600), and reuses that PAT from then on;
the code is consumed and useless afterward. Set these in the **same shell** you'll run the
acts from (use the **same authorized dir** as the gateway; for the isolated instance, point
the base URL at its port):

```bash
export PLEXUS_ENROLL_CODE="<the plx_enroll_… code from Step 3>"   # one-time; redeemed → PAT → stored
export PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo/pomodoro"           # SAME authorized dir as the gateway
export PLEXUS_BASE_URL="http://127.0.0.1:7191"                    # isolated instance; OMIT for the default 7077
```

> **The agent never gets the connection-key.** It authenticates with its own PAT, bound to
> the real `agentId` (`pomodoro-demo`) by the gateway at handshake. A leaked PAT costs *only*
> this one agent's pre-granted caps, and you can revoke it in isolation — it can never reach
> the management plane.

### Step 5 — SEED THE DEMO (owner side)

This copies the demo input (`refs/` notes on real pomodoro apps + `me.md`, the user's
quirky taste & the 番茄喵 mascot) into the authorized dir. It's the **one** direct
filesystem touch in the whole demo — it simulates *"the owner dropped their notes into the
folder they chose to expose."* The agent never does this; everything after goes through
Plexus.

```bash
# still inside examples/pomodoro-demo, with the venv + env from Step 4
.venv/bin/python run_demo.py --setup
```

### Step 6 — ACT 1: the agent writes a PRD (a write PENDS for the user)

The agent uses `workspace.list` + `workspace.read` (its standing-granted reads — **callable
now**, no prompt) to read the seed, synthesizes a Product Requirements Document, and calls
`workspace.write` to save `PRD.html`. **That write was never pre-granted — it PENDS.** The
agent blocks and polls; it **cannot self-approve**.

```bash
.venv/bin/python run_demo.py --act1
```

🧑 ASK THE USER to approve the **`workspace.write`** grant in the Plexus admin UI (the
`/admin` tab opened in Step 2 — look for the pending grant). Tell them *exactly* what
they're approving: *"the agent wants to write `PRD.html` into your authorized folder."*
When they click **Approve**, the agent's call unblocks and the file lands.

Then offer to open it:

```bash
open "$PLEXUS_WORKSPACE_DIR/PRD.html"
```

The PRD must capture **both** the standard pomodoro features **and** the user's
non-standard rules from `me.md` (the pixel-art 番茄喵, the grayscale 4th-pomodoro
forced-walk with the "我回来了" button, the fattening cat, the user-written break line, true
mute, localStorage-only). Narrate the 3-line summary the agent reports back.

### Step 7 — ACT 2: the agent builds the app via Claude Code (an execute PENDS)

The user says *"build it."* The agent reads `PRD.html` back, scaffolds, then calls
**`claudecode.run`** with a precise prompt. Claude Code does the real engineering — but
**sandbox-confined to the authorized directory** (a macOS `sandbox-exec` jail), never a raw
shell. `claudecode.run` is an **execute** capability, so it **PENDS** too — and because
execute can never be standing, it will pend **every** time, no matter how the owner
approved it before.

```bash
.venv/bin/python run_demo.py --act2
```

🧑 ASK THE USER to approve the **`claudecode.run`** grant in the Plexus UI. Tell them
*"the agent wants to run Claude Code inside your authorized folder to build the app."* It
may take **several minutes** — CC is doing a real multi-step build. This is expected; the
client HTTP timeout is already generous for it. The agent then verifies the result with
`workspace.list`/`workspace.read`, and may run a focused follow-up `claudecode.run` (which
PENDS again) if something essential is missing.

When it finishes, open the app:

```bash
open "$PLEXUS_WORKSPACE_DIR/index.html"
```

You should get a working single-page **番茄喵** pomodoro: the cat fattens per cycle, and
the 4th pomodoro forces a walk — the UI goes grayscale until you click **"我回来了"**.

### Step 8 — Cleanup + "what you just saw"

```bash
# Stop the gateway (Ctrl-C in its terminal, or kill the background job).
# If you used an ISOLATED instance, its state is a throwaway dir — safe to remove:
rm -rf "$PLEXUS_HOME"      # only the isolated demo's ~/.plexus-equivalent; never the user's real one
```

Then tell the user **what just happened** — this is the whole point:

- **Two separate credentials, never conflated.** You (the admin) held the **connection-key**
  and used it only to reach the console and connect the agent. The **agent** only ever held
  its own **PAT**, redeemed from a one-time code — it could not perceive that a management
  key exists, let alone use one.
- **Every powerful move was owner-approved.** The agent could not write `PRD.html` or run
  Claude Code until the user clicked **Approve**. It cannot self-grant, and `claudecode.run`
  (execute) can never go standing — it pends *every* time.
- **The agent stayed in one folder.** Claude Code did real software engineering yet was
  kernel-confined by `sandbox-exec` to the authorized directory — `~/.ssh` and the rest of
  `$HOME` stayed denied (see `examples/pomodoro-demo/spikes/SANDBOX-FINDINGS.md`).
- **It's all audited.** `GET /grants` and the audit trail show who/why/when for every grant
  and invoke. The owner can fully reconstruct what happened.

That trust story — *legible, scoped, revocable, audited* — **is** the product.

---

**More:** the demo's own walkthrough is in
[`examples/pomodoro-demo/README.md`](examples/pomodoro-demo/README.md); the full "why" is
in [`examples/pomodoro-demo/GOAL.md`](examples/pomodoro-demo/GOAL.md); the mental model is
in [`docs/concepts.md`](docs/concepts.md) and the developer path starts at
[`docs/README.md`](docs/README.md); Plexus itself starts at the repo
[`README.md`](README.md).
