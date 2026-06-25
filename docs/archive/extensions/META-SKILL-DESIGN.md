# Plexus Meta-Skill Design — `plexus:create-extension`

> Status: **M4 design** · Depends on: [`EXTENSION-SPEC.md`](./EXTENSION-SPEC.md) ·
> Model: claude-plugin SKILL.md frontmatter conventions · Date: 2026-06-23
>
> The **meta-skill** is a Claude Code plugin skill that interactively walks a
> user/developer from *"I have a local app/CLI/service I want my agent to use"* to
> a **registered, validated, spec-compliant Plexus extension** — files + manifest +
> bundled usage skill — without the user hand-writing JSON. It is the "Claude Code
> scaffolds a Plexus extension for me" experience. **This doc is design only.**

---

## 1. Why a meta-skill (not a CLI wizard)

The grounding fixes the model: a Claude Code **skill is self-describing YAML
frontmatter** (`name`, `description` = the "Action outcome. Use when X." relevance
signal, `allowed-tools`, `argument-hint`) and is auto-discovered from
`skills/<name>/SKILL.md` by filesystem convention. The meta-skill *is itself an
authored skill* — it teaches Claude Code how to interview a user and emit a
spec-compliant `ExtensionManifest`. Using a skill (not a separate binary) means:
the interview runs in the agent that already has the user's context, the generated
artifacts land in the user's repo, and registration goes through the same gateway
wire (`POST /extensions`) any author would use. The meta-skill **eats its own dog
food**: what it generates is exactly what the EXTENSION-SPEC documents.

---

## 2. Packaging — the Claude Code plugin

Ships as a Plexus-owned Claude Code plugin so a user installs it the same way they
install cc-master (the install mechanics are already proven in
[`src/sources/cc-master/install.ts`](../../src/sources/cc-master/install.ts)).

```
plugins/plexus-ext/                    (the Claude Code plugin dir)
├── .claude-plugin/
│   └── plugin.json                    { name:"plexus-ext", description, version, author }
└── skills/
    └── create-extension/
        ├── SKILL.md                   ← the meta-skill (frontmatter + the interview)
        └── templates/                 ← manifest + usage-skill templates the skill fills
            ├── manifest.local-rest.json
            ├── manifest.cli.json
            ├── manifest.workflow.json
            └── usage-skill.md
```

Slash command derived from path: `skills/create-extension/SKILL.md` →
`/plexus-ext:create-extension`. Install via the cc-master-style settings.json merge
(`enabledPlugins["plexus-ext@plexus"]=true`) or `claude --plugin-dir`. The Plexus
gateway MAY ship a first-party source that auto-installs this plugin (mirroring
cc-master's `CapabilitySource.install()`), so "Plexus is running" ⇒ "the
meta-skill is available in Claude Code."

### 2.1 SKILL.md frontmatter (the self-describe)

```yaml
---
name: create-extension
description: >
  Scaffold a spec-compliant Plexus extension that exposes a local app, CLI,
  script, or HTTP service to AI agents. Use when the user wants to connect a
  local capability to Plexus, "make my agent able to use <local app>", or
  author/register a Plexus extension. Walks transport + access-granularity
  choices, generates the manifest + bundled usage skill, validates, and
  registers it via the running gateway.
argument-hint: "[what to expose, e.g. 'my Linear CLI']"
allowed-tools: Read Write Edit Bash WebFetch
---
```

`description` is the relevance signal — phrased "Action outcome. Use when X." so
Claude Code surfaces it on the right intent. `allowed-tools` is the minimum: Read
(spec + existing manifests), Write/Edit (scaffold files), Bash (probe a binary/port
+ `curl` the register endpoint), WebFetch (only if discovering an app's REST docs).

---

## 3. The interview — steps

The skill body is a structured, branching interview. Each step gathers exactly what
the spec (§2–§8) needs, with a sensible default so the user can accept-through.

### Step 0 — Locate the gateway + load the spec
- Confirm a Plexus gateway is reachable: `GET http://127.0.0.1:<port>/.well-known/plexus`
  (read the port from `~/.plexus/` config or ask). If down, instruct the user to
  start it; the scaffold can still be generated and registered later.
- Read [`EXTENSION-SPEC.md`](./EXTENSION-SPEC.md) and the worked examples so the
  generated manifest is anchored to the authoritative contract, not the model's
  memory.

### Step 1 — Describe the capability (free-text → structured)
- Prompt: *"What local capability do you want your agent to use? (the app/CLI/
  service, and what one or more actions it should expose)"*
- Extract, per action: a human label, the agent-facing **outcome** ("what does the
  agent get"), the **when-to-use**, and the **call shape** (inputs).
- Derive the `source` id (lower-kebab/dot, from the app name) and per-action
  `name` (`<noun>.<verb>`). Confirm both with the user (ids are stable — §EXTENSION-SPEC 2).

### Step 2 — Choose transport
- Run the spec's **decision rule** (§EXTENSION-SPEC 4) as a guided question:
  - "Does the app already expose a localhost HTTP API?" → `local-rest` (ask for the
    port/path; probe it with Bash `curl`).
  - "Is it a binary you run with arguments?" → `cli` (resolve it: Bash `which <bin>`;
    record `bin` + `args` template with `{field}` placeholders).
  - "A persistent protocol process?" → `stdio`. "An OS socket/AppleScript?" → `ipc`.
  - Pure knowledge, no callable action → `skill`-only extension.
- **Never offer `mcp`** (ingestion, not authoring) and **never offer in-process
  `handler`** (gateway-owned only — §EXTENSION-SPEC 9). The meta-skill produces
  **transport-backed** manifests exclusively.

### Step 3 — Choose access granularity (verbs)
- For each action, ask which verb(s) it needs, defaulting to the **minimum**:
  - "Does it only read / query?" → `["read"]` (the default-read-only path).
  - "Does it change app data / files?" → `["write"]`.
  - "Does it launch a process / side-effecting run?" → `["execute"]`.
- Surface the consequence: *"This will be granted per-verb; the user sees these
  verbs at the grant prompt."* Refuse to over-declare (default-deny discipline,
  §EXTENSION-SPEC 5). If the action confines to an instance (a vault, a project),
  note that confinement is enforced in `io.input` + the transport, **not** a verb.

### Step 4 — Secrets (only if the transport needs auth)
- If `local-rest`/the service needs a credential: declare an `ExtensionSecretRef`
  (`{ name, attach, as? }`) and `route.secret` — **never the value**. Instruct the
  user to provision the value into `~/.plexus/secrets/` out of band (the meta-skill
  writes the *reference* and the provisioning instructions, not the secret).

### Step 5 — Author the I/O schema
- For each capability, generate `io.input` (JSON Schema 2020-12) from the call shape
  gathered in Step 1; mark `required` fields; add `description`s (these help the
  agent). Optionally `io.output`.

### Step 6 — Configure the bundled usage skill
- For each capability, scaffold a `kind:"skill"` entry from `templates/usage-skill.md`:
  - `name: <noun>.how-to-use` (or `.how-to-cite` etc.), `grants:[]`,
    `transport:"skill"`, `body.markdown` = filled template.
  - Set `route.attachSkills:["<skill name>"]` on the capability (§EXTENSION-SPEC 6).
  - The template prompts the user for: the discovery-first workflow, gotchas, and
    the "what you CANNOT do" boundary (mirrors the shipped `how-to-cite-vault.md`).
- A capability with no useful usage knowledge MAY skip the bundled skill (it is
  optional), but the skill defaults to generating one — the usage layer is Plexus's
  reason to exist over raw MCP.

### Step 7 — Workflow (optional)
- If the user wants to compose multiple of the just-declared (or pre-existing)
  capabilities into one higher-level action: scaffold a `kind:"workflow"` entry with
  `members[]` (ids + `verbs ⊆ member grants`). Validate every member id resolves to
  a present entry (use the loaded `.well-known`/manifest for pre-existing ids, or the
  same-manifest decls). Hand this off to the USER-AUTHORING flow's workflow rules
  (see [`USER-AUTHORING-DESIGN.md`](./USER-AUTHORING-DESIGN.md)) — the meta-skill
  reuses, not duplicates, those validation rules.

### Step 8 — Generate the files
- Write the scaffold (see §4). Show the user the manifest and the usage-skill
  markdown for review/edit before registering.

### Step 9 — Validate
- Run the **conformance checklist** (§EXTENSION-SPEC 13) against the generated
  manifest locally (a small validator the skill carries, or inline checks): manifest
  literal, source/label, transport ≠ mcp, ≥1 capability, per-decl required fields,
  skill/workflow shape rules, secret + attachSkills references resolve, `io.input`
  parses as JSON Schema. Report PASS/FAIL with the exact failing rule. **Do not
  register an invalid manifest.**

### Step 10 — Register
- `POST /extensions { sessionId, manifest }` against the running gateway (the skill
  must hold or acquire a handshake `sessionId` — see §5). On success, echo
  `registered[]` + the new `revision`, and tell the user the capability is now live
  in `.well-known` / the handshake manifest, plus the grant cost (verbs). On
  `ok:false`, surface `reason` and loop back to Step 9.
- If the gateway is down, write a `register.sh` (the `curl POST /extensions`) into
  the scaffold so the user can register later.

---

## 4. What it generates + where files land

Generated into the **user's repo / working dir** under a predictable path so the
extension is a versionable artifact the user owns:

```
plexus-extensions/<source>/
├── manifest.json            ← the ExtensionManifest (the contract)
├── skills/
│   └── <noun>.how-to-use.md ← bundled usage-skill body (frontmatter + guidance)
├── register.sh             ← curl POST /extensions {sessionId, manifest} (idempotent)
├── secrets.README.md       ← if secrets: which names to provision into ~/.plexus/secrets/ (NO values)
└── README.md               ← what this extension exposes, the grant cost, how to re-register
```

- `manifest.json` is the single source of truth — exactly an `ExtensionManifest`.
- The usage-skill `.md` mirrors the shipped `how-to-cite-vault.md` structure
  (calling it / discovery-first workflow / citing or using well / what you CANNOT do).
- **No secret values** are ever written to disk by the skill; `secrets.README.md`
  carries only the references + provisioning steps.
- Files land in the user's cwd, **not** in `~/.plexus/` or the Plexus repo — the
  user keeps and versions their own extension (local-first authoring, mirrors
  claude-plugin's no-pointer-files-in-cwd discipline by keeping gateway state
  separate from authored artifacts).

---

## 5. How it stays spec-compliant

1. **Anchored to the doc, not memory.** Step 0 reads `EXTENSION-SPEC.md` + the
   worked example JSONs every run; the manifest is filled from the templates, which
   are kept byte-aligned with the spec's §12 examples.
2. **Transport-backed only.** It never emits `transport:"mcp"` and never emits a
   `route.handler` — the two things the wire path cannot accept. So everything it
   produces is registerable via `POST /extensions`.
3. **Validate-before-register gate.** Step 9 runs the §13 conformance checklist;
   registration (Step 10) is blocked on PASS. The gateway re-validates on register
   (`registerExtension` guards + scan), so a generated manifest that slips through is
   still caught honestly with `ok:false` — the skill surfaces that, never fakes it.
4. **Minimum-verb discipline.** Step 3 defaults to the least verbs and refuses to
   over-declare, matching default-deny/read-only (ADR-005).
5. **Secret-reference discipline.** Step 4 emits references only; the contract that
   values never enter the manifest is preserved by construction.
6. **Reuses the authoring rules, doesn't fork them.** The workflow step (7) defers
   to the validation rules in USER-AUTHORING-DESIGN so there is one set of
   workflow/skill authoring rules across the meta-skill and the user-authoring flow.

### Session handling for register
The skill needs a live handshake `sessionId` to call `POST /extensions`. Options
(decided in M4-PLAN): (a) the skill performs the `POST /link/handshake` itself using
a connection-key the user pastes (most secure, matches the standard agent flow); or
(b) a management-client-issued short-lived "authoring session" the user hands the
skill. **Default: (a) user-paste connection-key → handshake → reuse the session for
register.** No connection-key is persisted to the scaffold.

---

## 6. UX principles

- **Accept-through defaults.** Every step has a default (read-only, generate-a-usage-
  skill, minimum verbs) so a confident user can `<enter>` through and still get a
  valid, safe extension.
- **Show, then register.** Always render the manifest + usage skill for review before
  the network call. Registration is the only side-effecting step and it is explicit.
- **Honest failure.** A validation or register failure surfaces the exact rule /
  `reason` and loops; it never claims success it didn't get.
- **Idempotent re-runs.** Re-running on an existing `plexus-extensions/<source>/`
  offers to edit-and-re-register (re-register replaces the module, §EXTENSION-SPEC 10).
- **No magic privilege.** The skill cannot grant itself in-process execution or skip
  the grant model; it produces the same artifacts any external author would.
