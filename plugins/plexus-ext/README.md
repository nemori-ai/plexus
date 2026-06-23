# plexus-ext — the Plexus extension meta-skill

A Claude Code plugin that interactively scaffolds a **spec-compliant Plexus
extension**: it interviews you about a local capability, generates an
`ExtensionManifest` + a bundled usage skill + a register helper, validates against
the EXTENSION-SPEC §13 conformance checklist, and registers it via the running
gateway (`POST /extensions`, which **pends for the user to approve**).

> Plexus is a local capability gateway. "MCP = what functions I have; Plexus = how
> you should use me." This plugin authors the **transport-backed** extensions any
> external author would write — never `mcp` ingestion, never an in-process handler.

## Install

```
claude --plugin-dir /path/to/plexus/plugins/plexus-ext
```

Then invoke `/plexus-ext:create-extension` (the skill auto-triggers when you ask to
connect a local app/CLI/service to Plexus).

## Layout

```
plugins/plexus-ext/
├── .claude-plugin/plugin.json        plugin manifest
├── skills/create-extension/
│   ├── SKILL.md                      the interactive scaffolder (the meta-skill)
│   └── templates/                    manifest + usage-skill + spec templates
├── lib/
│   ├── generate.ts                   generator + pre-register validator (the rules)
│   └── cli.ts                        skill-invoked entrypoint (generate / validate)
└── examples/plexus-extensions/       real generator output (acme-notes, prettier)
```

## How a generated manifest passes `validateRegistration`

`lib/generate.ts` mirrors the published rules — it does NOT import gateway
internals. It emits a manifest that satisfies:

- the gateway's `validateManifest` (manifest literal, source, size limits, safe
  secret names),
- the §8 structural rules (`<noun>.<verb>` names, skill = `body`+`grants:[]`+
  `transport:"skill"`, workflow members present + `verbs ⊆ member.grants`,
  `route.secret`/`route.attachSkills` resolution, JSON-Schema input), and
- the `validateWorkflowGraph` anti-cycle / present-member walk.

The tests (`tests/m4-meta-*.test.ts`) prove a generated manifest passes the REAL
gateway `createCapabilityRegistry().validateRegistration`.

## Secure defaults (enforced by construction)

- **Read-only, minimal verbs** — default `grants:["read"]`.
- **Slug-validated source** — lower-kebab/dot SourceId only.
- **No absolute / shell cli bins** — the generator refuses `/bin/sh`, `bash -c …`,
  path separators, and shell metacharacters, mirroring the gateway transport's
  hard-deny floor. Safe bins are pinned in a user-confirmed `allowedBins` list.
- **Loopback-only local-rest** — a non-loopback full URL is refused (SSRF floor).
- **Secret references only** — `{ name, attach }`; values are provisioned out of
  band into `~/.plexus/secrets/`.
- **No live token / connection-key** in the generated `register.sh` (it reads a
  `sessionId` from `$PLEXUS_SESSION`).

## Use the generator directly

```
bun lib/cli.ts generate <spec.json> [outDir]   # scaffold (refuses if invalid)
bun lib/cli.ts validate <manifest.json>         # PASS/FAIL against the checklist
```

See `skills/create-extension/templates/spec.example.json` for the spec shape and
`examples/` for two real outputs.
