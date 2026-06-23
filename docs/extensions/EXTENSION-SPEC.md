# Plexus Standard Extension Spec — v0.1

> Status: **M4 public spec (v0.1)** · Protocol: **plexus-extension/0.1** · Gateway
> contract: **PLEXUS_PROTOCOL_VERSION 0.1.1** · Date: 2026-06-23
>
> This is the public, documented contract for **authoring a Plexus extension** —
> the way anyone connects a local app, CLI, script, or HTTP service to Plexus so
> any AI agent can DISCOVER → UNDERSTAND → be GRANTED → CALL it. It **formalizes
> what already ships** (`ExtensionManifest`, `materializeExtension`,
> `CapabilityRegistry.registerExtension`, `ExtensionSource`/`ExtensionBridge`) into
> a stable authoring surface. It invents no new wire. Where a field's normative
> source is a frozen type, this doc points at it; the type is authoritative.

- Frozen types: [`src/protocol/types.ts`](../../src/protocol/types.ts) §1, §1b, §6.
- Runtime: [`src/sources/extension.ts`](../../src/sources/extension.ts),
  [`src/core/capability-registry.ts`](../../src/core/capability-registry.ts).
- Worked sources: [`src/sources/obsidian/`](../../src/sources/obsidian/),
  [`src/sources/cc-master/`](../../src/sources/cc-master/).
- ADRs: [`docs/protocol/DECISIONS.md`](../protocol/DECISIONS.md) ADR-003/004/005/009/012/013.

---

## 1. What an extension is

An **extension** is a user-installable bundle that declares a **capability
SOURCE** and the **entries** it contributes, packaged as one
[`ExtensionManifest`](../../src/protocol/types.ts). When registered, the gateway
**materializes** the manifest into a runtime `CapabilitySource` — *identical in
shape to a compile-time first-party source* — so the gateway treats it exactly
like any other source: its entries are discoverable (`.well-known` / handshake
manifest / `GET /manifest`), grantable (`PUT /grants`), and invocable (`POST
/invoke`). **An agent cannot tell a user extension apart from a first-party
adapter or an ingested MCP tool — all three are just `CapabilityEntry` objects.**

The **isomorphic entry model** (ADR-004) is the heart: every capability, skill,
and workflow is one `CapabilityEntry` discriminated by `kind`. An extension
declares entries via `ExtensionCapabilityDecl` and the gateway projects each into
a full `CapabilityEntry` (the `id`, `source`, and skill back-links are
gateway-derived).

```
ExtensionManifest  ──register──►  materializeExtension()  ──►  SourceModule
                                                                 │
                              ┌──────────────────────────────────┼─────────────────────┐
                              ▼ scan()                            ▼ createBridge()
                        ExtensionSource                     ExtensionBridge
                  (lifecycle: scan→CapabilityEntry[])   (per-session: invoke→transport|handler)
```

There are **two registration channels** (both materialize the same way; see §9):

1. **Transport-backed** — the HTTP `POST /extensions` endpoint. The manifest's
   entries are reached over a wire transport (`local-rest` / `cli` / `stdio` /
   `ipc`) or a sentinel (`skill` / `workflow`). This is the path any external
   author uses. **No in-process code runs.**
2. **In-process-handler** — `capabilities.registerExtension(manifest, { handlers })`
   from gateway-owned code (e.g. the Obsidian vault read, the cc-master board ops).
   Reserved for first-party / gateway-bundled sources that ship bespoke,
   gateway-tested enforcement. **Not reachable over the wire** (you cannot upload
   a function); a third-party extension cannot inject in-process code.

---

## 2. The extension manifest schema

Normative type: [`ExtensionManifest`](../../src/protocol/types.ts) §1b. Wire JSON
is a flat, JSON-serializable object.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `manifest` | **yes** | `"plexus-extension/0.1"` literal | Manifest schema version. The gateway **rejects** any other value. |
| `source` | **yes** | `SourceId` | The source id this extension registers. Its id-slug (`:`→`.`) seeds every entry id (ID-DERIVATION RULE). Lower-kebab/dot, e.g. `obsidian`, `linear`, `mcp:github` (slug `mcp.github`). |
| `label` | **yes** | `string` | Human-readable source label, e.g. `"Obsidian (Local REST API)"`. |
| `transport` | **yes** | `Exclude<TransportKind,"mcp">` | DEFAULT transport for capabilities that don't override it. One of `local-rest \| stdio \| ipc \| cli \| skill \| workflow`. |
| `capabilities` | **yes** | `ExtensionCapabilityDecl[]` | The entries (capability/skill/workflow) this extension contributes. MUST be non-empty to register usefully. |
| `secrets` | no | `ExtensionSecretRef[]` | Secret references the transports need (resolved by name via the platform seam; see §7). |
| `serviceHint` | no | `LocalServiceHint` | How to locate a `local-rest`/`ipc` service (`{ app, defaultPort?, socketName? }`). |

### 2.1 `ExtensionCapabilityDecl` — one contributed entry

Normative type: [`ExtensionCapabilityDecl`](../../src/protocol/types.ts) §1b.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `name` | **yes** | `string` | `<noun>.<verb>` suffix. Full id becomes `<sourceSlug>.<name>` (e.g. source `obsidian` + name `vault.read` ⇒ id `obsidian.vault.read`). |
| `kind` | **yes** | `"capability" \| "skill" \| "workflow"` | The entry kind (ADR-004). |
| `label` | **yes** | `string` | Short human/agent label. |
| `describe` | **yes** | `string` | **THE HEART.** Agent-facing "what / when / how", written for an AI deciding whether to call it. Follow the claude-plugin convention: *"Action outcome. Use when X."* (See §3.) |
| `grants` | **yes** | `GrantVerb[]` | Verbs this entry REQUIRES (`read`/`write`/`execute`). `[]` = no grant required (skills). Default-deny + default-read-only (ADR-005). |
| `transport` | no | `Exclude<TransportKind,"mcp">` | Overrides the manifest default for this entry. |
| `io` | no | `IoSchema` | `{ input?, output? }` JSON Schemas (Draft 2020-12). Input is **enforced** at invoke. Omit for skills. |
| `members` | for `kind:"workflow"` | `WorkflowMember[]` | Ordered member ids + the verbs the workflow may exercise on each. Each id MUST resolve to a present registry entry (§8). |
| `body` | for `kind:"skill"` | `SkillBody` | The inline usage markdown (`{ format:"markdown", markdown }`) or a content ref. |
| `route` | no | `Record<string, unknown>` | Transport routing config — **read ONLY by the owning transport, never by core**. See §5 + §6. |

### 2.2 `route` recognized keys (per transport)

`route` is an open bag. The gateway core never reads it; only the owning
transport (or the skill back-link wiring) does. Recognized keys:

| Key | Read by | Meaning |
|---|---|---|
| `attachSkills: string[]` | `manifestEntries()` | Declaration `name`s of `kind:"skill"` entries to back-link onto this capability (becomes `entry.skills[]`). See §6. |
| `method`, `pathTemplate`, `secret` | `local-rest` transport | HTTP method, URL path template (may interpolate input fields), and the `ExtensionSecretRef.name` to attach. The runtime `LocalRestTransport` reads `pathTemplate` (canonical), accepting `path` as a legacy alias. |
| `bin`, `args`, `secret` | `cli` transport | Binary name (resolved via platform seam), argv template, secret env var. |
| `op` | `ipc`/in-process bridge | In-process operation selector (e.g. cc-master `board.create`). |
| `handler` | in-process bridge ONLY | Bound by `registerExtension(..., { handlers })` — **a function, never serializable, never present in a wire manifest** (§9). |

---

## 3. Writing a good `describe` (the agent-relevance signal)

`describe` is the layer MCP does not have — it is *how to use me well*, not just
*what I am*. The claude-plugin SKILL.md `description` convention is the model:

> **Action outcome. Use when X.** Then the call shape + the key constraint.

Worked (from the shipped Obsidian extension):

> "Read notes from the Obsidian vault \"Research\" READ-ONLY. Use when you need
> the text of the user's notes to answer, summarize, or cite. Pass `{ path }`
> relative to the vault root to read a note; omit path to list notes.
> Path-confined to the vault; never writes."

Checklist:
- Lead with the **outcome** (what the agent gets), not the implementation.
- State **when to choose it** over alternatives.
- State the **call shape** in one line (the `io.input` is the formal contract).
- State the **boundary** (read-only, path-confined, side-effecting, requires
  execute) — this is what lets the agent reason about the grant cost.

The `.well-known` summary teaser is the **first line** of `describe` (see
`toSummary` in capability-registry). Make the first line a complete sentence.

---

## 4. Transport choices

Normative: [`TransportKind`](../../src/protocol/types.ts) §1 + ADR-003. An
extension may use any transport **except `mcp`** (MCP is the gateway's privileged
ingestion path; you do not *author* MCP entries, you *ingest* them).

| Transport | Use it for | `route` config |
|---|---|---|
| `local-rest` | An app exposing a localhost HTTP(S) API (Obsidian Local REST, a local web service). Plexus is the HTTP client. | `{ method, pathTemplate, secret? }` + `serviceHint`/`secrets`. |
| `cli` | A binary invoked with argv, stdout captured (optionally `--format json`). Binary located via the platform path-resolver. | `{ bin, args, secret? }`. |
| `stdio` | A long-lived subprocess speaking a line/JSON (NDJSON) protocol over stdin/stdout. | spawn spec via `serviceHint`/`route`. |
| `ipc` | OS IPC — unix socket / named pipe / AppleScript bridge — **or** a gateway-owned in-process handler (the Obsidian + cc-master pattern label their in-process bridge `ipc`). | `{ op }` or socket hint. |
| `skill` | `kind:"skill"` entries. Not a wire; the `body` is delivered as context. | — (carries `body`). |
| `workflow` | `kind:"workflow"` entries. Not a wire; the `WorkflowTransport` re-enters the invoke pipeline per member (ADR-013). | — (carries `members`). |

**Decision rule for authors:** if the app already speaks localhost HTTP →
`local-rest`. If it's a binary → `cli`. If it's a persistent protocol process →
`stdio`. If it's an OS socket/AppleScript → `ipc`. Pure usage knowledge → `skill`.
Composition of existing entries → `workflow`. In-process gateway-owned code is
**not** an authoring choice for third parties (§1, §9).

---

## 5. Per-capability grants & access granularity

Normative: [`GrantVerb`](../../src/protocol/types.ts) §1 + ADR-005.

- **Default-deny:** an entry is uninvocable until its `grants` verbs are granted.
- **Default-read-only:** a bare `"allow"` grants `["read"]`; broader verbs must be
  asked for explicitly and surfaced to the user.
- Verbs:
  - `read` — non-mutating query / data read.
  - `write` — mutates state / app data on the user's machine.
  - `execute` — runs a process / side-effecting action that is neither a pure read
    nor a simple write (launching an orchestration, running a build).
- A call is allowed **only if every verb the entry REQUIRES is present** in the
  token's scope for that id. Per-capability + per-verb is the granularity MCP's
  whole-server-audience auth cannot express.

**Authoring discipline — declare the MINIMUM verbs.** A read-only capability MUST
declare `grants:["read"]` and never silently write. Over-declaring verbs makes the
extension look more dangerous and erodes user trust; under-declaring makes calls
fail at scope-check. Resource-instance scoping ("only vault A, only path B") is
**not** a verb — enforce it in `io.input` validation and in the
transport/handler (the Obsidian path-confinement is the model), per ADR-005's
deferral of instance-level constraints.

---

## 6. Attached usage skills

A capability can carry **attached usage skills** so "how to use me well" is
discoverable from the capability AND as a standalone `kind:"skill"` entry. Author
it by:

1. Declaring a `kind:"skill"` entry in `capabilities[]` with a `body`
   (`{ format:"markdown", markdown }`) and `grants:[]`, `transport:"skill"`.
2. On the capability it teaches, set `route.attachSkills: ["<skill decl name>"]`.

The gateway's `manifestEntries()` wires the back-link: the capability gets
`skills: [{ id, label }]` pointing at the materialized skill entry. The skill is a
read-as-context entry — **discoverable but not invocable** (the bridge denies an
invoke of a `kind:"skill"` entry with `transport_error`). This is exactly the
Obsidian `vault.read` ↔ `vault.how-to-cite` pairing.

---

## 7. Secret / credential handling (`secretRef`)

Normative: [`ExtensionSecretRef`](../../src/protocol/types.ts) §1b +
`PlatformServices.resolveSecret` §6 + ADR-009(c).

An extension **never carries secret values**. It declares a *reference*:

```json
"secrets": [ { "name": "obsidian-rest-api-key", "attach": "bearer" } ]
```

| `ExtensionSecretRef` field | Meaning |
|---|---|
| `name` | Logical secret name. The value lives under `~/.plexus/secrets/` (OS keychain where available) and is resolved at dispatch by `PlatformServices.resolveSecret(name)`. |
| `attach` | How the owning transport presents it: `bearer` / `header` / `query` / `env`. |
| `as` | Header/query/env key name when `attach` is `header`/`query`/`env`. |

**Contract (hard guarantee):** the secret value NEVER appears in the manifest,
the `.well-known` doc, the handshake manifest snapshot, or any audit `detail`
(audit redaction is a contract — `AuditRedactionPolicy`). It is handed ONLY to the
owning transport at dispatch time, referenced by `name` from
`route.secret`/`LocalServiceLocation.secretRef`. An author who needs a credential
declares the reference + the attach mode; the user provisions the value out of
band into `~/.plexus/secrets/`. Provisioning the value is a **management-client /
operator action**, NOT part of the manifest.

---

## 8. Validation rules — what makes a manifest valid/invalid

The gateway enforces these (some at register, some at invoke). An authoring tool
(the M4 meta-skill) SHOULD pre-validate all of them.

**Reject at register (`registerExtension` / `POST /extensions`):**
1. `manifest !== "plexus-extension/0.1"` → reject (the live guard:
   `"invalid extension manifest …"`).
2. Missing/empty `source` → reject.
3. (Author-tool MUST also catch, gateway treats as "contributed no entries":)
   empty `capabilities[]` → the response is `ok:false` with reason
   *"extension materialized but contributed no entries."*

**Structural validity (author-tool / spec-level — MUST hold for a well-formed
manifest):**
4. Every `capabilities[].name` is a unique, non-empty `<noun>.<verb>` slug within
   the manifest (ids must be unique; duplicate names collide on the same id).
5. `transport` (manifest + per-decl) ∈ `{local-rest, stdio, ipc, cli, skill,
   workflow}` — **never `mcp`** (the type `Exclude`s it).
6. `kind:"skill"` ⇒ has `body`, `grants:[]`, `transport:"skill"`, no `io`/`members`.
7. `kind:"workflow"` ⇒ has `members[]`; every `members[].id` resolves to a
   **present** registry entry at register time; every `members[].verbs` ⊆ that
   member entry's required `grants` (ADR-012). A workflow with a dangling member id
   has no transitive-grant target — invalid.
8. `kind:"capability"` ⇒ `grants` is the minimum verb set; `io.input` (if present)
   is valid JSON Schema Draft 2020-12.
9. Any `route.secret` / `attach`-bearing `ExtensionSecretRef` names a secret listed
   in the manifest's `secrets[]`.
10. `route.attachSkills[]` entries name `kind:"skill"` declarations present in the
    same manifest.

**Cross-source collision (gateway, at refresh):** if a contributed id collides with
an id already claimed by another source, the **first source to claim it wins** and
the duplicate is skipped (the ID-DERIVATION RULE makes a cross-source collision a
source-naming bug — choose a distinct `source`).

**Enforced at invoke (not register):** `io.input` schema validation
(`schema_validation_failed`), grant/verb scope-check (`grant_required`), session
liveness + jti revocation. An author cannot bypass these.

---

## 9. The registration flow

### 9.1 Transport-backed — `POST /extensions`

Normative: [`ExtensionRegisterRequest`/`Response`](../../src/protocol/types.ts) §1b,
[`handlers.extensions`](../../src/core/handlers.ts).

```
POST /extensions
{ "sessionId": "sess_…", "manifest": { … ExtensionManifest … } }
```

- Requires an **active handshake session** (`sessionId` must be live — registration
  is a user-authorized action). The Host/Origin guard runs first (ADR-016).
- The gateway emits a `source.install` audit event, calls
  `capabilities.registerExtension(manifest)`, then publishes a `manifest_changed`
  event so connected agents re-fetch (`GET /manifest`).
- Response:

```json
{ "ok": true, "source": "obsidian", "registered": ["obsidian.vault.read"],
  "revision": 7 }
```

`registered` lists the ids that actually entered the registry. `ok:false` +
`reason` on a rejected/empty manifest. **No in-process handler can be supplied over
this wire** — the HTTP path calls `registerExtension(manifest)` with the manifest
only.

### 9.2 In-process — `registerExtension(manifest, { handlers })`

Gateway-owned code (first-party sources, gateway bundles) calls the registry
directly and may bind in-process `ExtensionHandler`s by declaration `name`. The
handler is baked onto `entry.extras.route.handler` (a field core never reads) and
the `ExtensionBridge` runs it directly instead of dispatching over a wire. This is
the Obsidian vault-read and cc-master board-op pattern. **Reserved for
gateway-tested, bespoke-enforced capabilities** — it is not an external authoring
channel.

### 9.3 What registration does (both channels)

`registerExtension` (capability-registry): materializes the manifest into a
`SourceModule`, **overlays** it on the shared `SourceRegistry` (so the invoke
pipeline can resolve its bridge), starts the lifecycle source, re-scans (its entries
enter the registry), bumps the monotonic `revision`, and emits the change to
`/events` subscribers. **Additive and reversible** — no compile-time `MODULES`
edit, no core branching.

---

## 10. Lifecycle

| Phase | Mechanism |
|---|---|
| **register** | `POST /extensions` or `registerExtension()` — materialize + scan + revision bump + `manifest_changed`. |
| **refresh** | `CapabilityRegistry.refresh()` re-scans all sources (including extensions); diffs the entry set; bumps revision only on change. A source's `onEntriesChanged` triggers a refresh. |
| **list_changed** | A revision bump fires a `ManifestChangedEvent` over `GET /events` (SSE). Agents compare `Manifest.revision` and re-pull `GET /manifest`. |
| **re-register** | Registering the same `source` again replaces the module (the stale lifecycle source is dropped, the new module re-scanned). Idempotent-friendly. |
| **availability** | `ExtensionSource.checkRequirements()` reports reachability (a `local-rest` extension can report its service offline → `source_status` event / availability badge). |
| **unregister** | *Not in the v0.1 wire.* Today an extension persists for the gateway process lifetime; the gateway restart drops runtime-registered extensions. A first-class `DELETE /extensions/:source` is a **proposed additive v0.2 change** (see M4-PLAN). |

---

## 11. Security boundaries — what an extension can and cannot do

A registered extension is **contained by the same gateway pipeline as every other
source**. It gains NO privileged path.

**A (transport-backed) extension CAN:**
- Contribute discoverable entries (capability/skill/workflow).
- Be reached over `local-rest`/`cli`/`stdio`/`ipc` against local services/binaries.
- Declare verbs it requires and secret references it needs.
- Compose existing entries into a workflow (transitive grants enforced).

**An extension CANNOT (this is how a malicious manifest is contained):**
- **Run arbitrary in-process code in the gateway.** The HTTP path materializes a
  manifest only; you cannot upload a `handler` function. In-process handlers are a
  gateway-owned, compile-time-bound capability.
- **Bypass grants.** Every entry is default-deny; an invoke without a covering
  scoped-token is denied `grant_required`. Declaring `grants:["read"]` does not
  let the entry write — the verb set is what the user sees and grants.
- **Escalate via a workflow.** A workflow's members run under a *synthesized
  transitive scope* derived from `members[]`, surfaced to the user at grant-confirm
  time, and scope-checked through the same pipeline per member (ADR-012/013). No
  silent escalation; a mid-fan-out revoke halts remaining members.
- **Read secret values from the manifest surface.** Secrets are references resolved
  only into the owning transport at dispatch; values never enter the manifest,
  `.well-known`, the manifest snapshot, or audit.
- **Forge identity or be reached cross-host.** Host/Origin validation (ADR-016)
  runs before auth on every endpoint; loopback-only bind.
- **Escape instance confinement** where the transport/handler enforces it (the
  Obsidian path-confinement denies `..`/absolute/symlink escapes with
  `transport_error`). Instance-level confinement is the transport's job — author
  it deliberately.
- **Evade audit.** Every invoke (and every pre-dispatch denial) is audited with
  redaction-safe detail.

**Residual trust the user grants by registering a transport-backed extension:** the
extension can cause the gateway to make local HTTP calls / spawn the binaries it
names, under the verbs the user granted. The user's defense is the grant prompt
(verbs are visible), the audit log, and the ability to revoke. An extension that
names a `cli` binary the user does not trust should not be granted `execute`.

---

## 12. Worked manifest examples

### 12.1 `local-rest`, read-only, with a secret + attached skill (Obsidian)

```json
{
  "manifest": "plexus-extension/0.1",
  "source": "obsidian",
  "label": "Obsidian (Local REST API)",
  "transport": "local-rest",
  "secrets": [ { "name": "obsidian-rest-api-key", "attach": "bearer" } ],
  "serviceHint": { "app": "obsidian", "defaultPort": 27123 },
  "capabilities": [
    {
      "name": "vault.read",
      "kind": "capability",
      "label": "Read Obsidian notes",
      "describe": "Read Markdown from a local Obsidian vault by path or full-text search, so the agent can cite the user's personal knowledge base. Use when the task references the user's notes or prior decisions. Read-only: never mutates the vault.",
      "io": {
        "input": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "Full-text query." },
            "path": { "type": "string", "description": "Vault-relative note path." }
          },
          "anyOf": [ { "required": ["query"] }, { "required": ["path"] } ]
        }
      },
      "grants": ["read"],
      "transport": "local-rest",
      "route": { "method": "GET", "pathTemplate": "/search/simple", "secret": "obsidian-rest-api-key", "attachSkills": ["vault.how-to-cite"] }
    },
    {
      "name": "vault.how-to-cite",
      "kind": "skill",
      "label": "How to cite an Obsidian vault",
      "describe": "Usage guidance for obsidian.vault.read: read by vault-relative path, cite by relative path, read-only + path-confined.",
      "grants": [],
      "transport": "skill",
      "body": { "format": "markdown", "markdown": "# How to cite an Obsidian vault\nRead notes by their vault-relative path; cite by relative path; read-only." }
    }
  ]
}
```

### 12.2 `cli`, write-capable binary (a local formatter)

```json
{
  "manifest": "plexus-extension/0.1",
  "source": "prettier",
  "label": "Prettier (local code formatter)",
  "transport": "cli",
  "capabilities": [
    {
      "name": "code.format",
      "kind": "capability",
      "label": "Format a file with Prettier",
      "describe": "Format a source file in place using the local `prettier` binary. Use when the agent has written or edited a file and wants it formatted to the project's style. Mutates the file on disk ⇒ requires write.",
      "io": {
        "input": {
          "type": "object",
          "properties": { "path": { "type": "string", "description": "Absolute path of the file to format." } },
          "required": ["path"]
        }
      },
      "grants": ["write"],
      "transport": "cli",
      "route": { "bin": "prettier", "args": ["--write", "{path}"] }
    }
  ]
}
```

### 12.3 `workflow`, composing two existing capabilities

> Members MUST already be present registry entries (here, two capabilities the same
> manifest also declares, or pre-existing ids from another source).

```json
{
  "manifest": "plexus-extension/0.1",
  "source": "notes",
  "label": "Notes helpers",
  "transport": "cli",
  "capabilities": [
    {
      "name": "vault.read", "kind": "capability", "label": "Read a note",
      "describe": "Read a note by path. Read-only.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
      "grants": ["read"], "transport": "cli", "route": { "bin": "notescli", "args": ["read", "{path}"] }
    },
    {
      "name": "vault.append", "kind": "capability", "label": "Append to a note",
      "describe": "Append text to a note. Mutates the note ⇒ write.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" }, "text": { "type": "string" } }, "required": ["path", "text"] } },
      "grants": ["write"], "transport": "cli", "route": { "bin": "notescli", "args": ["append", "{path}", "{text}"] }
    },
    {
      "name": "daily.log", "kind": "workflow", "label": "Read then append to today's daily note",
      "describe": "Read today's daily note and append a timestamped line. Use to journal an event. Composes a read then a write ⇒ granting this implies its members' read+write.",
      "grants": ["write"], "transport": "workflow",
      "members": [
        { "id": "notes.vault.read", "verbs": ["read"] },
        { "id": "notes.vault.append", "verbs": ["write"] }
      ]
    }
  ]
}
```

Granting `notes.daily.log` (write) synthesizes the transitive member scopes
`notes.vault.read`/read + `notes.vault.append`/write, surfaced to the user at
grant-confirm time and stamped into the token (`synthesizedFor`); the
`WorkflowTransport` fans out through the uniform invoke pipeline (§9, ADR-013).

---

## 13. Conformance checklist (for an authoring tool)

A manifest is **spec-compliant** iff: `manifest === "plexus-extension/0.1"`;
`source` + `label` present; `transport` ≠ `mcp`; ≥1 capability; every decl has
`name`/`kind`/`label`/`describe`/`grants`; skill decls carry `body` + `grants:[]`;
workflow decls carry `members[]` whose ids resolve present and whose `verbs` ⊆ the
member's grants; every `route.secret` names a declared secret; every
`route.attachSkills[]` names a declared skill; `io.input` (if present) is valid
JSON Schema 2020-12. See §8 for the full rule set the gateway enforces.
