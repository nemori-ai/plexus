---
name: create-extension
description: >
  Scaffold a spec-compliant Plexus extension that exposes a local app, CLI,
  script, or HTTP service to AI agents. Use when the user wants to connect a
  local capability to Plexus, "make my agent able to use <local app>", wrap a
  CLI/script/localhost service as a capability, or author/register a Plexus
  extension. Walks transport + access-granularity choices, generates a
  spec-compliant ExtensionManifest + a bundled usage skill, validates it against
  the conformance checklist, and registers it via the running gateway (which
  PENDS for the user to approve).
argument-hint: "[what to expose, e.g. 'my Linear CLI']"
allowed-tools: Read Write Edit Bash WebFetch
---

# Scaffold a Plexus extension

You scaffold a **spec-compliant Plexus extension** — a manifest + a bundled usage
skill + a register helper — from a short interview, then validate and register it.
You eat your own dog food: what you emit is exactly what `EXTENSION-SPEC.md`
documents, and it must PASS the gateway's `validateRegistration`.

**Anchor to the docs, not memory.** Before generating, read the authoritative
contract (the manifest schema §2, validation §8, secure defaults, the worked
examples §12):
- `docs/extensions/EXTENSION-SPEC.md`

The generator + validator live in this plugin at `lib/generate.ts` (the rules) and
`lib/cli.ts` (the entrypoint). Drive them with Bash — never hand-write the JSON.

## Secure defaults (NON-NEGOTIABLE)

The generator enforces these by construction; you must not work around them:
- **Read-only, minimal verbs.** Default `grants:["read"]`. Only declare `write`
  /`execute` when the action genuinely mutates / runs a process. The user sees the
  verbs at the grant prompt — over-declaring erodes trust.
- **Slug-validate the source name.** Lower-kebab/dot SourceId only.
- **Never scaffold an absolute or shell cli bin.** Bare, non-shell command names
  only (`prettier`, `git`). The gateway transport HARD-DENIES `/bin/sh`,
  `bash -c …`, paths, and shell metacharacters — the generator refuses them too.
- **Loopback-only local-rest.** A non-loopback full URL is refused (SSRF / secret
  redirect floor).
- **Secret REFERENCES only.** Declare `{ name, attach }`; never embed a value.
  Provisioning the value into `~/.plexus/secrets/` is an out-of-band user action.
- **Never embed a live token / connection-key** in the generated `register.sh`.

## The interview

Walk these steps, accepting-through defaults where the user just hits enter.

### Step 0 — Locate the gateway + load the spec
- Probe `GET http://127.0.0.1:<port>/.well-known/plexus` (default port 7077; read
  from `~/.plexus/` config or ask). If down, say so — you can still scaffold and
  register later.
- Read `EXTENSION-SPEC.md` so the manifest is anchored to the contract.

### Step 1 — Describe the capability
Ask: *"What local capability do you want your agent to use — the app/CLI/service,
and what action(s) it should expose?"* For each action gather: a human label, the
agent-facing **outcome** ("Action outcome. Use when X." — lead with what the agent
gets, end the first sentence with a period: it becomes the `.well-known` teaser),
and the **call shape** (input fields). Derive the `source` id and per-action
`<noun>.<verb>` name; confirm both (ids are stable).

### Step 2 — Choose transport
Run the spec's decision rule:
- Already a localhost HTTP API? → `local-rest` (ask port/path; probe with `curl`).
- A binary you run with argv? → `cli` (resolve with `which <bin>`; record a BARE
  bin + an `args` template with `{field}` placeholders).
- A persistent protocol process? → `stdio`. An OS socket/AppleScript? → `ipc`.
- Pure usage knowledge, no callable action? → a `skill`-only extension.
- **Never offer `mcp`** (ingestion, not authoring) and **never** an in-process
  `handler` (gateway-owned only).
Write a good agent-facing `describe` per the §3 checklist (outcome → when → call
shape → boundary).

### Step 3 — Choose access granularity (verbs)
Per action, default to the MINIMUM verb set:
- only reads/queries → `["read"]` (the default).
- changes app data/files → `["write"]`.
- launches a process / side-effecting run → `["execute"]`.
Surface the consequence: these verbs appear at the grant prompt. Refuse to
over-declare. Instance confinement (a vault, a project) is enforced in `io.input` +
the transport — NOT a verb.

### Step 4 — Secrets (only if auth is needed)
Declare an `ExtensionSecretRef` (`{ name, attach, as? }`) + `route.secret`. Never
the value. Write the provisioning instructions into `secrets.README.md`.

### Step 5 — I/O schema
Generate `io.input` (JSON Schema 2020-12) from the call shape; mark `required`
fields; add `description`s.

### Step 6 — Bundled usage skill (default ON)
The generator scaffolds a `kind:"skill"` entry per action (`<name>.how-to-use`,
`grants:[]`, `transport:"skill"`) and back-links it via `route.attachSkills`. The
usage layer is Plexus's reason to exist over raw MCP. Edit the generated markdown to
add the discovery-first workflow, gotchas, and the "what you CANNOT do" boundary.

### Step 7 — Workflow (optional)
To compose declared/pre-existing capabilities into one higher-level action, add a
`kind:"workflow"` decl with `members[]` (ids + `verbs ⊆ member grants`). Every
member id must resolve to a present entry. The validator checks same-manifest
resolution + verb-subset + anti-cycle.

### Step 8 — Generate the files
Write the interview answers to a `CapabilitySpec` JSON (see
`templates/spec.example.json`), then run:

```
bun /path/to/plugins/plexus-ext/lib/cli.ts generate <spec.json> [outDir]
```

It writes `plexus-extensions/<source>/{manifest.json, skills/*.md, register.sh,
README.md, secrets.README.md}` and REFUSES to write if validation fails. Show the
user the `manifest.json` + the usage-skill markdown for review/edit.

### Step 9 — Validate
The generate step validates already; re-run on any hand-edit:

```
bun /path/to/plugins/plexus-ext/lib/cli.ts validate <manifest.json>
```

PASS means it satisfies the §13 conformance checklist and will pass the gateway's
`validateRegistration`. **Do not register a manifest that does not PASS.** Surface
every error verbatim.

### Step 10 — Register
Obtain a live handshake `sessionId` (the user pastes a connection-key from the
management client; you `POST /link/handshake`, reuse the session). Then:

```
PLEXUS_SESSION=<sessionId> ./plexus-extensions/<source>/register.sh
```

`POST /extensions` **PENDS for a human to approve** in the management client (via the
UserConfirmAuthorizer). Surface to the user that **cli bins and non-loopback rest
hosts require explicit approval** there. On approval, the new capability is live in
`.well-known` / the handshake manifest at the grant cost (verbs) shown. On
`ok:false`, surface `reason` and loop back to Step 9. If the gateway is down, the
`register.sh` is already written for later.

## Honest failure + idempotent re-runs
Never claim a success you didn't get. A validation/register failure surfaces the
exact rule / `reason` and loops. Re-running on an existing
`plexus-extensions/<source>/` offers to edit-and-re-register (re-register replaces
the module).
