# Plexus Protocol — M0 Contract Specification

> Status: **FROZEN — M0 contract `v0.1.0`** · Date: 2026-06-23 · Protocol version: `0.1`
> · Canonical version constant: `PLEXUS_PROTOCOL_VERSION = "0.1.0"` (see [`./VERSION`](./VERSION)).
>
> This is **the core asset** and the contract everything types off. The entire
> Plexus codebase types off the canonical definitions in [`./types.ts`](./types.ts).
> This document is the human-readable contract; `types.ts` is the machine source of
> truth. Where they appear to differ, `types.ts` wins and this doc is the bug.
>
> This revision applies the independent adversarial-review fixes (findings #1–#10
> + secondary) and two locked user decisions (pluggable `Authorizer` seam; 15-min
> token lifetime made workable by a grant-backed refresh endpoint). See
> [`./DECISIONS.md`](./DECISIONS.md) for the ADRs.

Plexus is a user-installed, open-source **local capability gateway**. It exposes
ONE stable, AI-native self-describe endpoint so any AI agent can
**DISCOVER → UNDERSTAND → be GRANTED → CALL** the capabilities of software on
the user's machine.

**Framing (locked):** *"MCP = what functions I have; Plexus = how you should use
me."* MCP is the first-class, **privileged ingestion transport** (`transport:
"mcp"`); MCP tool/resource/prompt JSON Schemas pass through **verbatim**. The
additive layer — pre-session `.well-known` self-describe, bundled **usage
Skills**, user-defined **extensions**, **per-capability scoped grants/tokens** —
lives ABOVE the MCP wire.

---

## §7 (read first) — The four Plexus jobs & the data flow

Plexus does four things; everything in this spec serves one of them.

1. **Scan** — probe the machine for installed, adaptable capability sources
   (first-party adapters, MCP servers, user extensions). Binary/endpoint
   discovery goes through the platform seam (login-shell PATH capture + fallback
   candidate dirs, reused from pneuma `path-resolver`).
2. **Adapt** — each source is fronted by an adapter (`CapabilitySource` +
   `CapabilityBridge`) that translates its native protocol into the unified
   entry model. The adapter type is a **black box** to the core.
3. **Describe** — every capability, skill, and workflow registers as one
   **isomorphic self-describe entry** (`CapabilityEntry`), discriminated by
   `kind`. This is the heart: the agent reads "cards" and knows what/how.
4. **Expose** — one loopback endpoint surface (`.well-known` → handshake →
   grants → invoke). Who's behind it is hidden.

```
 Your desktop                Plexus (local 127.0.0.1 process)              AI agent client
 ┌──────────────┐     ┌───────────────────────────────────────────┐     ┌──────────────────┐
 │ Desktop app  │     │  ADAPTER LAYER            CORE             │     │ Any agent that   │
 │ (local-rest) │──┐  │ ┌─────────────────┐   ┌────────────────┐  │     │ speaks the       │
 │ MCP server   │──┼─▶│ │ CapabilitySource │   │  Registry       │  │     │ Plexus protocol  │
 │ (transport:  │  │  │ │  · checkReqs     │──▶│  (entries by id)│  │     │                  │
 │   mcp)       │  │  │ │  · scan()        │   │                │  │  GET │ 1. DISCOVER      │
 │ CLI agent    │──┤  │ └─────────────────┘   │  Grants + Token │◀─┼──────│ /.well-known     │
 │ (cli/stdio)  │  │  │ ┌─────────────────┐   │  store          │  │ POST │ 2. UNDERSTAND    │
 │ User ext     │──┘  │ │ CapabilityBridge │   │  Audit log      │  │──────│ /link/handshake  │
 │ (any wire)   │     │ │  · invoke()/route│◀──│  (per-session)  │  │  PUT │ 3. GRANTED       │
 └──────────────┘     │ └────────┬────────┘   └────────┬───────┘  │──────│ /grants          │
   ▲ Transport seam   │          │ Transport.dispatch() │ Expose  │ POST │ 4. CALL          │
   │ Platform seam    │          ▼                      ▼          │──────│ /invoke          │
   └──────────────────│   local-rest│stdio│ipc│mcp│cli  one URL   │     └──────────────────┘
                      └───────────────────────────────────────────┘
                         Platform seam (macOS first): binary discovery,
                         process spawn, local-service location — all OS-specific
                         parts isolated behind PlatformServices.
```

**Key invariant:** the client only ever talks to one stable endpoint surface.
Scan / adapt / protocol-translation are all sealed inside the Plexus process —
both an engineering decoupling and a compliance boundary. (The diagram shows the
four-step core loop; the full endpoint set adds the lifecycle endpoints
`/grants/refresh`, `/grants/revoke`, `/grants/status`, `/manifest`, `/events`,
`/extensions` — all advertised in `.well-known`, see §2.)

---

## §1 — The unified self-describe entry model

`capability` / `skill` / `workflow` are **isomorphic** entries discriminated by
a `kind` field, so an agent discovers all three with ONE loop, grants them on
ONE surface, and (for capability/workflow) invokes them via ONE path.

Canonical type: `CapabilityEntry` (alias `SelfDescribeEntry`) in `types.ts`.

| Field | Meaning |
|---|---|
| `id` | Globally-unique, stable id. Unit of grant/scope/audit/invocation. Convention `<source>.<noun>.<verb>`. |
| `source` | The source/adapter that produced it. |
| `kind` | `capability` \| `skill` \| `workflow`. |
| `label` | Short human label. |
| `describe` | **The heart.** Semantic, agent-facing "what / when / how to use me well." Convention: *"Action outcome. Use when X."* |
| `io` | `{ input?, output? }` JSON Schemas. **MCP tool schemas drop in verbatim.** |
| `grants` | Verbs required: `read` \| `write` \| `execute`. |
| `transport` | How the adapter reaches the software (see §3). |
| `skills` | Attached usage-Skill refs (the additive "how to use" layer). |
| `members` | (workflow only) ordered `WorkflowMember[]` (`{id, verbs}`); each id MUST be a present registry entry. Drives transitive grants (§4). |
| `body` | (skill only) the markdown usage guidance, inline or by ref. |
| `mcp` | (mcp only) verbatim MCP provenance — `serverId`, `protocolVersion`, `primitive`, `originName`, and `raw` (the untouched original MCP object). |
| `version`, `extras` | metadata; `extras` is never read by core routing. |

### The three kinds

- **`capability`** — a directly callable function or data access. The leaf unit.
  An ingested **MCP tool** projects to exactly this.
- **`skill`** — agent-facing **usage knowledge** ("how to use me well": worked
  examples, gotchas, conventions). **This is the layer MCP does not have.**
  Discoverable, but read-as-context (its `transport` is `"skill"`, not invoked).
- **`workflow`** — a user/first-party orchestration of multiple capabilities,
  exposed as ONE higher-level capability. Invoked like a capability; internally
  fans out across `members`.

### How an ingested MCP tool maps onto an entry

MCP discovery is **intra-session only** — there is no unauthenticated MCP
manifest. Plexus runs an **MCP client** against each MCP source during `scan()`
(`initialize → tools/list → resources/list → prompts/list`) and **projects**
each primitive to a `CapabilityEntry`:

| MCP | → Plexus entry field |
|---|---|
| Tool `name` | `mcp.originName` (and seeds `id` as `mcp.<server>.<name>`) |
| Tool `description` | seeds `describe` (may be enriched by an attached skill) |
| Tool `inputSchema` | `io.input` **VERBATIM** |
| Tool `outputSchema` | `io.output` **VERBATIM** |
| Tool annotations (`readOnlyHint` etc.) | informs `grants` (read vs write) |
| The whole Tool JSON | `mcp.raw` (untouched, for re-projection + façade) |
| Resource | `kind:"capability"`, `mcp.primitive:"resource"`, read-only; `mcp.originName` = the resource **URI** |
| Prompt | `kind:"skill"` or capability seed, `mcp.primitive:"prompt"`; `mcp.originName` = the prompt **name** |

**Resources & prompts are first-class (review #1/#2).** They are NOT tools-only:
the `mcp` transport **branches on `mcp.primitive`** — a tool dispatches via
`tools/call`, a resource via `resources/read` (param `uri`), a prompt via
`prompts/get` (param name + args). Each returns its native shape into the
**verbatim `McpResult`** slot on the response — `content[]`+`structuredContent`
(+`isError`) for tools, `contents[]` for resources, `messages[]` for prompts — so
every primitive round-trips losslessly (this replaces the old tool-only
`mcpContent`). `*/list` is paged to exhaustion so large servers aren't truncated.

Plexus **only wraps**; it never rewrites an ingested schema. See worked example
[`examples/mcp-tool-passthrough.github.create_issue.json`](./examples/mcp-tool-passthrough.github.create_issue.json).

### How a user extension produces the SAME shape

A user extension declares an `ExtensionManifest` (`types.ts §1b`) listing the
capabilities it contributes; the gateway materializes a `CapabilitySource` whose
`scan()` projects each declaration into the identical `CapabilityEntry` shape (the
"one sentence to open an Obsidian vault" flow generates one). It is registered via
`POST /extensions` (§2) — making **Flow B demoable end-to-end**. The agent cannot
tell — and must not need to tell — a first-party adapter, an ingested MCP tool, and
a user extension apart: all three are just entries. **Customization is extension;
extension is auto-discovered.** Local-service credentials (e.g. the Obsidian Local
REST API bearer key) are declared as an `ExtensionSecretRef` and resolved at
dispatch time via the platform seam (`PlatformServices.resolveSecret`) from
`~/.plexus/secrets/` — never carried in the entry, manifest, `.well-known`, or
audit. See [`examples/extension-manifest.obsidian.json`](./examples/extension-manifest.obsidian.json).

Worked examples:
[`obsidian.vault.read.json`](./examples/obsidian.vault.read.json) (a user
extension, `kind:"capability"`, `transport:"local-rest"`, read-only) and
[`cc-master.orchestration.run.json`](./examples/cc-master.orchestration.run.json)
(a first-party orchestration, `kind:"workflow"`, `transport:"workflow"`,
`grants:["execute"]`, with `members`).

---

## §2 — Endpoint contract

All endpoints are served on the loopback bind only (default
`http://127.0.0.1:7077`). Errors use the uniform `ErrorResponse` envelope.

### `GET /.well-known/plexus` → discovery (unauthenticated, pre-session)

The pre-session, unauthenticated advertisement **MCP deliberately lacks**.
Returns a `WellKnownDocument`: gateway identity, a **summary** capability list
(enough to window-shop, NOT enough to call — no full schemas, no skill bodies),
and the auth shape.

**Response (example):**
```json
{
  "gateway": {
    "name": "plexus", "version": "0.1.0", "protocol": "0.1",
    "baseUrl": "http://127.0.0.1:7077", "instance": "ez-macbook"
  },
  "capabilities": [
    { "id": "obsidian.vault.read", "source": "obsidian", "kind": "capability",
      "label": "Read Obsidian notes",
      "summary": "Read Markdown from a local Obsidian vault by path or search.",
      "grants": ["read"], "transport": "local-rest" },
    { "id": "cc-master.orchestration.run", "source": "cc-master", "kind": "workflow",
      "label": "Run a long-horizon orchestration",
      "summary": "Build a task DAG and dispatch parallel agents toward a goal.",
      "grants": ["execute"], "transport": "workflow" },
    { "id": "mcp.github.create_issue", "source": "mcp:github", "kind": "capability",
      "label": "Create a GitHub issue",
      "summary": "Create a new issue in a GitHub repository.",
      "grants": ["write"], "transport": "mcp" }
  ],
  "auth": {
    "handshakeUrl": "http://127.0.0.1:7077/link/handshake",
    "grantsUrl": "http://127.0.0.1:7077/grants",
    "refreshUrl": "http://127.0.0.1:7077/grants/refresh",
    "revokeUrl": "http://127.0.0.1:7077/grants/revoke",
    "grantStatusUrl": "http://127.0.0.1:7077/grants/status",
    "invokeUrl": "http://127.0.0.1:7077/invoke",
    "manifestUrl": "http://127.0.0.1:7077/manifest",
    "eventsUrl": "http://127.0.0.1:7077/events",
    "connectionKeyDelivery": "user-paste",
    "tokenScheme": "plexus-scoped-jwt"
  }
}
```

> **Endpoint-namespace convention (ADR-016):** the agent reads every endpoint URL
> from this `auth` advertisement rather than hard-coding paths. All session-scoped
> endpoints live under the flat namespace `/link/handshake`, `/grants`,
> `/grants/refresh`, `/grants/revoke`, `/grants/status`, `/invoke`, `/manifest`,
> `/events`, `/extensions`.

### `POST /link/handshake` → full manifest (connection-key gated)

The agent presents a **connection-key** (the user copied it from the management
client and pasted it into the agent — out-of-band, see §5). On success the
gateway opens a session and returns the **full manifest**: every entry with full
`describe`, `io` schemas, `grants`, `transport`, attached skill bodies, and MCP
passthrough.

**Request:**
```json
{
  "connectionKey": "plx_live_8f3c…e21",
  "client": { "name": "claude-code", "version": "2.x", "agentId": "agent-ez-1" }
}
```
**Response (abridged):**
```json
{
  "sessionId": "sess_01J…",
  "expiresAt": "2026-06-23T11:00:00.000Z",
  "grantsUrl": "http://127.0.0.1:7077/grants",
  "manifest": {
    "gateway": { "name": "plexus", "version": "0.1.0", "protocol": "0.1", "baseUrl": "http://127.0.0.1:7077" },
    "sessionId": "sess_01J…",
    "expiresAt": "2026-06-23T11:00:00.000Z",
    "revision": 7,
    "entries": [ /* full CapabilityEntry objects — see examples/*.json */ ]
  }
}
```
At this point the agent holds **no scoped token** — it has read-only knowledge,
zero call authority. (Default-deny.) `manifest.revision` is a monotonic counter the
agent compares against `manifest_changed` events to detect a stale view (§2,
manifest-refresh).

### `PUT /grants` → scoped-token (per-capability)

The agent (or the **user via the management client**) selects which entries to
allow and at what verbs. Each requested grant is run through the configured
**`Authorizer`** (the pluggable authorization seam, ADR-007 revised). Returns
either a **scoped-token** covering the approved entries, or a
**`grant_pending_user`** notice for any grant the policy defers.

> **Authority note (ADR-007 revised):** the authorize decision is a **pluggable
> abstraction** (`Authorizer`: input = grant request + context → `allow | deny |
> pending`). **v1 ships a permissive stub** (`AutoApproveAuthorizer`) so demos
> aren't blocked on a confirm-every-grant UI. A stricter policy (e.g. user-confirms
> via the management client, returning `pending`) is a drop-in replacement that
> exercises the `grant_pending_user` + `GET /grants/status` poll channel — **no
> wire change**. The pending path stays in the type surface either way.

**Request:**
```json
{
  "sessionId": "sess_01J…",
  "grants": {
    "obsidian.vault.read": "allow",
    "mcp.github.create_issue": { "decision": "allow", "verbs": ["write"] },
    "cc-master.orchestration.run": { "decision": "allow", "verbs": ["execute"] }
  }
}
```
`"allow"` shorthand normalizes to read-only default. The github entry asks for
`write` explicitly. The cc-master **workflow** asks for `execute`.

**Response (approved — note the synthesized transitive member scopes):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWI…",
  "jti": "tok_01J…",
  "expiresAt": "2026-06-23T11:15:00.000Z",
  "scopes": [
    { "id": "obsidian.vault.read", "verbs": ["read"] },
    { "id": "mcp.github.create_issue", "verbs": ["write"] },
    { "id": "cc-master.orchestration.run", "verbs": ["execute"] },
    { "id": "cc-master.board.create", "verbs": ["write"], "synthesizedFor": "cc-master.orchestration.run" },
    { "id": "cc-master.agent.dispatch", "verbs": ["execute"], "synthesizedFor": "cc-master.orchestration.run" },
    { "id": "cc-master.board.status", "verbs": ["read"], "synthesizedFor": "cc-master.orchestration.run" }
  ],
  "transitive": [
    {
      "workflowId": "cc-master.orchestration.run",
      "memberScopes": [
        { "id": "cc-master.board.create", "verbs": ["write"] },
        { "id": "cc-master.agent.dispatch", "verbs": ["execute"] },
        { "id": "cc-master.board.status", "verbs": ["read"] }
      ]
    }
  ]
}
```
**Transitive grants (review #5, ADR-012):** granting the workflow synthesizes
member scopes (flagged `synthesizedFor`) and stamps them into the token, so member
dispatch is scope-checked through the same pipeline — no silent escalation. The
`transitive` block is what the management client SURFACES to the user at
grant-confirm time ("…which will also run board.create / agent.dispatch /
board.status"). Every member id MUST be a present registry entry.

**Response (pending — a stricter `Authorizer` deferred the decision):**
```json
{
  "status": "grant_pending_user",
  "pendingId": "pend_01J…",
  "pending": ["cc-master.orchestration.run"],
  "statusUrl": "http://127.0.0.1:7077/grants/status?pendingId=pend_01J…"
}
```
The agent then polls `GET /grants/status` (below) or awaits a `grant_resolved`
event. (v1's stub authorizer auto-approves and typically never emits this.)

### `GET /grants/status?pendingId=…` → resolve a pending grant (review #9)

The resolution channel so a `grant_pending_user` never dead-ends. The agent polls
until `state` is terminal; on `"approved"` the minted token is included.

**Response:**
```json
{
  "pendingId": "pend_01J…",
  "state": "approved",
  "capabilities": ["cc-master.orchestration.run"],
  "token": {
    "token": "eyJ…",
    "jti": "tok_02K…",
    "expiresAt": "2026-06-23T11:30:00.000Z",
    "scopes": [ { "id": "cc-master.orchestration.run", "verbs": ["execute"] } ]
  }
}
```

### `POST /grants/refresh` → grant-backed token re-mint (review #4)

Token lifetime is **15 min, locked** — but the cc-master workflow runs **>24h**.
Refresh re-mints a fresh 15-min token with the **same scopes** straight from the
**persisted grant** — **no connection-key, no re-prompt** — bounded by the grant's
own validity. The agent retains only the short token + a refresh handle, never the
connection-key. (See the long-running flow in §5.)

**Request** (`Authorization: Bearer <expiring-token>`):
```json
{ "sessionId": "sess_01J…", "jti": "tok_01J…" }
```
**Response:**
```json
{
  "token": "eyJ…newtoken…",
  "jti": "tok_03L…",
  "expiresAt": "2026-06-23T11:30:00.000Z",
  "scopes": [ { "id": "cc-master.orchestration.run", "verbs": ["execute"] } ],
  "grantExpiresAt": "2026-06-25T10:00:00.000Z"
}
```
The old `jti` is revoked; refresh stops working once `grantExpiresAt` passes (then
the agent must re-`PUT /grants`). Preconditions: session live (§5), grant present
+ not revoked, within grant validity.

### `POST /grants/revoke` → revoke a token or grant (review #3)

Driven by the management client's "revoke now" action, or by an agent
relinquishing its own token. Two selector forms.

**Request (by jti):**
```json
{ "jti": "tok_01J…", "reason": "user revoked from management client" }
```
**Request (by scope — also removes the persisted grant so refresh can't re-mint):**
```json
{ "agentId": "agent-ez-1", "capabilityId": "cc-master.orchestration.run" }
```
**Response:**
```json
{ "ok": true, "revokedJtis": ["tok_01J…", "tok_03L…"], "grantRemoved": true, "auditId": "evt_09Z…" }
```
**In-flight workflow rule (review #3):** the orchestrator re-checks the
originating `jti`'s revocation state **before EACH member dispatch**, so revoking
mid-fan-out halts the remaining members (completed dispatches are audited, not
undone).

### `POST /invoke` → call a granted capability

The agent calls a capability/workflow, presenting the scoped-token as
`Authorization: Bearer <token>`. The gateway:
1. enforces the **Host/Origin** guard (§5) before anything else;
2. verifies the JWT signature + expiry, checks `jti` is not revoked **and the
   session is still live** (review #8);
3. confirms a scope covers `id` with every verb the entry **requires**;
4. validates `input` against `io.input`;
5. routes to the owning `CapabilityBridge` → `Transport.dispatch()` (no
   `if (id===…)` — routing is registry/transport-driven);
6. writes a redacted audit event;
7. returns a normalized `InvokeResponse` (with the verbatim `mcpResult` preserved
   for MCP-ingested entries — tools/resources/prompts alike).

**Request** (`Authorization: Bearer eyJ…`):
```json
{ "id": "obsidian.vault.read", "input": { "query": "Plexus protocol decisions", "limit": 5 } }
```
**Response:**
```json
{
  "id": "obsidian.vault.read",
  "ok": true,
  "output": { "notes": [ { "path": "Projects/Plexus.md", "title": "Plexus", "content": "…" } ] },
  "auditId": "evt_01J…"
}
```
**MCP tool response** (`transport:"mcp"`, verbatim `mcpResult`):
```json
{
  "id": "mcp.github.create_issue",
  "ok": true,
  "mcpResult": {
    "content": [ { "type": "text", "text": "Created issue #42" } ],
    "structuredContent": { "number": 42, "url": "https://github.com/…/issues/42" }
  },
  "auditId": "evt_02K…"
}
```
An MCP server returning `isError:true` maps to `ok:false`, `error.code:"mcp_tool_error"`,
with the server's `content[]` preserved in `mcpResult.content`. A resource read
populates `mcpResult.contents[]`; a prompt get populates `mcpResult.messages[]`.

**Denied example** (`Authorization` token lacks the scope):
```json
{ "error": { "code": "grant_required", "message": "No grant for cc-master.orchestration.run (execute).",
             "capabilityId": "cc-master.orchestration.run" } }
```
`error.code` is drawn from the **closed `ErrorCode` union** (§7) so the agent can
branch deterministically (refresh vs. re-grant vs. re-handshake vs. give up).

> **Routing note (workflows & MCP):** a `kind:"workflow"` invoke routes to the
> `WorkflowTransport`, which **re-enters the uniform invoke pipeline** per member
> via `invokeById` — the core NEVER branches on `kind:"workflow"` (review #6, §6).
> Each member call is itself scope-checked (against the synthesized scopes) +
> audited. A `transport:"mcp"` invoke routes to the `McpTransport`, which branches
> on `mcp.primitive` (`tools/call` / `resources/read` / `prompts/get`) and
> preserves the server's native result verbatim in `mcpResult`.

### `GET /manifest` → refresh the manifest snapshot (review #9)

The handshake manifest is a one-shot snapshot. When the entry set changes
mid-session (MCP `list_changed`, a source coming online, an extension registering),
the agent re-fetches the CURRENT full manifest WITHOUT re-handshaking. Session-
authenticated (e.g. `X-Plexus-Session: <sessionId>`). Returns `{ manifest }` with a
bumped `manifest.revision`.

### `GET /events` → live event stream (SSE) (review #9)

A Server-Sent Events stream of `PlexusEvent`s so the agent learns of changes
without polling:
- `manifest_changed` — re-fetch `GET /manifest` (carries the new `revision`).
- `grant_resolved` — a pending grant was decided (carries the token if approved).
- `token_revoked` — a held token was revoked; stop using it immediately.
- `source_status` — a source's availability changed (diagnostics).

### `POST /extensions` → register a user extension (review #secondary, Flow B)

Registers an `ExtensionManifest`; the gateway materializes its `CapabilitySource`,
its projected entries enter the registry, and a `manifest_changed` event fires.
Session-authenticated (registration is a user-authorized act).

**Request:**
```json
{ "sessionId": "sess_01J…", "manifest": { "manifest": "plexus-extension/0.1", "source": "obsidian", "...": "see examples/extension-manifest.obsidian.json" } }
```
**Response:**
```json
{ "ok": true, "source": "obsidian", "registered": ["obsidian.vault.read"], "revision": 8 }
```

---

## §3 — Transport abstraction

First batch (locked, ADR-003): `local-rest | stdio | ipc | mcp | cli`, plus two
non-wire sentinels `skill` and `workflow`. The adapter layer implements the
`Transport` interface per kind; the bridge calls `dispatch()`. **Adding a
transport = implement + register; never edit callers.**

```ts
interface Transport {
  readonly kind: TransportKind;
  dispatch(entry, input, ctx?): Promise<TransportResult>;   // ctx present only for re-entrant transports
}
```

| kind | wire | notes |
|---|---|---|
| `local-rest` | HTTP to a localhost service the app exposes | e.g. Obsidian Local REST API. Endpoint + bearer credential via platform seam. |
| `stdio` | spawn subprocess, NDJSON over stdin/stdout | generic non-MCP stdio adapters. |
| `ipc` | unix socket / named pipe / osascript bridge | OS-specific bits behind platform seam. |
| `mcp` | **privileged** — Plexus runs an MCP client | branches on `mcp.primitive`; see below. |
| `cli` | invoke binary with argv, capture stdout (opt. `--format json`) | binary resolved by path-resolver. |
| `skill` | (none) | sentinel — body delivered as context. |
| `workflow` | (none) | **re-enters the invoke pipeline** per member; see below. |

### The `mcp` transport, concretely (review #1/#2)

`McpTransport extends Transport`. Plexus is the **MCP client**, and dispatch
**branches on `entry.mcp.primitive`**:

```
scan():   initialize(serverId)              // clientInfo+caps → server caps; then notifications/initialized
          list(serverId)                    // tools/list + resources/list + prompts/list — PAGED TO EXHAUSTION
          → re-project each primitive to a CapabilityEntry (schemas VERBATIM, mcp.raw kept)
invoke(): primitive "tool"     → call(serverId, originName=tool-name, args)  // tools/call
          primitive "resource" → readResource(serverId, uri=originName)      // resources/read
          primitive "prompt"   → getPrompt(serverId, name=originName, args)  // prompts/get
          → TransportResult { ok, mcpResult: { content?|contents?|messages?, structuredContent?, isError? } }  // VERBATIM
```

`isError:true` ⇒ `ok:false` + `error.code:"mcp_tool_error"`, `content[]` preserved.
A **persistent MCP client** (owned by `CapabilitySource.start()`) is reused across
request-scoped invokes and re-initialized on session loss. MCP transports run over
**stdio** or **Streamable HTTP** (`/mcp`, `Mcp-Session-Id` header), owned inside the
impl. `notifications/.../list_changed` is surfaced via `CapabilitySource.onEntriesChanged`
→ a `manifest_changed` event to the agent.

### The `workflow` transport, concretely — the orchestrator is "just a transport" (review #6)

There is **no external wire**. `WorkflowTransport.dispatch` receives a
`TransportDispatchContext` and **re-enters the uniform invoke pipeline** for each
`entry.members[]` via `invokeById`. Consequences:

- The gateway core **never** has an `if (kind === "workflow")` branch — fan-out is
  ordinary, scope-checked, audited invocation through the same path as any call.
- Each member dispatch is checked against the **synthesized transitive scopes**
  (§2 grants) carried on the same token — no silent escalation.
- Before EACH member dispatch the pipeline **re-checks the originating `jti`'s
  revocation state** (review #3), so a mid-fan-out revoke halts the rest.

(Chosen over modeling the orchestrator as a first-party `CapabilitySource`; ADR-013
records why — transport re-entry keeps members on the identical enforcement path.)

---

## §4 — Scoped-token model

**Format (ADR-006): signed JWT (HS256, gateway-held secret) + server-side
revocation registry.** Self-contained to verify (stateless signature check), but
every `jti` is tracked so a grant can be revoked before expiry. Opaque to the
agent — it just presents the compact Bearer string.

- **Scope shape:** `scopes: { id, verbs[], synthesizedFor? }[]`. Token authority =
  exactly this union. A call is allowed only if a scope covers the entry's `id`
  with EVERY verb the entry requires. Default minimal + **read-only** (a bare
  `"allow"` grants `["read"]`). A `synthesizedFor` scope is a workflow's transitive
  member scope (§2).
- **Lifecycle: 15 min, LOCKED (ADR-006, user decision).** Grants persist in the
  grant store keyed by `(agentId, capabilityId)`; tokens are cheap, regenerated
  views. The agent keeps long tasks alive via **`POST /grants/refresh`** (ADR-011),
  which re-mints from the persisted grant with no connection-key and no re-prompt,
  bounded by the grant's own validity. (This is why a 15-min token is workable for
  a >24h workflow — see §5 long-running flow.)
- **Revocation (ADR-010):** `POST /grants/revoke` by `jti` (single token) or by
  `(agentId, capabilityId)` (all tokens carrying that scope + removes the persisted
  grant so refresh can't re-mint). Revoked `jti`s are refused at invoke even before
  `exp`; a workflow re-checks revocation before each member dispatch (review #3).
- **Session liveness (review #8):** invoke also requires the token's `sessionId` to
  be **live**. Connection-key rotation invalidates the sessions bootstrapped under
  the old key AND enqueues their tokens' jtis for revocation — so a rotated-out
  agent cannot keep calling `/invoke` for up to 15 min. Liveness failure ⇒
  `session_expired`.
- **Audit linkage:** `sub` (agent id), `jti` (token id), and `sessionId` thread
  through every `AuditEvent`, so every call traces to a token and an agent.

### Error codes (closed union — review #10)

`ErrorResponse.code` and `InvokeResponse.error.code` draw from a **closed
`ErrorCode` union** so the agent branches recovery deterministically:

| code | agent should |
|---|---|
| `token_expired` | `POST /grants/refresh` (or re-grant), retry |
| `token_revoked` | re-request via `PUT /grants` |
| `grant_required` | request a grant for the id/verb |
| `grant_pending_user` | poll `GET /grants/status` / await `grant_resolved` |
| `session_expired` | re-handshake |
| `unknown_capability` | manifest likely stale → `GET /manifest` |
| `schema_validation_failed` | fix `input` against the entry's `io.input` |
| `source_unavailable` | source/app not reachable; back off / surface to user |
| `mcp_tool_error` | MCP in-band error; inspect preserved `mcpResult.content` |
| `transport_error` | transport-level failure; retry / surface |
| `host_forbidden` | Host/Origin check failed (§5) |
| `rate_limited` | back off |
| `internal_error` | unexpected gateway fault |

---

## §5 — Security model

- **Bind:** loopback only (`127.0.0.1`), never `0.0.0.0`. No LAN exposure in v1.
- **Host/Origin guard (review #7, ADR-016):** loopback bind alone stops neither
  other local processes nor a **DNS-rebinding browser attack** (a malicious page
  resolving a hostname to 127.0.0.1 and POSTing to `/invoke`). EVERY endpoint, BEFORE
  auth, enforces `HostOriginPolicy`: the `Host` header MUST equal the bound loopback
  authority (`127.0.0.1:<port>` / `localhost:<port>`), and `Origin` — when present
  (browser context) — MUST be in `allowedOrigins` (default: only the management
  client's origin; agent CLIs send no Origin). Failure ⇒ `host_forbidden`.
- **`.well-known` fingerprint (accepted):** the unauthenticated discovery doc
  exposes the gateway version + a capability-summary inventory to any local caller.
  This is the price of pre-session discovery (the thing MCP lacks); it is bounded to
  SUMMARIES (ADR-008) — full schemas / skill bodies / `mcp.raw` still require the
  connection-key handshake.
- **Connection-key:** generated by the gateway, shown ONLY in the local management
  client; user copies + pastes it into the agent (`connectionKeyDelivery:
  "user-paste"`). A session-bootstrap secret, NOT call authority. Rotatable on
  demand / auto-rotated; rotation invalidates the sessions bootstrapped under the
  old key **and enqueues their tokens' jtis for revocation** (review #8) — a
  rotated-out agent cannot keep calling for up to 15 min.
- **Default-deny, default-read-only:** no entry is callable without an explicit
  grant; a bare allow grants read only; `write`/`execute` must be named.
- **Pluggable grant authority (ADR-007 revised):** the authorize decision is the
  pluggable `Authorizer` seam (`allow | deny | pending`). v1 ships a permissive stub
  (`AutoApproveAuthorizer`); a stricter user-confirm policy plugs in with no wire
  change and exercises the `grant_pending_user` path. The seam — not a specific UX —
  is the contract.
- **Per-capability + session enforcement:** every `/invoke` re-checks scope coverage
  against the entry's required verbs AND session liveness AND `jti` non-revocation —
  per-call, not per-session.
- **Audit log + redaction CONTRACT (review #secondary, ADR-009 amendment):**
  append-only JSONL under `~/.plexus/audit/` (daily-rotated). Each `AuditEvent`
  records type, `agentId`/`sub`, `jti`, `sessionId`, `capabilityId`, `verbs`,
  `outcome`, and `detail`. Redaction is a **contract** (`AuditRedactionPolicy`): the
  single writer scrubs raw call `input`, token strings, connection-keys, and
  resolved secrets from `detail` before persisting — `forbidRawInput` is enforced,
  not aspirational. Retention default 90 days. Single write path prevents drift.
- **Local-first state:** all gateway state under `~/.plexus/` (grants store, audit,
  source registry, connection-key, **secrets under `~/.plexus/secrets/`** resolved
  via the platform seam); no pointer files in user cwds.

### Worked flow — a >24h cc-master orchestration on a 15-min token

1. Agent handshakes, `PUT /grants` for `cc-master.orchestration.run` (`execute`).
   The token also carries the **synthesized member scopes** (board.create / agent.
   dispatch / board.status), surfaced to the user via the `transitive` block.
2. Agent `POST /invoke`s the workflow → the `WorkflowTransport` fans out to members
   via `invokeById`, each scope-checked + audited, revocation re-checked per member.
3. The 15-min token nears `exp`. The agent calls `POST /grants/refresh` with its
   `jti` + session → a fresh 15-min token, **no connection-key, no re-prompt**,
   bounded by `grantExpiresAt`. Repeat across the >24h run.
4. Mid-run, a source adds capabilities → `manifest_changed` SSE event → agent
   `GET /manifest` to refresh. If the user revokes from the management client →
   `token_revoked` event + the workflow halts before its next member dispatch.

---

## §6 — Adapter-layer architecture

Two layers, mirroring pneuma-skills. The adapter type is **hidden** behind these
interfaces; the core never branches on source/transport type.

- **Lifecycle layer — `CapabilitySource`** (≈ pneuma `AgentBackend` +
  `BackendModule`): `checkRequirements()` (cheap availability probe via platform
  seam), `scan()` (enumerate/project entries — for MCP this runs the client
  handshake + list **paged to exhaustion** + re-project; for a first-party
  orchestration like cc-master, `scan()` returns the workflow AND its member
  entries so transitive grants have real targets — review #secondary, Flow A),
  `start()` (owns the **persistent MCP client** for the source lifetime),
  `stop()`, optional `onEntriesChanged()` (MCP `list_changed`), and an optional
  **`install()`** — a first-class, **user-confirmed + audited** (`source.install`)
  action that replaces the old `extras.autoInstall` blob the core never read
  (review #secondary, Flow A).
- **Per-session protocol-translation layer — `CapabilityBridge`** (≈ pneuma
  `BridgeBackend`): one instance per (session × source), closes over its adapter
  so the adapter type stays private. `getCapabilities()`, `invoke(req, ctx)`,
  `route() → "handled" | "unsupported" | "passthrough"`, `disconnect()`. The
  gateway enforces grants BEFORE calling `invoke()`; the bridge translates to the
  transport and normalizes the result, and MUST emit an audit event. `BridgeDeps`
  now carries **`audit`** (folding the adapter-deps asymmetry — sources can audit
  `source_unavailable`, review #secondary) and **`invokeById`** (the re-entrant
  pipeline the `workflow` transport fans out through — review #6).

### Central registry (no scattered branching)

Each source ships a `SourceModule` from `sources/<id>/manifest.ts`. The
`SourceRegistry` is the **only** place modules are aggregated (≈ pneuma
`backends/index.ts: MODULES`). Every caller goes through `registry.get(id)` /
`registry.getTransport(kind)` / `registry.all()` — **no `if (id === ...)` lives
outside a source module.** Adding a source = write a manifest, add it to the
registry map. Done: discovery, availability, scan, invoke routing all flow
automatically.

### Platform-abstraction seam

Everything OS-specific — binary discovery, process spawn, local-service location,
**secret resolution** — lives behind `PlatformServices` (`resolveBinary`,
`getEnrichedPath`, `locateLocalService`, `spawnProcess`, **`resolveSecret`**). v1
ships a **macOS** implementation; Windows/Linux implement the same seam later.
Reuses pneuma `path-resolver` (login-shell PATH capture with fallback candidate
dirs). Core + adapters depend ONLY on this interface — no `process.platform` checks
leak into the core. `resolveSecret` is the credential path for local services that
require auth (e.g. the Obsidian Local REST API bearer key, review #secondary):
secrets live under `~/.plexus/secrets/`, referenced by name from an
`ExtensionSecretRef`, handed only to the owning transport at dispatch, never to
core / manifest / audit.

### Optional later output: MCP-server façade

The contract is shaped so a future **MCP-server façade output adapter** can
re-emit the Plexus subset as a normal MCP server for pure-MCP clients. The
`mcp.raw` field preserves every ingested tool verbatim for exact re-projection;
user-extension/workflow entries project DOWN to MCP tools (losing only the
additive skill/grant layer MCP can't carry). Designed-for, **not built in M0**.

---

## Appendix — file map

- [`VERSION`](./VERSION) — frozen contract version tag (`0.1.0`).
- [`types.ts`](./types.ts) — canonical TypeScript types (source of truth).
- [`examples/obsidian.vault.read.json`](./examples/obsidian.vault.read.json) — user extension, read-only.
- [`examples/cc-master.orchestration.run.json`](./examples/cc-master.orchestration.run.json) — first-party workflow, execute, `WorkflowMember[]` members.
- [`examples/mcp-tool-passthrough.github.create_issue.json`](./examples/mcp-tool-passthrough.github.create_issue.json) — ingested MCP tool, verbatim passthrough.
- [`examples/extension-manifest.obsidian.json`](./examples/extension-manifest.obsidian.json) — minimal user-extension manifest (Flow B register path).
- [`DECISIONS.md`](./DECISIONS.md) — ADRs (frozen M0 v0.1.0).
