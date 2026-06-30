# Plexus Agent View — Architecture & Build Contract

A developer-facing, **Agent-centric** example: a real agent client UI where the agent is the
subject. You chat with an agent that — *after "installing Plexus"* — DISCOVERS host capabilities
and INVOKES them, including orchestrating the desktop's **Claude Code** and **Codex**. The UI
visualizes, at high quality, the full Plexus lifecycle: **discover → grant (pending → human
approves) → invoke → audit**, plus streaming chat, agent state/memory, and an orchestration DAG.

This doc is the BUILD CONTRACT. Three build lanes (backend / frontend / codex-source) build
against the shared event contract below **in parallel**. Do not deviate from the event names/shapes.

## Directory layout
```
examples/agent-view/
  ARCHITECTURE.md         (this file)
  backend/                (Python — wraps the existing deepagent, emits the SSE contract)
    server.py             ASGI app: POST /api/chat (stream), GET /api/health
    agent_runner.py       drives plexus_deepagents loop -> translates to AgentEvent stream
    events.py             AgentEvent dataclasses + JSON serialization (the contract, server side)
    demo_mode.py          deterministic replay of a recorded scenario (for demo + e2e)
    recordings/demo-cc-codex.json   a recorded AgentEvent[] scenario
    pyproject.toml / requirements.txt
  web/                    (React + Vite + TypeScript + Tailwind; xyflow+dagre for the DAG)
    src/contract.ts       AgentEvent TS types (MUST mirror backend events.py 1:1)
    src/sse.ts            EventSource/fetch-stream client -> typed AgentEvent
    src/store.ts          reducer over AgentEvent -> UI state
    src/components/Chat/...            message list, composer, ToolCallCard (the invoke lifecycle)
    src/components/Capabilities/...    what the agent discovered (grouped by source/provenance)
    src/components/Orchestration/...   board DAG (lifted cc-master xyflow+dagre style)
    src/components/AgentState/...      state + memory panel
    src/theme.css         OKLCH theme (lifted/adapted from cc-master view.html)
  run-demo.sh             one command: boot gateway + backend(demo) + web, open browser
  e2e/                    Playwright spec driving web against backend demo-mode
  README.md               runbook (demo mode / live mode), screenshots
```

## Tech decisions (delegated to orchestrator; chosen)
- Frontend: **React 18 + Vite + TypeScript + Tailwind**; **xyflow + dagre** for the orchestration
  DAG (lift cc-master's approach + OKLCH theme); hand-built chat + tool-call cards modeled on
  omne-next's `ToolCallResponse` but with NO Mantine dep (keep the example lean).
- Backend: **Python**, reuse `examples/pomodoro-demo/plexus_deepagents` (the protocol client +
  deepagent). A thin ASGI server (Starlette/FastAPI or stdlib) streams events via SSE.
- Two run modes: **demo mode** (replay `recordings/*.json`, deterministic, no LLM/CC needed — used
  by the demo + e2e) and **live mode** (real deepagent + real gateway + real CC/Codex).
- Lives at `examples/agent-view/` on branch `example/agent-view`.

## THE EVENT CONTRACT (frontend <-> backend, SSE; single source of truth)

Backend streams `text/event-stream`; each event is `data: <JSON>\n\n` where JSON is one AgentEvent.
`contract.ts` (TS) and `events.py` (Python) MUST mirror these exactly. Discriminated on `type`.

```ts
type AgentEvent =
  | { type: "session.start"; sessionId: string; agentName: string; model: string; ts: string }
  | { type: "agent.state"; phase: "discovering"|"thinking"|"awaiting_grant"|"invoking"|"idle"|"done"; note?: string }
  | { type: "assistant.delta"; text: string }                       // streaming assistant tokens
  | { type: "assistant.message"; id: string; text: string }         // a completed assistant turn (markdown)
  | { type: "capabilities.discovered"; capabilities: CapabilityCard[] }  // after handshake/manifest
  | { type: "tool.call.start"; callId: string; capabilityId: string; label: string; input: unknown; provenance: string; sensitivity: string; source: string }
  | { type: "tool.call.grant_pending"; callId: string; pendingId: string; summary: string; verbs: string[] }  // human must approve in Plexus
  | { type: "tool.call.grant_resolved"; callId: string; decision: "approved"|"denied" }
  | { type: "tool.call.delta"; callId: string; chunk: string }      // streamed invoke output (e.g. CC/codex stdout)
  | { type: "tool.call.result"; callId: string; ok: boolean; output?: unknown; error?: string; auditId: string }
  | { type: "orchestration.board"; board: unknown }                 // cc-master/v1 board JSON snapshot (drives the DAG view)
  | { type: "memory.update"; items: MemoryItem[] }                  // agent memory/state items
  | { type: "audit.event"; id: string; capabilityId: string; outcome: string; at: string }
  | { type: "session.end"; reason?: string }
  | { type: "error"; message: string };

interface CapabilityCard { id: string; label: string; source: string; provenance: string; sensitivity: string; grants: string[]; describe?: string }
interface MemoryItem { key: string; value: string; kind?: string }
```

Frontend request to start a run: `POST /api/chat` `{ message: string, mode?: "demo"|"live", scenario?: string }`
-> responds with the SSE stream of AgentEvent. `GET /api/health` -> `{ ok: true, mode: "demo"|"live" }`.

### Lifecycle mapping (what makes this UI special)
A "tool call" in the chat IS a Plexus invoke. The ToolCallCard renders the lifecycle from the
events above: `start` (id+input+provenance/sensitivity badge) -> optional `grant_pending` (shows the
human-approval gate + the gateway-authored summary; the card visibly WAITS) -> `grant_resolved`
(approved/denied) -> `delta`* (streamed stdout for CC/Codex) -> `result` (ok/auditId). This is the
"agent cannot self-authorize; the human approved; here's the audited result" story, made visible.

## Build lanes & ownership (disjoint; parallel)
- **B1 backend** owns `backend/**`. Implements the contract via real deepagent (live) + a recorder
  that produces `recordings/demo-cc-codex.json`, and demo replay. Reuses `pomodoro-demo/plexus_deepagents`.
- **B2 frontend** owns `web/**` + `e2e/**` + `run-demo.sh` + `README.md`. Builds the whole client
  against `contract.ts` + a local mock event stream; integrates with B1 at demo/e2e time.
- **B3 codex source** owns `packages/runtime/src/sources/codex/**` + its registry wiring + tests —
  a thin first-party `codex` source mirroring `claudecode` (headless `codex` CLI run, execute-grant,
  pends for approval). So the agent can discover & drive BOTH cc and codex.

Integration seam: B1 and B2 are wired together only in `run-demo.sh` and the e2e. Both build to the
contract above, so they never touch each other's files. The demo scenario (`recordings/demo-cc-codex.json`)
is the canonical example both the demo and the e2e replay; B1 authors it, B2 consumes it.
