# Plexus Protocol — M0 Contract Specification

> Status: **M0 contract `v0.1.3`** · Protocol **family** `0.1`
> (the major.minor `config.ts` exports — additive, patch-compatible) · exact
> **version** `0.1.3` · Canonical constant: `PLEXUS_PROTOCOL_VERSION = "0.1.3"`
> (see [`./VERSION`](./VERSION)). The wire advertises the family `"0.1"` (a `0.1.x`
> client interoperates across patch bumps); `0.1.3` is the exact contract revision.
> · **Two credentials + execute→once (ADR-4 / ADR-5 — the shipped auth model):**
>   an agent authenticates with its **own durable per-agent PAT** (`plx_agent_…`),
>   redeemed once from a one-time **enrollment code** (`plx_enroll_…`); the
>   **connection-key** (`plx_live_…`) is the **admin/management** credential only and
>   agents never see it. The agent loop gains an **ENROLL** step (`POST /agents/enroll`)
>   and handshake is **PAT-gated** for agents. **ADR-5:** an `execute` (high-sensitivity)
>   capability is approved **per-use** (`once` floor) even under an admin trust window;
>   the sole lift is the per-agent, per-capability owner **standing opt-in**
>   (default-off + double-confirm, ADR-023/ADR-025). The authoritative model is
>   [`../design/security-model.md`](../design/security-model.md); this doc is the wire
>   contract that conforms to it.
> · **v0.1.3 reconciliation (ADR-4 / ADR-5 — enrollment + PAT self-description):** the
>   enrollment + per-agent PAT surfaces shipped, but `.well-known` still described the AGENT
>   handshake with the OLD **connection-key-in-body** shape (the ADMIN path). This revision
>   points `requestShapes.handshake` at the AGENT path — `Authorization: Bearer plx_agent_…`,
>   no body — via a new optional `RequestShapeHint.headers`, and re-labels
>   `connectionKeyDelivery` as the ADMIN/owner delivery, never an agent affordance. **ADR-5**
>   (`execute`-never-standing, `once` ceiling) is reaffirmed. Additive + a corrective doc/shape
>   fix to a now-false hint; the connection-key-in-body handshake stays the documented ADMIN path.
> · **v0.1.2 refinement (ADR-018 — unified trust model):** names the previously-implicit
>   trust machinery and surfaces it everywhere — **source-class** (`provenance`),
>   **sensitivity**, **trust-window**, the standing-grant ledger (`GET /grants`), and
>   gateway-authored **pending narration**. See "§4d — Unified trust model" below.
> · **v0.1.1 refinement (tp2 / ADR-017):** `POST /invoke` returns the SINGLE
>   `InvokeResponse` shape for ALL outcomes — including auth/pre-dispatch denials.
>   Non-breaking: the closed `ErrorCode` union and the per-denial HTTP status are unchanged.
>
> This is **the core asset** and the contract everything types off. The entire
> Plexus codebase types off the canonical definitions in [`./types.ts`](./types.ts).
> This document is the human-readable contract; `types.ts` is the machine source of
> truth, and this revision has been reconciled to the shipped types and to
> `security-model.md` — the two-credential model below is what the code enforces.
>
> This revision applies the independent adversarial-review fixes (findings #1–#10
> + secondary) and the locked user decisions (pluggable `Authorizer` seam; 15-min
> token lifetime made workable by a grant-backed refresh endpoint; per-agent PAT
> enrollment; the `execute → once` ceiling). See
> [`./DECISIONS.md`](./DECISIONS.md) for the ADRs.

Plexus is a user-installed, open-source **local capability gateway**. It exposes
ONE stable, AI-native self-describe endpoint so any AI agent can
**DISCOVER → ENROLL → HANDSHAKE → be GRANTED → INVOKE** the capabilities of
software on the user's machine. An agent enrolls once (redeeming a one-time code
for its own durable PAT), then handshakes under that PAT on every session — it
never holds the owner's connection-key.

**Framing (locked):** *"MCP = what functions I have; Plexus = how you should use
me."* MCP is the first-class, **privileged ingestion transport** (`transport:
"mcp"`); MCP tool/resource/prompt JSON Schemas pass through **verbatim**. The
additive layer — pre-session `.well-known` self-describe, bundled **usage
Skills**, user-defined **extensions**, **per-capability scoped grants/tokens** —
lives ABOVE the MCP wire.

> **Status (MCP ingestion):** the MCP transport/client layer is implemented and
> tested, but the user-facing "wrap an MCP server as a source" path is **not shipped
> yet** — there is no MCP source module in the production registry (`MODULES`).
> Today you expose capabilities via first-party sources or by authoring an
> extension. The MCP design throughout this spec is the locked direction and the
> transport contract, not an available end-user path (see
> [`../KNOWN-LIMITATIONS.md`](../KNOWN-LIMITATIONS.md)).

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
 │ MCP server   │──┼─▶│ │ CapabilitySource │   │  Registry       │  │  GET │ Plexus protocol  │
 │ (transport:  │  │  │ │  · checkReqs     │──▶│  (entries by id)│◀─┼──────│ 1 DISCOVER       │
 │   mcp)       │  │  │ │  · scan()        │   │                │  │ POST │ /.well-known     │
 │ CLI agent    │──┤  │ └─────────────────┘   │  Enroll ledger  │◀─┼──────│ 2 ENROLL  (code) │
 │ (cli/stdio)  │  │  │ ┌─────────────────┐   │  Grants + Token │  │ POST │ /agents/enroll   │
 │ User ext     │──┘  │ │ CapabilityBridge │   │  store          │◀─┼──────│ 3 HANDSHAKE(PAT) │
 │ (any wire)   │     │ │  · invoke()/route│   │  Audit log      │  │  PUT │ /link/handshake  │
 └──────────────┘     │ │                 │◀──│  (per-session)  │◀─┼──────│ 4 GRANTED        │
   ▲ Transport seam   │ └────────┬────────┘   └────────┬───────┘  │ POST │ /grants          │
   │ Platform seam    │          │ Transport.dispatch() │ Expose  │◀─────│ 5 INVOKE         │
   │                  │          ▼                      ▼          │      │ /invoke          │
   └──────────────────│   local-rest│stdio│ipc│mcp│cli  one URL   │     └──────────────────┘
                      └───────────────────────────────────────────┘
                         Platform seam (macOS first): binary discovery,
                         process spawn, local-service location — all OS-specific
                         parts isolated behind PlatformServices.
```

**Key invariant:** the client only ever talks to one stable endpoint surface.
Scan / adapt / protocol-translation are all sealed inside the Plexus process —
both an engineering decoupling and a compliance boundary. (The diagram shows the
five-step agent loop; ENROLL runs **once** per agent — every later session starts
at HANDSHAKE with the stored PAT. The full endpoint set adds the lifecycle
endpoints `/grants/refresh`, `/grants/revoke`, `/grants/status`, `/manifest`,
`/events`, `/extensions` — all advertised in `.well-known`, see §2.)

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

> **Status:** transport/client layer exists and is tested; the user-facing "wrap an
> MCP server as a source" path is **not shipped yet** (no MCP source module in the
> production registry). The projection below is the contract this transport will use
> (see [`../KNOWN-LIMITATIONS.md`](../KNOWN-LIMITATIONS.md)).

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

> **Schema-validation note (review #10):** "verbatim passthrough" means the JSON
> Schema rides through to the manifest/agent **unchanged** — it does NOT mean
> `/invoke` fully enforces it. Runtime invoke does **lightweight validation only**:
> required keys present + each top-level property's primitive type + opt-in
> `additionalProperties` rejection. Nested objects, `$ref`, `format`, and union
> schemas are **not** enforced at invoke; the verbatim schema is agent/manifest
> guidance, not a full JSON-Schema invoke gate.

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
[`orchestrator.pipeline.run.json`](./examples/orchestrator.pipeline.run.json)
(a workflow source, `kind:"workflow"`, `transport:"workflow"`,
`grants:["execute"]`, with `members`).

---

## §2 — Endpoint contract

All endpoints are served on the loopback bind by default (default
`http://127.0.0.1:7077`); binding a chosen NIC or `0.0.0.0` is an opt-in via
`~/.plexus/network.json`, with the connection-key as the LAN trust boundary (see
§5). Errors use the uniform `ErrorResponse` envelope.

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
      "grants": ["read"], "transport": "local-rest",
      "provenance": "first-party", "sensitivity": "low",
      "recommendedTrustWindow": { "kind": "7d" } },
    { "id": "orchestrator.pipeline.run", "source": "orchestrator", "kind": "workflow",
      "label": "Run a long-horizon orchestration",
      "summary": "Build a task DAG and dispatch parallel agents toward a goal.",
      "grants": ["execute"], "transport": "workflow" },
    { "id": "mcp.github.create_issue", "source": "mcp:github", "kind": "capability",
      "label": "Create a GitHub issue",
      "summary": "Create a new issue in a GitHub repository.",
      "grants": ["write"], "transport": "mcp" }
  ],
  "auth": {
    "enrollmentUrl": "http://127.0.0.1:7077/agents/enroll",
    "enrollment": {
      "url": "http://127.0.0.1:7077/agents/enroll",
      "method": "POST",
      "auth": "body.code",
      "body": { "code": "<one-time enrollment code (plx_enroll_…, delivered out of band)>" },
      "success": { "pat": "<durable bearer PAT (plx_agent_…) — store it yourself>", "agentId": "<your agentId>" },
      "patStorage": "Store the returned PAT yourself (it is returned exactly ONCE), then present it as Authorization: Bearer plx_agent_… at handshake. Enrollment happens once; the stored PAT authenticates every later session."
    },
    "handshakeUrl": "http://127.0.0.1:7077/link/handshake",
    "grantsUrl": "http://127.0.0.1:7077/grants",
    "grantRequestUrl": "http://127.0.0.1:7077/grants",
    "grantRequestMethod": "PUT",
    "sessionHeader": "X-Plexus-Session",
    "refreshUrl": "http://127.0.0.1:7077/grants/refresh",
    "revokeUrl": "http://127.0.0.1:7077/grants/revoke",
    "grantStatusUrl": "http://127.0.0.1:7077/grants/status",
    "invokeUrl": "http://127.0.0.1:7077/invoke",
    "manifestUrl": "http://127.0.0.1:7077/manifest",
    "eventsUrl": "http://127.0.0.1:7077/events",
    "grantsListUrl": "http://127.0.0.1:7077/grants",
    "tokenScheme": "plexus-scoped-jwt"
  }
}
```

The `auth` block is self-describing: a cold agent that has redeemed its code and
stored its PAT reads `handshakeUrl` (present a `Bearer plx_agent_…`),
`grantRequestUrl` + `grantRequestMethod`, and `sessionHeader` straight from here —
it never hard-codes paths or guesses the auth scheme. `enrollment` describes the
one-time code → PAT redeem (below). There is **no** `connectionKey` field and no
`connectionKeyDelivery` here: the connection-key is the owner's admin credential
and is never advertised to, or held by, an agent (§5).

> **Endpoint-namespace convention (ADR-016):** the agent reads every endpoint URL
> from this `auth` advertisement rather than hard-coding paths. The agent-plane
> endpoints live under the flat namespace `/agents/enroll` (pre-session, code-gated),
> `/link/handshake` (PAT-gated), `/grants`, `/grants/refresh`, `/grants/revoke`,
> `/grants/status`, `/invoke`, `/manifest`, `/events`, `/extensions`. The
> owner's management plane lives under a separate `/admin/api/*` namespace, gated by
> the connection-key — an agent never reaches it (§5).

### `POST /agents/enroll` → redeem a one-time code for a durable PAT (code-gated)

Run **once** per agent, before the first handshake. The agent presents its
**one-time enrollment code** (`plx_enroll_…`, single-use, ~15 min) — delivered out
of band by the install command the owner handed it (§5). The gateway redeems the
code and returns the agent's **durable per-agent PAT** (`plx_agent_…`) in plaintext
**exactly once**; it is stored hashed at rest. The `agentId` is bound by the code
server-side — it is **not** self-asserted.

**Request:**
```json
{ "code": "plx_enroll_2b7d…c90" }
```
**Response:**
```json
{ "pat": "plx_agent_9f1a…44e", "agentId": "agent-ez-1" }
```
The agent stores the PAT itself (its own paradigm, `0600`), then presents it at
every handshake. The code is consumed on success (a replay fails `code_consumed`).
Fail-closed reasons: `malformed` / `unknown_code` / `code_expired` /
`code_consumed` / `persist_failed` (a durable-write failure leaves the code
unconsumed for retry). The connection-key is **never** accepted here.

### `POST /link/handshake` → full manifest (PAT-gated for agents)

The agent presents its **per-agent PAT** as `Authorization: Bearer plx_agent_…` —
**no `connectionKey` in the body**. The gateway verifies the PAT, resolves the
**real `agentId`** from it (any `client.agentId` is metadata only, coerced to the
verified id — see §4d), opens a session bound to that id, and returns the **full
manifest**: every entry with full `describe`, `io` schemas, `grants`, `transport`,
attached skill bodies, and MCP passthrough.

> **Admin path (not the agent path):** the same endpoint also accepts an **owner**
> who presents `{ "connectionKey": "plx_live_…" }` in the JSON **body** (no Bearer) —
> this is the console's authority and may legitimately name an `agentId`. The two
> paths are selected by credential presence and never fall through to each other; an
> agent has no connection-key to reach the admin path with.

**Request** (`Authorization: Bearer plx_agent_9f1a…44e`):
```json
{
  "client": { "name": "claude-code", "version": "2.x" }
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
> pending`). **The shipped default is `UserConfirmAuthorizer` in `confirm-risky`
> mode:** read-only grants on first-party / managed sources auto-approve, but any
> **`write` / `execute`** grant (and any grant on an `extension`-provenance source)
> **PENDS for the owner** — returning `grant_pending_user`. A fully permissive
> `AutoApproveAuthorizer` also exists (used by some internal / test flows) and is a
> drop-in, but it is **not** the agent-facing default. Either policy is the same
> wire — the `grant_pending_user` + `GET /grants/status` poll channel is exercised
> by default for mutating grants, **no wire change** to swap.

**Request:**
```json
{
  "sessionId": "sess_01J…",
  "grants": {
    "obsidian.vault.read": "allow",
    "mcp.github.create_issue": { "decision": "allow", "verbs": ["write"] },
    "orchestrator.pipeline.run": { "decision": "allow", "verbs": ["execute"] }
  }
}
```
`"allow"` shorthand normalizes to read-only default. The github entry asks for
`write` explicitly. The orchestrator **workflow** asks for `execute`.

**Response (approved — note the synthesized transitive member scopes):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWI…",
  "jti": "tok_01J…",
  "expiresAt": "2026-06-23T11:15:00.000Z",
  "scopes": [
    { "id": "obsidian.vault.read", "verbs": ["read"] },
    { "id": "mcp.github.create_issue", "verbs": ["write"] },
    { "id": "orchestrator.pipeline.run", "verbs": ["execute"] },
    { "id": "orchestrator.plan.create", "verbs": ["write"], "synthesizedFor": "orchestrator.pipeline.run" },
    { "id": "orchestrator.task.dispatch", "verbs": ["execute"], "synthesizedFor": "orchestrator.pipeline.run" },
    { "id": "orchestrator.plan.status", "verbs": ["read"], "synthesizedFor": "orchestrator.pipeline.run" }
  ],
  "transitive": [
    {
      "workflowId": "orchestrator.pipeline.run",
      "memberScopes": [
        { "id": "orchestrator.plan.create", "verbs": ["write"] },
        { "id": "orchestrator.task.dispatch", "verbs": ["execute"] },
        { "id": "orchestrator.plan.status", "verbs": ["read"] }
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
  "pending": ["orchestrator.pipeline.run"],
  "statusUrl": "http://127.0.0.1:7077/grants/status?pendingId=pend_01J…"
}
```
The agent then polls `GET /grants/status` (below) or awaits a `grant_resolved`
event. (The default `confirm-risky` authorizer emits this for any grant carrying a
mutating `write` / `execute` verb — the normal path for every non-read capability.)

### `GET /grants/status?pendingId=…` → resolve a pending grant (review #9)

The resolution channel so a `grant_pending_user` never dead-ends. The agent polls
until `state` is terminal; on `"approved"` the minted token is included.

**Response:**
```json
{
  "pendingId": "pend_01J…",
  "state": "approved",
  "capabilities": ["orchestrator.pipeline.run"],
  "token": {
    "token": "eyJ…",
    "jti": "tok_02K…",
    "expiresAt": "2026-06-23T11:30:00.000Z",
    "scopes": [ { "id": "orchestrator.pipeline.run", "verbs": ["execute"] } ]
  }
}
```

### `POST /grants/refresh` → grant-backed token re-mint (review #4)

Token lifetime is **15 min, locked** — but a long-running multi-step workflow can run **>24h**.
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
  "scopes": [ { "id": "orchestrator.pipeline.run", "verbs": ["execute"] } ],
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
{ "agentId": "agent-ez-1", "capabilityId": "orchestrator.pipeline.run" }
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
3. confirms a scope covers `id` with every verb the entry **requires** — and, when
   the scope carries a `constraint` (`ScopeConstraint`), that the call's `input`
   satisfies it (`constraintSatisfied`); else the scope is inert and the call is
   default-denied (`grant_required`) — see §4 content-aware authorization;
4. validates `input` against `io.input` (**lightweight**: required keys +
   top-level primitive types + opt-in `additionalProperties` — not full JSON
   Schema; see the schema-validation note in §1);
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

#### One result contract on `/invoke` (v0.1.1 — tp2 / ADR-017)

`/invoke` ALWAYS returns an **`InvokeResponse`-shaped body** — for success AND for
**every denial**, including auth/pre-dispatch ones (no token, `grant_required`,
`token_revoked`/`token_expired`, `session_expired`, `unknown_capability`,
`schema_validation_failed`). A denial body is:

```json
{
  "id": "orchestrator.pipeline.run",
  "ok": false,
  "error": { "code": "grant_required", "message": "No grant for orchestrator.pipeline.run (execute).",
             "capabilityId": "orchestrator.pipeline.run" },
  "auditId": "evt_03L…"
}
```

So a naive agent deserializing every `/invoke` reply as `InvokeResponse` always
reads `ok:false` on denial — never `ok === undefined`. `error.code` is drawn from
the **closed `ErrorCode` union** (§7) so the agent still branches deterministically
(refresh vs. re-grant vs. re-handshake vs. give up). `auditId` is the audit event id
for AUDITED denials (every pipeline pre-dispatch denial is audited), and the empty
string `""` for EDGE denials that fail before the pipeline audits (no token /
malformed token / unparseable body).

The **HTTP status** still classifies the failure for agents that branch on it:

| denial `error.code` | HTTP status |
|---|---|
| `grant_required`, `token_expired`, `token_revoked`, `session_expired`, `grant_pending_user` | `401` |
| `host_forbidden` | `403` |
| `unknown_capability` | `404` |
| `schema_validation_failed` | `422` |
| `rate_limited` | `429` |
| `source_unavailable` | `503` |
| `mcp_tool_error`, `transport_error` (in-band dispatch failures) | `200` |
| `internal_error` (and any unmapped code) | `400` |

> **Scope of the single shape:** this `InvokeResponse`-only rule is **`/invoke`-only**.
> Every OTHER endpoint keeps the uniform `ErrorResponse` envelope (`{ error:{…} }`)
> on failure (§7). `/invoke` is special because its success body is already an
> `InvokeResponse`, so collapsing its denial path to the same shape gives the agent
> one contract on the call path it hits most.

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

### `GET /grants` → standing-grant ledger (ADR-018, v0.1.2, session-authenticated)

The agent's symmetrical view of the user's Grants screen — the caller's **standing
grants** (the durable, human-approved trust, distinct from the 15-min tokens).
Session-authenticated exactly like `GET /manifest`; for a management session it
returns ALL standing grants. Advertised via `AuthAdvertisement.grantsListUrl`.
Returns `GrantsListResponse { grants: StandingGrant[] }` — see §4d for the shape and
the trust model. (The admin UI uses the management-key-gated `GET /admin/api/grants`.)

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

> **Status:** the transport/client layer below is implemented and tested, but no
> MCP source is registered in production (`MODULES`) and there is no shipped path to
> wrap an MCP server as a source yet (see
> [`../KNOWN-LIMITATIONS.md`](../KNOWN-LIMITATIONS.md)).

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

- **Scope shape:** `scopes: { id, verbs[], synthesizedFor?, constraint? }[]`. Token
  authority = exactly this union. A call is allowed only if a scope covers the
  entry's `id` with EVERY verb the entry requires. Default minimal + **read-only**
  (a bare `"allow"` grants `["read"]`). A `synthesizedFor` scope is a workflow's
  transitive member scope (§2).
- **Content-aware authorization (AUTHZ-UX §3.1):** authorization is content-aware,
  not merely per-capability+per-verb: a scope/grant may carry an optional
  `constraint` (`ScopeConstraint`) that only NARROWS coverage — a scope covers a
  call only when the call's `input` satisfies the constraint (`constraintSatisfied`);
  outside it the scope is inert and the call is default-denied (`grant_required`).
  The enforced constraint rides in the signed JWT `scopes` and is checked at the
  SAME `POST /invoke` chokepoint every call already passes (step 3 below) — it
  comes from the verified token, never the request body, and FAILS CLOSED on a
  missing/malformed input field or an unsupported op. Absent ⇒ today's
  whole-capability scope (unchanged).
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
  be **live**. An **agent** session is bootstrapped under its **PAT**, so it is
  decoupled from connection-key rotation and dies only when that agent's PAT is
  revoked (`POST /admin/api/agents/revoke`, §5). Connection-key **rotation**
  invalidates the **admin/key-bootstrapped** sessions and enqueues their tokens'
  jtis for revocation. Liveness failure ⇒ `session_expired`.
- **Audit linkage:** `sub` (agent id), `jti` (token id), and `sessionId` thread
  through every `AuditEvent`, so every call traces to a token and an agent.

### Error codes (closed union — review #10)

`ErrorResponse.error.code` and `InvokeResponse.error.code` draw from a **closed
`ErrorCode` union** so the agent branches recovery deterministically. Every endpoint
returns failures in the uniform `ErrorResponse` envelope (`{ error:{…} }`) — **except
`POST /invoke`**, which since v0.1.1 (tp2 / ADR-017) returns the `InvokeResponse`
shape (`{ id, ok:false, error:{…}, auditId }`) for ALL denials so it has one result
contract (see §2 `POST /invoke`). The `error.code` and HTTP status are identical
across both framings; only the surrounding body differs.

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

## §4d — Unified trust model (ADR-018, v0.1.2, additive)

The grant machinery has always been correct; v0.1.2 **names** it and **surfaces**
it so a human in the UI, an agent reading the protocol, and a developer reading the
API all read the SAME facts. Everything here is ADDITIVE under the frozen wire: new
optional fields and one new endpoint. A `v0.1.1` client ignores all of it.

### Vocabulary glossary (one word per concept, used verbatim everywhere)

| term | meaning |
|---|---|
| **agent** | The identity a grant is **scoped** to (`agentId`), bound server-side by the agent's **PAT** at handshake — **not** self-asserted (see "Trust boundary & agentId" below). A stable, PAT-verified `agentId` lets Plexus remember standing grants across sessions. A session with no verified PAT (`anon:*`) gets **no standing trust** and re-asks every session. |
| **capability** | The callable entry (`CapabilityId`). |
| **scope** | One `(capability × verbs)` line carried by a token (`TokenScope`). |
| **grant** | The standing, **human-approved** permission `(agentId, capabilityId, verbs)`: this agent may use this capability with these verbs until the trust-window ends (`StandingGrant`). |
| **trust-window** | How long a grant **stands** before re-approval is needed — the lifetime of the human's *decision* (`TrustWindow`). |
| **token** | A short-lived (≈15-min) auto-refreshed **view** of a grant; the thing presented on `/invoke` (`ScopedToken`). |
| **provenance / source-class** | Where the capability came from: `first-party` / `managed` / `extension` (`Provenance`). |
| **sensitivity** | Derived risk tier for narration: `low` / `elevated` / `high` (`Sensitivity`). |

### The two clocks

Two distinct lifetimes, finally named together:

| clock | what it bounds | value | who cares |
|---|---|---|---|
| **token-lifetime** | blast radius of a leaked credential | ~15 min, auto-refreshed (`ScopedToken.expiresAt`) | security invariant — short on purpose; clamped to `[1min, 60min]`, never per-approval, never agent-choosable |
| **trust-window** | how long the human's approval stands before Plexus re-asks | per source-class × verb (below); `StandingGrant.expiresAt` / `ScopedToken.grantExpiresAt` | the user-legible truth; narrated by the agent |

Both are configurable in `~/.plexus/auth-config.json` (`tokenLifetimeMs` clamped to
`[60000, 3600000]`; `maxTrustWindowMs` caps **`custom`** durations at 30 days — the
`until-revoked` sentinel is NOT clamped by it).

### Trust boundary & agentId

Plexus has **two** trust boundaries, held by two different parties:

- The **connection-key** (`plx_live_…`) is the **admin/management** boundary. The
  owner-as-admin holds it; it authenticates the `/admin` console and the admin path
  of handshake. Rotating it revokes everything key-bootstrapped. **Agents never see
  it.**
- Each **agent** authenticates with its **own per-agent PAT** (`plx_agent_…`). The
  PAT is the agent's session-bootstrap secret and its identity: at handshake the
  gateway resolves the **real `agentId`** from the PAT and binds the session to it,
  overwriting any `client.agentId` (metadata only). A client therefore **cannot
  self-assert** another agent's identity — naming an agent without its PAT gets a
  401, no session. Per-agent identity is **shipped**, not deferred.

Because `agentId` is PAT-verified, standing grants are safely scoped per agent: a
leaked PAT rides only that one agent's grants, and revoking one agent
(`POST /admin/api/agents/revoke`) leaves every other agent untouched — unlike a
shared key whose rotation cuts everyone off. **The admin path may still name an
`agentId`** (the console's "connect an agent" does exactly this): that is not a
spoof, because holding the connection-key *is* the admin authority. The remaining
deferred hardening is a **keypair (proof-of-possession) PAT** — v1 uses a bearer
PAT; identity itself is not deferred.

### The 3-class provenance + posture table

Standing-eligibility is decided by **sensitivity (provenance × verb), not origin**
(ADR-5). Default trust-windows below are the read/write/**execute** ceiling per class:

| provenance | meaning | read posture | write posture | execute posture | default window (read / write / execute) |
|---|---|---|---|---|---|
| **first-party** | reserved/in-process source (claudecode, obsidian(fs), mock) | **auto-allow** | pend | pend | 7d / 1d / **once** |
| **managed** | source the user added through the trusted admin UI (human-vetted at add-time) | **auto-allow** (shares first-party read posture) | pend | pend | 7d / 1d / **once** |
| **extension** | wire-registered by an agent via `POST /extensions` (strictest) | **pend** | pend | pend | 1d / 1d / **once** |

- **`execute` is per-use (`once`) unless the owner opted it standing (ADR-5 floor,
  ADR-023 opt-in).** Any un-opted `execute` capability — first-party, managed, or
  extension — is approved **per-use** (`once`), never frictionless. `chooseTrustWindow`
  clamps it to `once` **regardless of the requested window and regardless of whether
  the pick is admin-authoritative**; the sole lift is the per-agent, per-capability
  owner **standing opt-in** (`agentSubsets.isStanding`, default-off + double-confirm).
  Never depict an un-opted `execute` grant riding a standing window.
- Auto-allowed reads are **never silent**: they still appear in the standing-grant
  ledger with their trust-window.
- A **standing, unexpired** grant for `(agentId, capabilityId)` short-circuits the
  re-ask for any verb it covers. A `once` grant (`standing:false`,
  `expiresAt = grantedAt`) is single-use and **never** short-circuits.
- `until-revoked` exists (far-future sentinel; only an explicit revoke ends it) but
  is **never a default**; custom durations are capped at 30 days.
- `anon:*` sessions (no verified PAT) are session-only: never persist a standing
  (> session) grant under an anonymous id (capped at `once`).

### New endpoint — `GET /grants` (session-authenticated)

Returns the caller's standing-grant ledger — the agent's symmetrical view of the
user's Grants screen. Session-authenticated exactly like `GET /manifest`; for a
management session it returns ALL standing grants. Advertised via
`AuthAdvertisement.grantsListUrl`. (The admin UI uses the management-key-gated
`GET /admin/api/grants`.)

```
GET /grants                       → GrantsListResponse { grants: StandingGrant[] }
```

`StandingGrant = { agentId, capabilityId, verbs[], provenance, sensitivity?,
grantedAt, expiresAt, trustWindow, standing, synthesizedFor?, constraint?,
bundleId?, topLevelDisabled? }` — where `expiresAt` is the trust-window end (the
user-legible truth) and `standing:false` flags a non-renewable `once` grant. The
durable `constraint` (`ScopeConstraint`) is the content-aware narrowing the grant
was approved under (so refresh re-mints a token carrying the SAME enforced
constraint; absent ⇒ an unconstrained whole-capability grant); `bundleId` tags a
member of a named Mode-2 task bundle (a grouping that confers NO authority beyond
its members); `topLevelDisabled:true` flags a grant whose capability is currently
disabled at the "What I expose" top level (the record stands, but the capability is
invisible + uninvokable until re-enabled — effective access = granted ∧ exposed).

### Additive optional fields (every change is non-breaking)

| type | added optional field(s) | purpose |
|---|---|---|
| `CapabilityEntry`, `CapabilitySummary` | `provenance`, `sensitivity`, `recommendedTrustWindow` | so an agent can narrate the cost *before* requesting (omitted ⇒ treat as `extension`) |
| `GrantDecision` | `trustWindow`, `purpose`, `constraint` | requester-proposed window — **advisory** on the agent path (may be shortened, never lengthened past the per-class ceiling), **authoritative** on the admin approve path; `purpose` is agent free-text WHY (TRANSPARENCY only — influences NO decision; rendered separately as "the agent says:", capped 280 chars); `constraint` (`ScopeConstraint`) the content-aware narrowing to attach (NARROWS only; minted onto `TokenScope.constraint`) |
| `GrantPendingResponse`, `GrantStatusResponse` | `pendingNarration[]` | gateway-authored `{ id, verbs, provenance, sensitivity, defaultTrustWindow, summary, notificationLine? }` so every agent relays the SAME truthful one-liner; `notificationLine` is the ~120-char gateway-authored tray/notification form (web ignores it) |
| `GrantRequest` | `bundle` | Mode-2 TASK BUNDLE envelope `{ name, agentId?, context? }` — the multi-capability (+constraint) request is treated as ONE named bundle (members share a `bundleId`, risky members group-pend as one Approve); a bundle adds NO new authority |
| `StandingGrant` | `constraint`, `bundleId`, `topLevelDisabled` | the durable approved-under constraint (re-minted on refresh); the task-bundle tag; the "granted but disabled (invisible)" exposure flag |
| `TokenScope` | `constraint` | the ENFORCED scope constraint that rides in the signed JWT scopes and is checked at invoke (`constraintSatisfied`) |
| `BundleView`, `GrantContextRef` | (new types) | the admin Grants view's bundle projection (`GET /admin/api/bundles`) and a reference to one piece of in-scope task context (reuses the `kind:"skill"` mechanism — `skill` ref or capped `inline` markdown; no new transport) |
| `CapabilityEntry`, `CapabilitySummary` | `health` | the inherited per-source health SNAPSHOT (HEALTH; see below) |
| `ScopedToken` | `grantExpiresAt`, `trustWindow` | the trust-window ceiling next to the 15-min `expiresAt` |
| `ScopedTokenClaims` | `gexp` | grant/trust-window expiry epoch (diagnostics) |
| `AuthAdvertisement` | `grantsListUrl` | where to `GET /grants` |
| `AuthorizationDecision` | `provenance`, `sensitivity`, `recommendedTrustWindow` | structured reason so the service builds `pendingNarration` without re-deriving |

**Health (HEALTH).** Capabilities carry health (`CapabilityHealth` / `HealthStatus`:
`ok` | `degraded` | `unavailable` | `unknown`) so agents can read availability and
degrade gracefully. The snapshot is per-source (derived from a source's optional
`health()` method, or from its `checkRequirements()` when that is absent — only
`health()` can report `degraded`), inherited onto every `CapabilityEntry.health` /
`CapabilitySummary.health` of that source, and stamped from the gateway's short-TTL
health cache at serialization time. Advisory only.

**Sensitivity derivation** (gateway-computed so all surfaces agree): `low` = read on
first-party/managed; `elevated` = write/exec on first-party/managed OR read on
extension; `high` = write/exec on extension OR any cli/local-rest transport with
write/exec. Workflows roll up members' sensitivity (max wins).

---

## §5 — Security model

- **Bind:** loopback (`127.0.0.1`) **by default**. Binding a chosen NIC or
  `0.0.0.0` is **opt-in** via `~/.plexus/network.json`; when enabled, EVERY
  `/admin/api/*` route is **connection-key gated** — the connection-key becomes the
  LAN trust boundary. (The Host/Origin guard below still runs on every endpoint
  before auth, regardless of bind.)
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
  PAT-gated handshake (an enrolled agent's `Bearer plx_agent_…`).
- **Two credentials, never conflated:**
  - **Connection-key** (`plx_live_…`) — the **admin/management** credential and trust
    boundary. Generated by the gateway, shown ONLY in the local management client,
    obtained out of band; it gates `/admin/api/*` and the admin path of handshake.
    **Agents never see or present it.** Rotatable on demand / auto-rotated; rotation
    invalidates the admin/key-bootstrapped sessions **and enqueues their tokens' jtis
    for revocation** (review #8).
  - **Per-agent PAT** (`plx_agent_…`) — the **agent's** own durable credential and
    session-bootstrap secret (NOT call authority). Redeemed **once** from a one-time
    enrollment code (`plx_enroll_…`, ~15 min, single-use) at `POST /agents/enroll`,
    stored `0600` by the agent, hashed at rest, independently revocable per agent
    (`POST /admin/api/agents/revoke`). It authenticates every handshake; a leaked PAT
    rides only that one agent's grants.
- **Default-deny, default-read-only:** no entry is callable without an explicit
  grant; a bare allow grants read only; `write`/`execute` must be named.
- **Pluggable grant authority (ADR-007 revised):** the authorize decision is the
  pluggable `Authorizer` seam (`allow | deny | pending`). **The shipped default is
  `UserConfirmAuthorizer` (`confirm-risky`):** reads auto-approve, `write` / `execute`
  PEND for the owner via `grant_pending_user`. A permissive `AutoApproveAuthorizer`
  also exists (internal / test) and is a drop-in with no wire change. The seam — not a
  specific UX — is the contract.
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

### Connecting an agent — the shipped surfaces (admin → agent → call)

The two-credential model is realized by three shipped surfaces plus a compiled
agent interface. The admin acts once; the agent runs one command; then it calls
capabilities.

1. **Admin connects an agent** — the console wizard, or `POST /admin/api/agents/connect`
   (connection-key gated). It **names** the agent and declares its authorized subset:
   the **read** caps land as **standing** grants under the chosen trust window (the
   human approval, done once); side-effecting caps (**write**/**execute**) enter the
   subset **per-use** — each call pends, and they are reported under `skipped` — unless
   the request's per-capability `standing` opt-in (legacy alias `standingExecute`)
   names them. It also mints a **one-time enrollment code** (`plx_enroll_…`).
2. **Agent runs the ONE-COMMAND install** — `GET /integration/:agentId` serves the
   copy-able install command (management-gated); the self-contained, secret-free
   **`install.sh`** it invokes is public. Running it redeems the code at
   `POST /agents/enroll` → stores the PAT `0600` → deletes the code, and lands the
   compiled Claude Code plugin.
3. **Agent calls capabilities** — via its bundled launcher (below).

**The agent interface — the compiled plugin + per-agent launcher.** The plugin ships
a **version-isolated launcher `plexus-<agentId>`** that execs its OWN bundled engine
(the sibling `bin/plexus`) and binds `PLEXUS_AGENT_ID` — never a global `plexus`, so
two agents' plugins can't collide or authenticate as the wrong agent. Subcommands:

```
plexus-<agentId> enroll <code>       # once, at install: redeem code → store PAT
plexus-<agentId> list                # discover: callable-now vs needs-approval
plexus-<agentId> <capabilityId> …    # invoke a granted capability
```

The **bundled skill** is a projection over the always-present self-describing Floor
(`.well-known` + `requestShapes` + how-to-use); a stale skill can never exceed the
Floor's live authz. **Load-bearing rule:** the launcher command is the agent's
**complete and only** interface — never hand-roll HTTP, never call
enroll/handshake/manifest by hand, never guess auth. The engine that performs the
enroll → handshake → grant → invoke chain (`bin/plexus`) is byte-verified against the
committed sanctioned engine at build time; no auth path is LLM-authored.

**Persistence.** A registered extension and its projected entries **persist across
gateway restart** — on reboot Plexus trusts the already-persisted config and boots it
without re-prompting (a fresh registration still pends a human; §4d exposure/grant
records survive too).

### Worked flow — a >24h workflow orchestration on a 15-min token

1. Agent handshakes, `PUT /grants` for `orchestrator.pipeline.run` (`execute`).
   The token also carries the **synthesized member scopes** (plan.create / task.
   dispatch / plan.status), surfaced to the user via the `transitive` block.
2. Agent `POST /invoke`s the workflow → the `WorkflowTransport` fans out to members
   via `invokeById`, each scope-checked + audited, revocation re-checked per member.
3. The 15-min token nears `exp`. The agent calls `POST /grants/refresh` with its
   `jti` + session → a fresh 15-min token, **no connection-key, no re-prompt**,
   bounded by `grantExpiresAt`. Repeat across the >24h run.
4. Mid-run, a source adds capabilities → `manifest_changed` SSE event → agent
   `GET /manifest` to refresh. If the user revokes from the management client →
   `token_revoked` event + the workflow halts before its next member dispatch.

> **ADR-5 caveat:** `orchestrator.pipeline.run` is an `execute` capability, so absent
> the explicit owner standing opt-in (ADR-023) its grant is per-use (`once`) — never a
> multi-day standing grant — and the refresh loop above must never be read as an
> un-opted `execute` cap riding a standing window.
> Refresh-for-longevity is the pattern for **standing-eligible** scopes (`read`/`write`
> within their trust-windows, e.g. the `plan.status` read member); the `execute`
> approval covers its single sanctioned invocation, and re-invoking the workflow
> re-prompts the owner. See §4d and [`../design/security-model.md`](../design/security-model.md) §3.

---

## §6 — Adapter-layer architecture

Two layers, mirroring pneuma-skills. The adapter type is **hidden** behind these
interfaces; the core never branches on source/transport type.

- **Lifecycle layer — `CapabilitySource`** (≈ pneuma `AgentBackend` +
  `BackendModule`): `checkRequirements()` (cheap availability probe via platform
  seam), `scan()` (enumerate/project entries — for MCP this runs the client
  handshake + list **paged to exhaustion** + re-project; for a source exposing
  a `kind:"workflow"` entry, `scan()` returns the workflow AND its member
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

- [`VERSION`](./VERSION) — contract version tag (`0.1.3`).
- [`types.ts`](./types.ts) — canonical TypeScript types (source of truth).
- [`examples/obsidian.vault.read.json`](./examples/obsidian.vault.read.json) — user extension, read-only.
- [`examples/orchestrator.pipeline.run.json`](./examples/orchestrator.pipeline.run.json) — workflow entry, execute, `WorkflowMember[]` members.
- [`examples/mcp-tool-passthrough.github.create_issue.json`](./examples/mcp-tool-passthrough.github.create_issue.json) — ingested MCP tool, verbatim passthrough.
- [`examples/extension-manifest.obsidian.json`](./examples/extension-manifest.obsidian.json) — minimal user-extension manifest (Flow B register path).
- [`DECISIONS.md`](./DECISIONS.md) — ADRs (M0 v0.1.3).
