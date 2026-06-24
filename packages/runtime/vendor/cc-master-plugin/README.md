# cc-master

> 中文版见 [README_zh.md](README_zh.md)。

![version](https://img.shields.io/badge/version-0.9.1-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![ship-anywhere](https://img.shields.io/badge/ship--anywhere-Bedrock%20%7C%20Vertex%20%7C%20Foundry-7c3aed)
![requires](https://img.shields.io/badge/requires-Node%2022%2B%20%2B%20bash-orange)
![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-d97757)

**Hand Claude Code a goal too big for one session — and let it conduct itself to the finish.**

![cc-master live board — an interactive DAG graph view of an orchestration, tasks as nodes wired by dependency edges, colored by status](docs/images/view-graph-dark.png)

*The live board, visualized: every task a node, every dependency an edge — the orchestrator's whole plan at a glance.*

A long-horizon goal shouldn't die at the next context compaction. You hand the agent two days of work; it makes real progress, the context fills, and one compaction later it has forgotten it was ever orchestrating — now it's *busy looking busy and shipping nothing*. cc-master is the layer that doesn't forget.

It's a ship-anywhere Claude Code plugin that turns any main-session agent into a long-horizon **master orchestrator**: it decomposes the goal into a dependency graph, dispatches background work in parallel, keeps the main thread *productively* advancing in every idle window, and survives repeated compaction and cross-session restarts without losing the thread. It is **not a framework** — just commands + 3 skills + hooks + one board file.

```
/cc-master:as-master-orchestrator <a goal worth >24h of work>
```

That one command bootstraps a persistent board and makes the session the orchestrator. **Sixty seconds from clone to running.** ↓ See exactly what you get vs. plain Claude Code.

---

## Three paradigms, side by side

Dynamic workflows (shipped with Opus 4.8) gave Claude Code real parallelism — fan out hundreds of agents from one script. But for a *long-horizon* goal two gaps remain: the official model only promises the main session stays **responsive**, never that the orchestrator stays **productive**; and nothing carries your **role and progress across compaction**. cc-master fills exactly that gap — it doesn't replace dynamic workflows, it *wraps* them.

Here is the same long goal — *"internationalize an app into 6 locales"* — run three ways:

```mermaid
flowchart LR
    subgraph A["① Before dynamic workflows"]
        direction TB
        a1["You hold the whole plan<br/>in one context"]
        a2["Dispatch ONE sub-agent,<br/>block, wait for it"]
        a3["…repeat, serially"]
        a4["Compaction wipes role<br/>+ progress → lost"]
        a1 --> a2 --> a3 --> a4
    end
    subgraph B["② With dynamic workflows"]
        direction TB
        b1["You author a JS script<br/>(fan-out / pipeline)"]
        b2["Runtime runs 10s–100s of<br/>agents in the background"]
        b3["Main thread is <i>responsive</i><br/>but idle — no state to push"]
        b4["No mid-run HITL;<br/>resume = same session only"]
        b1 --> b2 --> b3 --> b4
    end
    subgraph C["③ With cc-master"]
        direction TB
        c1["One command → you ARE<br/>the master orchestrator"]
        c2["Goal → dependency DAG<br/>on a persistent board"]
        c3["Mix shell + sub-agent +<br/>workflow; dispatch on ready"]
        c4["Idle windows: verify last,<br/>plan next, ask user, distil"]
        c5["Hooks re-inject role + board<br/>across compaction & sessions"]
        c1 --> c2 --> c3 --> c4 --> c5
    end

    classDef before fill:#fde8e8,stroke:#e53e3e,color:#1a202c;
    classDef during fill:#fef5e7,stroke:#dd9b1f,color:#1a202c;
    classDef after fill:#e6fffa,stroke:#2c7a7b,color:#1a202c;
    class a1,a2,a3,a4 before;
    class b1,b2,b3,b4 during;
    class c1,c2,c3,c4,c5 after;
```

Every claim in column ③ is anchored to a real mechanism, not a marketing line:

|  | ① Before | ② Dynamic workflows | ③ cc-master | ③ is backed by |
|---|---|---|---|---|
| **Parallelism** | One sub-agent at a time | Tens–hundreds of agents | Shell + sub-agent + workflow, mixed | the three background mechanisms |
| **Main thread while waiting** | Blocked, or doing it by hand | Responsive but idle | Proactive: verify · look-ahead · HITL · distil | the decision program (Skill A) |
| **Survives compaction** | No | No | **Yes** — role + board re-injected | `reinject.sh` (SessionStart hook) |
| **Cross-session resume** | No | Same-session only | **Yes** — re-discovered from the board file | the board (persistent save file) |
| **Endpoint verification** | Ad hoc | Inside the script | Orchestrator verifies independently | lens 6 + the decision program (Skill A) |
| **Quota awareness** | No | No | **Yes** — account-authoritative 5h/**7d** `used_percentage` (captured from the status line; local-derived 反推 as fallback) | `usage-pacing.js` (Stop hook) + `statusline-capture.js` + `cc-usage.sh` |

---

## New in 0.9.0 — nest the graph, brief the decision

0.9.0 makes the board itself deeper and the human-in-the-loop smarter: a goal too big for one flat task list can now own *nested* scheduling subgraphs, and every decision the orchestrator routes to you arrives as a prepared interview instead of a context-less ping.

### dag-in-dag — nested scheduling subgraphs (max depth 1)

A goal at real scale doesn't fit one flat `tasks[]` — you want it grouped by module or phase. 0.9.0 lets an **owner** node own a layer of child tasks (a sub-plan), while cc-master keeps scheduling those children itself — dispatch, WIP, endpoint verification, watchdog all still apply. It stays **one flat board file**: every task remains top-level in `tasks[]`, and nesting is expressed by a single new relationship field, `tasks[].parent`. Two orthogonal edges do two jobs — `deps` (scheduling: open, can point anywhere, fires the moment its upstream is ready) and `parent` (containment / rollup: encapsulated, a child has at most one owner). `parent` enters the hard narrow-waist (the biggest hook change in cc-master's history); a `done` owner whose children aren't all done trips a **non-blocking** Stop-gate reminder, never a hard block. (See [ADR-012](adrs/ADR-012-parent-waist-and-rollup-aware-stop-gate.md).)

It ships with a **graph-analysis library + CLI** (`board-graph.js`, reused by the hooks too): machine-compute the critical path / CPM (with honest `weight_source` labeling — it reports structure, not fake hours, when timestamps are missing), parallelism (T₁/T∞), impact (which node gates the most downstream), the ready set, and owner rollup — for when the dependency graph gets too tangled to mental-math reliably.

### Decision-briefing — every decision routed to you arrives prepared

When orchestration hits a call only a human can make (`blocked_on:"user"`), you used to get parachuted into a context-less decision point. 0.9.0 turns it into a **prepared interview**. While idle, the orchestrator attaches a self-explaining `decision_package` to the node (the narrative context, the question, what it needs — decision / advice / solution — and the options with their trade-offs). `/cc-master:view` renders it as a **rich decision card** with a one-click copy of the entry command. You run **`/cc-master:discuss <node-id>`** in a separate, full-strength session: it loads the briefing, **freshness-checks** it (re-grounds if the upstream moved since it was prepared), talks the decision through with you, and writes the conclusion to a sidecar — never the board. The orchestrator digests that sidecar on its next reconcile and replans. Your time and the orchestrator's are fully decoupled — and because a separate session runs the discussion, the "conductor never plays an instrument" red line gets *stronger*, not weaker.

---

## New in 0.8.0 — orchestrate straight through the quota wall

A long-horizon run doesn't stop being long just because you hit a quota limit. 0.8.0 adds the missing piece for runs that outlast a single account's 5h/7d window — and pairs it with the safe account pool and the two-sided pacing that make it land cleanly.

### Hot account switching — no restart, no lost state

Mid-orchestration, you slam into the 5h or 7d quota wall. Before 0.8.0, that was the end of the run. Now cc-master can switch you to a backup account **without restarting the session and without losing any orchestration state** — the board, the in-flight tasks, the whole plan stay exactly where they were. The *running* Claude Code process lazily re-reads the fresh credentials and seamlessly picks up the new account's quota — as seamless as Orca's account switching, but **native to cc-master and driven by the conductor's own pacing judgment**, not a separate tool you have to remember to invoke.

The mechanism in one line: switch overwrites the three official shared-credential stores → the running `claude` lazily re-reads them as its access token nears expiry → the new account takes over. **No `exec`, no process restart, no `--resume`** — the session never blinks.

> This is validated end-to-end against real accounts: after a switch, the reported quota `%` doesn't reset to zero — it flips to the *switched-in* account's actual usage, proving the running process really did adopt the new credentials.

### A safe backup-account pool — `/cc-master:accounts`

Switching needs somewhere to switch *to*. `/cc-master:accounts` manages a **token-blind** pool of backup accounts (`--add` / `--delete` / `--refresh` / `--list`). Your OAuth token lives **only** in the OS keychain (macOS) or a `0600` file (everywhere else); the pool registry stores **non-secret pointers only** — `email → vault reference` + expiry + identity — and the token **never** enters agent context, logs, or the registry. Enrolling an account is one command (log into the target account, then `--add`), with an **identity guard** that refuses to mislabel the wrong account's credentials.

### Two-sided pacing corridor

cc-master paces your token burn against the rolling 5h/7d quota windows from *both* sides: **slow down** as you approach a wall, **speed up** when you have headroom and a reset is near — so you neither smash into a wall halfway nor let quota silently evaporate unused. The 7d window is the hard ceiling on accelerating. (See [ADR-010](adrs/ADR-010-two-sided-pacing-corridor.md).)

> Want the hands-on guide to building and managing the account pool? See [Manage a backup-account pool](#manage-a-backup-account-pool--how-to-add-accounts) below.

---

## Watch one run, start to finish

The fastest way to understand cc-master is to watch one orchestration happen — and to see it exercise more than one capability at once. A real long goal goes in; a persistent board, model-tiered parallel workers, a decision routed to *you*, an on-the-fly escalation, quota-aware pacing, and an independently-verified finish come out. Every board JSON below is a **real snapshot** of the file the orchestrator keeps on disk — the same one a hook reads when it decides whether you're allowed to stop.

> **The goal:** *Internationalize the web app to 6 locales — stand up the i18n framework, extract every hardcoded string, translate per locale, and ship locale routing.* — shaped exactly like the real thing: one shared foundation, then independent per-locale work that wants to run in parallel, plus one call only a human can make.

**Beat 1 — One command builds the board.** `UserPromptSubmit` sees the command's sentinel and runs `bootstrap-board.sh`, which creates the board file *before the agent does anything* and hands its path back: *"a fresh orchestration board was created at `<home>/…board.json` … Decompose the goal into a dependency DAG and write `tasks[]` … then run the decision program."* Bootstrap doesn't trust the agent to remember to keep state — it hands one over.

**Beat 2 — Decompose, tier the models, surface what's yours.** The conductor turns the goal into a DAG: a critical-path root `T0` (set up the i18n framework + extract strings) that everything depends on — run on a **strong model** — and independent locale leaves `de` / `ja` / `ar` on **cheaper models** (strong on the critical chain, cheap on the float). One call isn't the orchestrator's to make — *translate product terms or keep them in English? formal or informal register?* — so it lands as a `blocked_on:"user"` node and is surfaced to you **immediately**, in parallel with everything else.

```json
// INITIAL — root in flight; locale leaves blocked on it; one decision routed to you
{
  "schema": "cc-master/v1",
  "goal": "Internationalize the app to 6 locales (i18n framework + per-locale translation + locale routing)",
  "owner": { "active": true, "session_id": "smoke-session-001", "heartbeat": "2026-06-08T10:00Z" },
  "git": { "worktree": "/repo/.worktrees/i18n", "branch": "feat/i18n-rollout" },
  "wip_limit": 4,
  "tasks": [
    { "id": "T0", "status": "in_flight", "deps": [], "model": "opus", "title": "i18n framework + string extraction" },
    { "id": "de", "status": "blocked", "deps": ["T0"], "blocked_on": "T0", "model": "haiku", "title": "translate locale: de" },
    { "id": "ja", "status": "blocked", "deps": ["T0"], "blocked_on": "T0", "model": "haiku", "title": "translate locale: ja" },
    { "id": "ar", "status": "blocked", "deps": ["T0"], "blocked_on": "T0", "title": "translate locale: ar (RTL)" },
    // a blocked_on:"user" node carries a decision_package — the prepared interview /cc-master:discuss opens
    { "id": "D1", "status": "blocked", "deps": [], "blocked_on": "user", "title": "glossary + register decision",
      "decision_package": {
        "prepared_at": "2026-06-08T10:05Z", "freshness": "fresh", "ask_type": "decision",
        "inputs_hash": "sha256:3e7c1a9f4b08d62e5a0c7f1b9d4e8a26c0f3b7d519e6a2c84f0b1d7e93a5c6f2",
        "context_md": "Translating the UI surfaces a product-terminology choice: do brand/product terms get localized or kept in English, and do we address users formally or informally? This sets the tone for all 6 locales — it's a product call, not mine to make.",
        "question": "Translate product terms or keep them English? Formal or informal register?",
        "what_i_need": "Pick a glossary policy and a register; I'll hand it to every locale leaf as a translation constraint.",
        "why_it_matters": "Every locale leaf (de/ja/ar/…) depends on this convention. Deciding late means re-translating; deciding now lets all leaves run in parallel against one rule.",
        "options": [
          { "id": "opt-keep-en", "label": "Keep product terms in English, informal register", "rationale": "Brand consistency across locales; informal fits the app's voice.", "tradeoffs": "✅ No glossary drift. ⚠️ Some locales expect localized terms." },
          { "id": "opt-localize", "label": "Localize product terms, formal register per locale norm", "rationale": "Reads native in each market.", "tradeoffs": "✅ Most natural per locale. ⚠️ Needs a maintained glossary; ar/ja registers differ." }
        ],
        "enter_cmd": "/cc-master:discuss D1 --board <board-stem>"
      } }
  ]
}
```

**Beat 3 — It survives a compaction (the hard part).** A long task means the context fills and compaction drops "I am an orchestrator" *entirely* — the agent can't re-inject that for itself, because the memory that it had a role is what got wiped. On `SessionStart` (including `source:compact`), `reinject.sh` re-injects from **outside** the context: *"You are a cc-master master orchestrator. Your board(s) live in `<home>` … recognise it by its goal … Do not restart work already done/verified; integrate any completed background results first."* The board carried the *progress*; the hook carried the *identity*.

**Beat 4 — Dispatch on ready — and adapt.** `T0` lands, verified at the endpoint (the conductor reads the diff itself — a green gate is *not* a pass). The locale leaves flip `blocked → ready` and dispatch in parallel under `wip_limit: 4`. Then the plan meets reality: `ar` isn't just translation — right-to-left layout needs real work — so the conductor **escalates** it to a `workflow` and re-plans, rather than forcing a leaf that no longer fits. Meanwhile `usage-pacing.js` notices the run nearing the 5h quota wall and injects a **non-blocking** nudge; the conductor throttles — lowers WIP, defers the lowest-priority locale — instead of redlining. And if it tried to end the turn with `ready` work still on the board, `verify-board.sh` stops it cold: *"this board still has a `ready` task … Resolve it before stopping."*

**Beat 5 — Independent acceptance, then a forced self-check.** The leaves finish and are each independently verified (the conductor checks the rendered locale, not the worker's self-report). The board *looks* done — so the agent tries to stop. **The most important hook moment:** the goal-hook won't take "done" on faith. On the first stop in a completion state it blocks once and forces a self-check against the *original goal* — and it surfaces that your glossary decision is **still unanswered**: *"(1) Is every point that needs the user surfaced / marked `blocked_on:"user"`? (2) … is every to-do actually done?"* "Done" is refused while a decision is still owed to you.

```json
// DONE — every work node verified; the user decision was answered and applied
{
  "schema": "cc-master/v1",
  "goal": "Internationalize the app to 6 locales (i18n framework + per-locale translation + locale routing)",
  "owner": { "active": true, "session_id": "smoke-session-001", "heartbeat": "2026-06-08T12:30Z" },
  "wip_limit": 4,
  "tasks": [
    { "id": "T0", "status": "done", "deps": [], "verified": true },
    { "id": "de", "status": "done", "deps": ["T0"], "verified": true },
    { "id": "ja", "status": "done", "deps": ["T0"], "verified": true },
    { "id": "ar", "status": "done", "deps": ["T0"], "mechanism": "workflow", "verified": true },
    { "id": "D1", "status": "done", "deps": [], "title": "glossary + register decision (answered)" }
  ]
}
```

**Want the runnable proof?** The hook chain narrated here — bootstrap, reinject, and every `verify-board` block/allow decision — is exercised end-to-end by `smoke.sh` (all three are bash hooks, so the smoke run itself needs no jq, no node, no network), which prints *what happened* and *what the hook decided* plus a PASS/FAIL exit code (it doubles as a CI smoke check):

```bash
bash examples/sample-orchestration/smoke.sh
```

The full step-by-step story, with every board snapshot, is in [`examples/sample-orchestration/walkthrough.md`](examples/sample-orchestration/walkthrough.md).

---

## Quickstart

Two supported ways to run cc-master. Pick by how you work — both require **Node 22+** and **bash**, nothing else.

### A. `--plugin-dir` — recommended (dev / dogfood)

Point Claude Code straight at a live clone. Edits to the repo take effect on the next session — **no cache, no copy step**. This is how the maintainers run it.

```bash
git clone https://github.com/nemori-ai/cc-master.git
cd cc-master
claude --plugin-dir .          # this session loads the plugin from the live repo
```

`claude --plugin-dir /abs/path/to/cc-master` works from anywhere, so you can dogfood cc-master while inside *another* project.

### B. Marketplace + `enabledPlugins` (team / stable)

Add the marketplace, then enable the plugin in your settings. This is the right choice for sharing one pinned version across a team. **Trade-off:** enabled plugins are copied into Claude Code's plugin cache, so live edits to your clone do **not** take effect — you must `claude plugin update` to pick up changes.

```bash
# add this repo as a marketplace (URL, path, or GitHub repo all work)
claude plugin marketplace add nemori-ai/cc-master
claude plugin install cc-master@cc-master
```

Or enable it declaratively in settings. The `enabledPlugins` value is an **object** keyed by `<plugin>@<marketplace>` (not an array):

```jsonc
// ~/.claude/settings.json
{
  "enabledPlugins": {
    "cc-master@cc-master": true
  }
}
```

> Quick rule: iterating on the plugin → `--plugin-dir` (live). Pinning a version for a team → marketplace + `enabledPlugins` (cached).

Once loaded, hand it a goal big enough to be worth it (think >24h of work, many independent units). The full command set:

```
/cc-master:as-master-orchestrator <goal>           # bootstrap a board and become the orchestrator
/cc-master:as-master-orchestrator --resume [sel]   # pick up an EXISTING board in a new session (see below)
/cc-master:status                                  # render the board summary (board view) + validate the narrow waist
/cc-master:view                                    # open a read-only DAG webview of the board in your browser
/cc-master:discuss <node-id>                       # talk through a decision the orchestrator routed to you (see below)
/cc-master:handoff-to-new-session                  # gracefully hand the board off to a fresh session (write side of --resume)
/cc-master:accounts --add|--delete|--refresh <email> | --list   # manage the backup-account pool for hot switching
/cc-master:stop                                    # archive the board and stand down (board is kept, not deleted)
```

### See the board — at a glance or as a live DAG

Two read-only ways to look at where the orchestration stands, both safe to run any time (neither writes the board):

- **`/cc-master:status`** renders a **scannable board view** in the terminal — the DAG grouped by status (overall progress, what's in flight, what's blocked, and **decisions waiting on you** surfaced prominently), plus the critical-path estimate (the agent's own mental math, not machine-computed CPM) and a quick health check of the narrow waist.
- **`/cc-master:view`** launches a **local, read-only webview** in your browser. It stands up a dependency-free local `node` http server that renders the board with [xyflow](https://xyflow.com) and **live-polls every 2s** (no manual refresh — the picture updates as the board changes). A header offers a **three-way toggle — ⬡ GRAPH (the visual dependency DAG) · ▦ BOARD (a Kanban card board: status lanes of mid-density cards) · ☰ LIST (the status-grouped list)** — plus a ☀ / ☾ day-night theme switch; your choices persist across reloads. The BOARD and LIST views are the web equivalent of `/cc-master:status` (AWAITING-YOU / READY / IN FLIGHT / BLOCKED / DONE·VERIFIED / NEEDS-ATTENTION lanes, each card carrying the same analytics chips and a click-to-open detail rail). The design is a "Mission Control" telemetry aesthetic: status nodes as instrument lamps, an amber critical-path spine, and prominent alarms for `blocked_on:user` gates. Every asset (React / xyflow / dagre + fonts) is **vendored locally**, so it works fully offline — no CDN — honoring the ship-anywhere guarantee. Stop it by killing the background shell (or it exits with the session).

The DAG graph (the hero), the Kanban card board, and the status-grouped list — all live-polling, all offline:

![cc-master:view — the dependency DAG graph view (dark theme): task nodes as instrument lamps wired by an amber critical-path spine](docs/images/view-graph-dark.png)

*⬡ GRAPH — the dependency DAG, "Mission Control" dark telemetry.*

![cc-master:view — the Kanban card board (dark theme): status lanes of mid-density task cards](docs/images/view-board-dark.png)

*▦ BOARD — the Kanban card board: status lanes of mid-density cards.*

![cc-master:view — the Kanban card board in light / day theme](docs/images/view-board-light.png)

*☀ The same BOARD in day mode — toggle the theme with ☀ / ☾.*

![cc-master:view — the status-grouped list view (dark theme)](docs/images/view-list-dark.png)

*☰ LIST — status-grouped rows, the web twin of `/cc-master:status`.*

### Talk through a decision the orchestrator routed to you

When the orchestrator hits a call only a human can make, it doesn't drop a bare question on you. While idle it prepares a self-explaining **decision package** on the `blocked_on:"user"` node — the narrative of how it got here, what it's actually asking, whether it wants a *decision / advice / a solution*, and the candidate options with their trade-offs. In `/cc-master:view`, that awaiting-you card becomes a **rich decision card** with a one-click **copy `/cc-master:discuss <node-id>`** button.

Paste it into a separate, full-capability terminal session and you talk the call through *at your convenience, against accurate and still-timely context* — the discuss session **re-checks freshness on entry** and re-grounds if the question has gone stale under work that ran since, then helps you reason (it can read the code and the board). It writes the outcome to a versioned, append-only `<board-stem>--<node-id>--<STAMP>.decision.md` sidecar — a TL;DR plus the full decision doc — which the orchestrator picks up on its next idle/recon pass (reading the **latest** one if you talked it through more than once) to re-plan and clear the gate. No live notification, no interrupting either side: human attention, re-allocated.

The card itself shows the **discussion history** — even before the orchestrator has digested it. Once you've talked a node through, its `/cc-master:view` card displays **💬 discussed N times** plus the latest conclusion's TL;DR, expandable round by round (read straight from the sidecars via a read-only `/decisions.json` route; the viewer stays zero-network, zero-POST). So next time you open the board you can see *whether you've talked this through, how many times, and what it concluded* — without waiting for the orchestrator's next pass.

```
/cc-master:discuss <node-id>   # run in a fresh session — copy the exact command from the decision card in /cc-master:view
                               # (the copied command defaults to carrying --board <board-stem>, so a fresh session can't cross-wire to another open orchestration)
```

### Resume an existing board in a new session

A long-horizon orchestration outlives any single session. When the original session is closed / crashed / you're on another machine — or you ran `/cc-master:stop` and changed your mind — `--resume` lets a **brand-new session take over an existing board** instead of starting from scratch:

```
/cc-master:as-master-orchestrator --resume                 # one resumable board → pick it; else list candidates
/cc-master:as-master-orchestrator --resume i18n            # select by goal substring, board filename, or timestamp prefix
/cc-master:as-master-orchestrator --resume i18n --force-takeover   # confirm taking over a board that still looks alive
```

- **Any board is resumable** — both still-`active` (abandoned) boards and `/stop`-**archived** ones. Resuming an archived board **revives** it (`active:false → true`). `/stop` is a *reversible archive*, not a permanent end-state; the board file, its `tasks`, `log`, and `goal` are all preserved across archive → revive.
- **Takeover is safe by default.** Re-stamping the board hands it to the new session and orphans the old one's background work — so if a board still *looks alive* (recent heartbeat / file mtime), `--resume` warns and **withholds** the takeover until you re-send with `--force-takeover`. Ambiguous or missing selector → nothing is written; it lists the candidates (grouped into *abandoned* vs *will-be-revived*) and asks you to pick.
- **Resume means pick up, not restart.** The conductor reconciles the existing `tasks[]` rather than re-decomposing the goal, and treats any `in_flight` task left by the dead session as an orphan — endpoint-verifying its artifact (and marking it done) or re-dispatching it for a fresh handle, never idle-waiting on a dead handle. See [ADR-009](adrs/ADR-009-resume-cross-session-re-arm.md).

### Hand a board off cleanly before the session ends

`--resume` is the *read* side of cross-session continuity; `/cc-master:handoff-to-new-session` is the *write* side. Run it from the **old** orchestrator session to gracefully prepare a board for a **new** one, instead of leaving an abandoned board for `--resume` to discover after the fact:

```
/cc-master:handoff-to-new-session   # run in the OLD session to prepare a clean handoff
```

The conductor: (1) stops dispatching new work; (2) lets in-flight tasks finish and verify in the current session (stragglers that run too long are degraded to orphans + re-verify and surfaced to you); (3) writes a **narrative** handoff doc — a sidecar in the cc-master home that points at the board and explains the *story* without restating its DAG; (4) appends a pointer to that doc in `board.log`; (5) archives the board (`owner.active:false`) so the next session's `--resume` revives it frictionlessly; (6) tells you the doc path and the exact `--resume` command to run next. Handoff (prepare) and `--resume` (take over) are the two halves of one clean cross-session relay.

### Optional — turn on account-authoritative quota awareness

cc-master can pace against your subscription's **real** 5h/7d quota `used_percentage` — but that signal lives **only** in the status line's stdin (no hook, CLI, or file can reach it). Capturing it means wiring `statusline-capture.js` into your status line. Don't hand-edit `settings.json` — the **AI-native way** is to paste the prompt below to Claude Code and let it do the wiring (it resolves the real install path, preserves your existing status line via `--passthrough`, sidesteps the undocumented `${CLAUDE_PLUGIN_ROOT}`-in-`statusLine.command` question by using an absolute path, and verifies the sidecar lands):

> Help me enable cc-master's account-authoritative usage pacing. My subscription's 5h/7d quota `used_percentage` only appears in the **status line** script's stdin; cc-master ships `statusline-capture.js` to capture it into a sidecar (`~/.claude/.cc-master-rate-limits.json`) that its pacing hook and `cc-usage.sh` read. Please:
> 1. Locate the real absolute path of `statusline-capture.js` — it lives under the plugin's `skills/orchestrating-to-completion/scripts/`; the plugin may sit under `~/.claude/plugins/cache/.../` or be loaded via `--plugin-dir`, so use `find`/`ls` to resolve the actual path.
> 2. Read my current `statusLine.command` in `~/.claude/settings.json` (if any).
> 3. Rewrite `statusLine.command` to run `statusline-capture.js` first and `--passthrough` my original command, so my status-line display is unchanged. Use an **absolute path** (variable expansion in this field is undocumented). Show me the exact diff and let me confirm before you write it.
> 4. Then have the status line render once (I'll send a message), check that `~/.claude/.cc-master-rate-limits.json` was written with the right shape, and run the plugin's `cc-usage.sh` to confirm its `source` is `"account"` (not `local-derived-approx`).
> 5. If I'm on Pro/Max but `rate_limits` never shows up, tell me why (it only appears after the first API response, and only on Pro/Max).

Without this, pacing silently falls back to local-JSONL 反推 — an approximation whose reset countdown can be off by an order of magnitude ([Finding #37](design_docs/dogfood-findings.md)). Pro/Max subscriptions only; everywhere else this is a no-op and the fallback handles it.

### Manage a backup-account pool — how to add accounts

Hot switching (above) needs a pool of backup accounts to switch *to*. `/cc-master:accounts` is how you build and maintain that pool. The agent runs the preset scripts for you; **your token never passes through it** — it lives only in the script subprocess and the OS keychain / `0600` file. (Not applicable on cloud backends — Bedrock/Vertex/Foundry have no subscription OAuth token to manage.)

**Enroll an account — `/cc-master:accounts --add <email>`**

- **Mechanism = direct keychain read.** The script reads the **full OAuth credential blob of your *currently logged-in* account** straight from the macOS keychain and stores it in the pool. No browser pops up, no `setup-token` — it only *reads* (never writes) your official credentials, so **your active login is left untouched**.
- **The one prerequisite: you must currently be logged into the target account.** First log into account X via the **Orca app** or `claude`'s `/login`, *then* run `/cc-master:accounts --add X`.
- **Identity guard.** The script verifies that *the email you're currently logged in as* == *the `--email` you passed*, and **fails immediately** on mismatch — so account B's credentials can never get mislabeled as account A.
- **Build a multi-account pool:** log into A → `--add A`; switch your login to B → `--add B`; one at a time, once per account.
- **Other operations:** `--list` (see the pool — each account's vault kind / expiry / active / switchable), `--delete <email>`, `--refresh <email>` (= re-enroll, identical to `--add`).

**Important caveats (learned the hard way):**

1. **It must be a real `/login` (full OAuth), not `claude setup-token`.** Only a real login writes a **non-empty `refreshToken`** into the keychain — and hot switching **depends on `refreshToken`** to renew credentials (the keychain's access token is only ~8h valid). `setup-token` produces no `refreshToken`, so a switched-in account fails to renew and dies quickly. If `--add` reports "couldn't fetch a complete blob with a non-empty refreshToken," you didn't truly `/login` — log in fully via Orca / `claude /login` and rerun.
2. **Switching overwrites your global login.** Every `claude` session on this machine switches to the new account *together* (this is intentional — it keeps cross-session pacing accurate). It's reversible: switch back to any account in the pool at any time.
3. **Token-blind end to end.** Your OAuth token stays inside the script subprocess + OS keychain / `0600` file the whole time — it never enters the agent's context, transcript, or logs, and never the pool registry (which holds non-secret pointers only).
4. **Credentials expire — re-enroll if they go stale.** If an account's stored credentials expire or get invalidated (long unused, or enrolled by an older version), just log back into it + `--add` to re-enroll.
5. **`switchable: no`** in `--list` means that account has no usable token yet (registered but needs enrollment before it can be switched into).
6. **Not applicable on cloud backends** (Bedrock/Vertex/Foundry have no subscription OAuth token to manage).

> **How a switch actually works (mental model):** read the target account's blob from the pool → force-refresh a fresh token via its `refreshToken` → overwrite the official credential stores → the running `claude` lazily re-reads them and takes over — no restart, no `--resume`.

---

## The six-vision charter (C1–C6)

cc-master **aims to** make a Claude Code agent into a master orchestrator across six capabilities. These are **goals that guide the design, not a claim that all six already ship** — the status column is honest about what's live today vs. still design-only:

| # | Capability | Status | How it's delivered today |
|---|---|---|---|
| **C1** | Drive a goal to full, async-parallel completion — not halfway, all the way | 🟢 Live | three background mechanisms + the decision-program loop + a `Stop` gate that forces "really all done" |
| **C2** | Control the *rate* of token burn — steer into a two-sided corridor, neither redline nor under-use | 🟢 Live | `usage-pacing.js` (non-blocking, **two-sided** warning on account 5h/**7d** `used_percentage`: throttle near a limit *and* accelerate when the 5h window is under-used, with the 7d window as the hard ceiling — see [ADR-010](adrs/ADR-010-two-sided-pacing-corridor.md); captured via `statusline-capture.js`, local-derived fallback) + `cc-usage.sh` (out-of-band query, account-first) |
| **C3** | Hold the line between deciding autonomously and pulling in the human | 🟢 Live | red lines + `blocked_on:user` nodes + the `Stop` gate listing unanswered user decisions |
| **C4** | Decompose, manage, update, and re-plan the goal as it learns | 🟢 Live | the board DAG + CPM decomposition + resume flagging dangling `stale`/`escalated` nodes |
| **C5** | Maximize throughput *under* a sane burn rate | 🟢 Live | WIP cap (~75% utilization) + free float parallelism + `posttool-batch.sh` soft-warn |
| **C6** | Pick the right model by complexity, difficulty, and duration | 🟡 Partial | the **complexity/difficulty** axis is live (per-node `agent({model})` tier); the **duration** axis is still design-only |

> 🟢 Live · 🟡 Partial · ⚪ Design-only. Which capabilities are live vs. design-only is tracked in [`design_docs/vision-landing-tracker.md`](design_docs/vision-landing-tracker.md); the full charter is the single source of truth in [`design_docs/spec.md` §1.0](design_docs/spec.md).

---

## How it works

The plugin is **commands + 3 skills + hooks + a board file**, and each piece has a distinct lifespan:

```
cc-master/
├── .claude-plugin/
│   ├── plugin.json                     manifest
│   └── marketplace.json                marketplace entry (install path B)
├── commands/
│   ├── as-master-orchestrator.md       bootstrap — become the orchestrator
│   ├── status.md                       summarize board progress / health (board view)
│   ├── view.md                         launch a read-only DAG webview of the board
│   ├── handoff-to-new-session.md       prepare a clean handoff to a fresh session
│   ├── accounts.md                     manage the account-switch pool (add/remove/refresh/list)
│   └── stop.md                         archive / mark the board inactive
├── skills/
│   ├── orchestrating-to-completion/    Skill A — the orchestration method (the soul)
│   ├── authoring-workflows/            Skill B — how to write workflow scripts
│   └── account-management/             Skill C — the account-pool mechanism (select / switch / vault)
└── hooks/
    └── scripts/{bootstrap-board, reinject, verify-board,    bash
                 posttool-batch}.sh +
                 usage-pacing.js                             node
```

- **Commands** are one-shot ignition — you trigger them; they inject the "I am the master orchestrator" philosophy and operating discipline, and open the board.
- **Skills** are the on-demand deep manuals — Skill A when you run the orchestration loop, Skill B when you write a workflow script, Skill C (`account-management`) when you manage the account-switch pool (build the registry, select the best switch-in account, keep tokens in a vault).
- **Hooks** are the orchestrator's runtime — they survive compaction (re-injecting "you are the orchestrator + here is your board"), gate completion, soft-warn on over-dispatch, and sense the quota wall against the account's 5h/7d `used_percentage` (captured from the status line by `statusline-capture.js`; local-derived 反推 as fallback). They reach for `node` only where structured JSON parsing earns it (usage / rate-limit JSON), bash everywhere else ([ADR-006](adrs/ADR-006-hooks-may-use-node-js.md)).

### The three background mechanisms it teaches

cc-master coaches the orchestrator to advance the main thread using three reliably ship-anywhere mechanisms:

1. **Background shell** — long-running commands launched detached, so the main thread keeps moving.
2. **Sub-agent (`run_in_background`)** — an independent, terminal reasoning task, integrated on completion.
3. **Workflow** — dynamic-workflow scripts (fan-out / pipeline / loop) for structured parallel orchestration.

On top of these, a **watchdog self-wakeup** safety net covers the one gap the harness can't: it auto-rewakes the main thread when a background task *completes*, but a task that hangs, dies silently, or was never really dispatched (a ghost task) fires no completion event. So before a legitimate idle wait with in-flight background work outstanding, the orchestrator arms a timed wakeup to come back and reconcile ground truth. Its mechanism degrades gracefully: a local `CronCreate` / `ScheduleWakeup` timer when available, else a `Monitor` on a liveness signal, else the universal background-shell `until` floor (ADR-011).

It deliberately does **not** use **agent-teams** or **cloud scheduled routines**: neither is reliably ship-anywhere (one is behind an experimental flag, the other needs a claude.ai account and isn't available on Bedrock/Vertex/Foundry), so they are out of scope by design. The watchdog's local `ScheduleWakeup` / `CronCreate` timers are an in-session, OAuth-free exception — they don't break ship-anywhere (ADR-011).

### Bootstrap and completion, guaranteed by hooks

The board never depends on the agent cooperating, and the orchestrator can't quietly quit early. The five hooks span four events:

1. **`UserPromptSubmit`** (`bootstrap-board.sh`) detects the command's sentinel → deterministically creates an empty board skeleton + injects its exact path and the orchestrator role. This is also the **arm action** (see below) — and with `--resume` it instead re-arms an *existing* board (the second arm form: stamp owner onto a selected old board, reviving it if archived; [ADR-009](adrs/ADR-009-resume-cross-session-re-arm.md)).
2. **`SessionStart`** (`reinject.sh`) re-injects role + board after every compaction and on resume — and on resume it flags any **dangling `stale`/`escalated` nodes** left from an un-reconciled plan update.
3. **`Stop`** (`verify-board.sh`) runs a pure-bash gate over *this session's* active board (filtered by `owner.session_id`, so concurrent orchestrations never interfere). An empty board, or one with `ready`/`uncertain` work left, **blocks** the stop; when the board looks done it forces a one-time **self-check against the goal** — surfacing any **unanswered `blocked_on:user` decisions** — before releasing, with a fuse (5 consecutive blocks) so a misjudgment can never wedge the agent.
4. **`Stop`** also runs `usage-pacing.js` (node): it prefers the **account-authoritative** 5h/7d `used_percentage` captured to a sidecar by `statusline-capture.js` (falling back to local-JSONL 反推 when the sidecar is absent), and injects a **non-blocking** pacing warning — **two-sided**: it nudges to throttle when a window nears its limit *and* nudges to accelerate when the 5h window is being under-used (so quota doesn't silently evaporate), with the 7d window as the hard ceiling on speeding up. It never blocks and never decides *how* to pace (that's the orchestrator's judgment).
5. **`PostToolBatch`** (`posttool-batch.sh`) counts in-flight tasks against the board's `wip_limit` after a batch of parallel calls and **soft-warns** on over-dispatch — never blocking; parallel freedom is preserved.

**Every hook is dormant until armed.** "Armed" is derived from the board on disk: a hook acts only when this session owns an active board (`owner.active:true` **and** `owner.session_id` == the hook's stdin `session_id`; an empty id degrades to any active board, for compaction robustness). Until then — in any plain coding session in the same host — every hook is completely silent. `bootstrap-board.sh` is the sole exception: it *is* the arm action (stamping `owner.session_id` as it creates the board — or, with `--resume`, as it re-stamps a selected existing board). Disarming is `/stop` — a *reversible* archive that `--resume` can revive. See [ADR-007](adrs/ADR-007-hook-arming-gate.md) and [ADR-009](adrs/ADR-009-resume-cross-session-re-arm.md).

### The board

The board is the orchestrator's **persistent save file** for a long task — a status-bearing task dependency graph. It is both the memory that survives compaction *and* the only window a hook (a shell, blind to agent context) can read. Boards live in a configurable home — `$CC_MASTER_HOME` if set, else `<project>/.claude/cc-master/` — and each orchestration gets its own time-sortable file, so concurrent runs never collide. It is the single source of truth (the built-in `Task*` tools are at most a non-authoritative draft mirror), and it's gitignored. The board has a **narrow waist**: a small, fixed set of fields the hooks depend on (`owner.session_id`, task `status` values, `active`); everything else is flexible. Keeping that waist stable is the load-bearing contract between the bash hooks and the agent.

---

## Contributing

The dev loop is one clone and two gates — `./run-tests.sh` (hook tests + content contract) and `claude plugin validate .`. The design invariants (hooks limited to bash + node/JS — ADR-006, stable board waist, three non-overlapping skills, the conductor-never-plays-an-instrument red line, ship-anywhere, every hook dormant-until-armed — ADR-007) are spelled out in [CONTRIBUTING.md](CONTRIBUTING.md). Read it before opening a PR.

---

## Acknowledgements

This plugin stands on the shoulders of the people who mapped this terrain first:

- **[Claude Code](https://code.claude.com/docs/en/workflows) (Anthropic)** — for the dynamic-workflow runtime itself, and for [`/deep-research`](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code), the bundled reference implementation of the fan-out → adversarial-verify → synthesize paradigm. The harness's own launch-time and runtime validation is what lets Skill B teach a contract instead of shipping a linter.
- **[ray-amjad/claude-code-workflow-creator](https://github.com/ray-amjad/claude-code-workflow-creator)** — the community's de-facto authoring skill. Skill B (`authoring-workflows`) borrows its overall shape: a procedural `SKILL.md` plus `references/{api-reference, patterns}` and `assets/{templates, examples}`.
- **[obra/superpowers](https://github.com/obra/superpowers)** — its `dispatching-parallel-agents` is one of the few places in the ecosystem that argues for *preserving the main agent's context for coordination work* — the seed of cc-master's "don't idle-spin" thesis. We also dogfooded the whole build under the superpowers discipline (brainstorming → plans → TDD → review).
- The community pattern libraries we distilled into Skill B's catalog — [alexop.dev](https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/), [claudefa.st](https://claudefa.st/blog/guide/development/dynamic-workflows), and Anthropic's [*A harness for every task*](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code).
- **[barkain/claude-code-workflow-orchestration](https://github.com/barkain/claude-code-workflow-orchestration)** — its *soft-enforcement* nudges ("don't let the main agent do the work by hand") are structurally kin to cc-master's red line that the conductor never plays an instrument.

The research that grounds the design is in [`design_docs/research/`](design_docs/research/), and the full specification is in [`design_docs/spec.md`](design_docs/spec.md).

---

## License

[MIT](LICENSE) © 2026 cc-master contributors
