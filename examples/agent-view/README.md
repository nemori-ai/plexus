# Plexus Agent View

An **agent-centric** client UI for Plexus. You chat with an agent that — *after
"installing Plexus"* — **discovers** this machine's capabilities and **invokes**
them, including orchestrating the desktop's **Claude Code** and **Codex**.

The UI makes the full Plexus lifecycle **visible**, because here a chat "tool call"
*is* a Plexus invoke:

> **discover → grant (pending → human approves) → invoke → audit**

That lifecycle — rendered inline in the chat as a `ToolCallCard` with a visible
**human-approval gate** that holds until you approve, then streams the invoke
output, then shows the result with its **auditId** — is the differentiator. The
agent cannot self-authorize; the human approved; here's the audited result.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the authoritative event contract.

---

## What's on screen

| Region | Component | What it shows |
| --- | --- | --- |
| Header | identity + phase | agent name/model + the run-mode toggle (demo / live) |
| Left rail | `AgentState` | live phase (discovering / thinking / awaiting_grant / invoking / idle / done), `memory.update` items, the audit log |
| Left rail | `Capabilities` | what the agent discovered after installing Plexus, grouped by source/provenance, with sensitivity badges |
| Center | `Chat` + `ToolCallCard` | the streaming transcript; **the invoke lifecycle is the centerpiece** |
| Right | `Orchestration` | the `orchestration.board` DAG (xyflow + dagre), shown once a board arrives |

---

## Run it

### Demo mode (zero setup — mock / replay)

The app ships with a hardcoded sample session (`src/mock/sample-session.ts`): a
CC + Codex orchestration with a human-approval gate, an orchestration board, and
agent memory. It replays **entirely in the browser** — no backend, no gateway, no
LLM, no API key.

```bash
cd examples/agent-view/web
npm install
npm run dev
# open http://localhost:5180  — "demo" mode is the default; type any prompt + Send
```

Or use the one-command runner from `examples/agent-view/`:

```bash
./run-demo.sh --web-only      # web only, demo/mock mode
```

### Live mode (real gateway + backend + frontier key)

Live mode `POST`s `/api/chat` and consumes the real backend SSE stream (the
Python deepagent driving the actual gateway + Claude Code / Codex). Switch the
header toggle to **live** after the stack is up.

```bash
./run-demo.sh                 # boots gateway (:7077) + python backend (:8800) + web (:5180)
```

`run-demo.sh` is defensive: every piece is optional and degrades with a clear
message. If `bun`, the gateway, or the Python backend
(`examples/agent-view/backend`, owned by build lane B1) is missing, the web app
still runs in demo mode. Env overrides: `PLEXUS_PORT`, `AGENT_VIEW_BACKEND_PORT`,
`AGENT_VIEW_PORT`.

Live mode needs a frontier model API key for the backend (e.g. `ANTHROPIC_API_KEY`)
— see the backend's own README.

---

## Tests

`tsc` + `vite build`:

```bash
cd examples/agent-view/web
npm run build         # runs tsc --noEmit && vite build
```

Playwright e2e (runs against **demo/mock mode** — no backend needed):

```bash
cd examples/agent-view/e2e
npm install
npx playwright install chromium     # first run only
npx playwright test
```

The spec asserts: an assistant message renders, a `ToolCallCard` shows the
grant-pending gate and then resolves to a result with an `auditId`, the
Capabilities panel lists capabilities, and the Orchestration DAG renders nodes.

---

## Stack

React 18 + Vite + TypeScript + Tailwind. `@xyflow/react` + `dagre` for the
orchestration DAG. OKLCH "mission-control" theme adapted from cc-master. No
Mantine — the chat + tool-call cards are hand-built (modeled on omne-next's
tool-call card, adapted to the Plexus invoke lifecycle).

```
web/
  src/
    contract.ts                  AgentEvent TS types (mirror backend/events.py 1:1)
    sse.ts                       POST /api/chat SSE client → typed AgentEvent
    store.ts                     reducer: AgentEvent[] → UI view-model
    theme.css                    OKLCH theme tokens
    mock/sample-session.ts       hardcoded demo session + replay()
    components/
      Chat/                      MessageList, Composer, ToolCallCard, Markdown
      Capabilities/              discovered capabilities by source/provenance
      Orchestration/            board DAG (xyflow + dagre)
      AgentState/                phase + memory + audit
e2e/                             Playwright spec (drives demo mode)
run-demo.sh                      one-command boot (gateway + backend + web)
```

---

## Screenshots

Put demo screenshots in `web/public/screenshots/` and reference them here, e.g.:

- `web/public/screenshots/lifecycle.png` — the ToolCallCard human-approval gate
- `web/public/screenshots/orchestration.png` — the CC + Codex board DAG

(Capture with the Playwright `--headed` run or your browser; this directory is
git-tracked but starts empty.)
