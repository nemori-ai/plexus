# `plexus_deepagents` — compile Plexus capabilities into DeepAgents skills

This module is the **Plexus → DeepAgents skills-bundle emitter + HTTP helper**
(GOAL.md §3 / §7.3). It is **generic over any Plexus capability** — nothing in it is
pomodoro-specific. It does three things:

1. **`PlexusClient`** — the agent-side HTTP client speaking the Plexus M0 wire
   protocol (`discover → handshake → grant → invoke`) with the **full resource-side
   approval polling loop** that AC2 hinges on.
2. **`emit_skills(out_dir)`** — for every discovered capability, write one
   `SKILL.md` in the Agent-Skills standard. This is the **"compile capability →
   agent-native skill"** step.
3. **`plexus_skills_tools(client)`** — the DeepAgents shim that exposes the
   `plexus_invoke` helper tool the emitted skills reference, ready for
   `create_deep_agent(..., tools=[...])`.

## Install

```bash
pip install -r examples/pomodoro-demo/requirements.txt
```

## The three pieces

### 1. `PlexusClient(base_url, connection_key)`

| method | wire call | what it does |
|---|---|---|
| `discover()` | `GET /.well-known/plexus` (unauth) | gateway identity + capability **summaries** + the auth/endpoint advertisement (cached; endpoint URLs are read from it per ADR-016). |
| `handshake()` | `POST /link/handshake` | exchange the connection-key for a **session + the FULL manifest** (every entry: describe, io schema, grants, attached skill bodies). |
| `invoke(capability_id, input)` | `PUT /grants` → poll `GET /grants/status` → `POST /invoke` | the **full resource-side-approval flow** (see below). Returns the structured `output`. |
| `emit_skills(out_dir)` | (uses the manifest) | write one `SKILL.md` per capability. |

Security contract honored (mirrors the TS `min-agent` client): always sends the
loopback `Host` header (else `host_forbidden`); presents the connection-key **only**
at handshake, then holds a short-lived `Authorization: Bearer <ScopedToken>`.

### 2. The resource-side approval state machine (AC2)

`invoke()` runs:

1. `PUT /grants` for the capability.
2. If the response is `status === "grant_pending_user"` (the owner's authorizer
   **defers**), relay the gateway-authored narration via the `on_pending` callback,
   then **POLL** `GET /grants/status?pendingId=<id>` every second until
   `state !== "pending"`:
   - `approved` → take the minted `token` (a ScopedToken) and proceed.
   - `denied`  → raise `GrantDenied` (abort cleanly).
   - `expired` → raise `GrantExpired`.
   - still pending past the poll deadline → raise `GrantTimeout`.
3. `POST /invoke` with `Authorization: Bearer <token>`.
4. On an `ok:false` invoke response it branches on the closed `ErrorCode`:
   `grant_pending_user` (an invoke that itself defers) → poll then retry;
   `token_expired` → `POST /grants/refresh` (15-min tokens, 5-min grace) then retry;
   `grant_required`/`token_revoked` → re-request the grant (re-pends for the owner)
   then retry; anything else → raise `InvokeFailed` with the verbatim error.

**The agent cannot self-approve.** Mutating capabilities (`write`/`execute`) PEND for
the machine owner in the Plexus UI; the helper **blocks and polls** until they act.

### 3. A capability becomes a `SKILL.md`

`emit_skills` writes the Agent-Skills layout `deepagents`' `SkillsMiddleware` expects:

```
out_dir/
  workspace-read/SKILL.md
  workspace-write/SKILL.md
  claudecode-run/SKILL.md
```

Each `SKILL.md` is **YAML frontmatter** (`name` + `description` for progressive
disclosure; the description front-loads what/when/grant-cost and — for mutating verbs
— the "this PENDS for the owner, the helper blocks and polls, just wait" note) **+ a
body** that is the capability's own `describe`, its trust posture, the loud
resource-side-approval section, the `io.input`/`io.output` JSON Schema, and a concrete
`plexus_invoke(capability_id=..., input=...)` call example.

## Wiring it into `create_deep_agent`

This is exactly how the example DeepAgent (built by a separate task) imports it:

```python
from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from plexus_deepagents import PlexusClient, plexus_skills_tools

# 1. connect with ONLY the connection-key
client = PlexusClient("http://127.0.0.1:7077", connection_key)
client.handshake()

# 2. COMPILE every Plexus capability into a SKILL.md bundle on disk
import os
ROOT = os.path.abspath("./agent_workdir")          # backend root
client.emit_skills(os.path.join(ROOT, "plexus_skills"))

# 3. build the agent: skills give per-capability knowledge,
#    plexus_skills_tools(client) gives the callable `plexus_invoke`
backend = FilesystemBackend(root_dir=ROOT, virtual_mode=True)
agent = create_deep_agent(
    model="claude-sonnet-4-5",
    tools=plexus_skills_tools(client),       # → [plexus_invoke]
    system_prompt="You are a remote AI product engineer. Use the Plexus skills "
                  "and the plexus_invoke tool. Mutating actions pend for the owner — "
                  "call once and wait; never look for another way in.",
    skills=["/plexus_skills"],               # source dir, relative to the backend root
    backend=backend,
)

# agent.invoke({"messages": [{"role": "user", "content": "..."}]})
```

The model reads each skill's frontmatter `description` (progressive disclosure),
opens the full `SKILL.md` body when relevant, and calls `plexus_invoke(...)` — which
runs the full grant→poll→invoke flow and returns a JSON result string.

## deepagents API notes (verified against deepagents 0.6.12)

- **Verified:** `create_deep_agent(model, tools, *, system_prompt, skills, backend, …)`.
  `tools` accepts a LangChain `@tool`/`BaseTool` (what `make_invoke_tool` returns) or a
  plain callable. `skills` is a list of **source directory paths**; each immediate
  subdirectory holds a `SKILL.md`. Loaded by `SkillsMiddleware` via the `backend`.
- **Verified:** emitted `SKILL.md` files load with **zero load errors** through
  deepagents' own loader; the `name`/`description` frontmatter parse per the
  Agent-Skills spec (`name` ≤64 chars `[a-z0-9-]`, `description` ≤1024 chars).
- **Verified:** the full wiring above builds a `CompiledStateGraph` with both the
  skills and the `plexus_invoke` tool present.
- **Gotcha (verified):** use `FilesystemBackend(root_dir=ROOT, virtual_mode=True)` and a
  **named** skills subdirectory (`skills=["/plexus_skills"]`), not `skills=["/"]` at the
  backend root — a bare `/` source tripped a path-resolution edge case in the backend.
- **Not exercised:** an end-to-end model run (needs an LLM key + a live Plexus). The
  graph construction, tool schema, and skill loading are all verified; the actual
  agent loop is the example-agent task's to drive.

## Tests (no running Plexus required)

```bash
cd examples/pomodoro-demo && python -m pytest tests/ -q
```

`tests/fake_gateway.py` is a fetch-shaped in-process stub of the 4 endpoints (incl. a
configurable **pending → approved** transition) injected via
`PlexusClient(transport=...)`. `test_client_grants.py` covers the polling state machine
(auto-approve read, pend→approve, denied, expired, poll-timeout, the invoke-side
`grant_pending_user`, `token_expired` refresh, host-guard); `test_emit_skills.py`
covers the SKILL.md layout, frontmatter, and the resource-side-approval note. 17 tests.
```
