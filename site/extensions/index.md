---
title: Authoring an extension
description: The concise, agent-facing contract for authoring a Plexus extension — a runtime-registered connector that declares a source and the capability entries it contributes.
---

# Authoring a Plexus extension

You are authoring an **extension** for a local Plexus instance. An extension is a
runtime-registered **connector**: a manifest that declares a `source` and the capability
entries it contributes. Installing it makes those capabilities *discoverable* — it does
NOT grant access. A human still approves every install and issues every grant.

This page is the contract the authoring agent follows. The full spec is
[the extension spec](/extensions/spec).

## 1. Manifest shape

![An extension manifest declares capabilities; the gateway materializes them into a source and projects each onto the .well-known floor](/diagrams/extension-manifest.png)



```jsonc
{
  "manifest": "plexus-extension/0.1",
  "source": "my-tool",            // SourceId; seeds every entry id (<source>.<name>)
  "label": "My tool",
  "transport": "local-rest",      // default transport for caps that don't override
  "capabilities": [ /* ExtensionCapabilityDecl[] */ ],
  "secrets": [ /* ExtensionSecretRef[]  (optional) */ ],
  "serviceHint": { /* how to locate a local service (optional) */ }
}
```

Each `ExtensionCapabilityDecl`:

```jsonc
{
  "name": "vault.write",          // <noun>.<verb>; full id = <source>.<name>
  "kind": "capability",           // capability | skill | workflow
  "label": "Write a vault note",
  "describe": "Write/overwrite a note at {path}. Use when the user asks to save…",
  "io": { "input": { "type": "object", "properties": { "path": {"type":"string"} } } },
  "grants": ["write"],            // verbs this cap requires: read | write | execute
  "transport": "local-rest",      // cli | local-rest | skill | workflow | stdio | ipc (no mcp)
  "route": { /* transport routing — see §3 */ }
}
```

A good `describe` is the agent-relevance signal — say WHAT it does, WHEN to use it, and
name the inputs. Be specific; vague describes make the capability undiscoverable.

::: warning The id is `<source>.<name>` — do NOT repeat the source in `name`
The full capability id is built by prefixing `source` automatically. For
`source: "user-profile"`, `name: "read"` yields the id `user-profile.read`, while
`name: "user-profile.read"` yields the doubled `user-profile.user-profile.read` —
and it still validates, so the mistake is silent. Pick `name` as the *unprefixed* part:
`<noun>.<verb>` when the source groups several nouns (`vault.read`, `vault.write`), or a
bare `<verb>` for a single-purpose source (`read`).
:::

## 2. EntryKinds

- **capability** — a callable backed by a transport (`cli` / `local-rest` / `ipc` / `stdio`).
- **skill** — pure markdown usage guidance, no transport. `body: { format:"markdown", markdown }`.
- **workflow** — composes existing entries via `members[]` (each must resolve once registered).

## 3. Per-transport `route` requirements

`route` is read ONLY by the owning transport, never by core. Per transport:

### cli (the #2 RCE surface)
```jsonc
"route": {
  "bin": "ls",                    // bare binary name — NO path, NO shell metacharacters
  "args": ["{dir}"],              // argv template; {placeholders} fill from io.input
  "allowedBins": ["ls"]           // user-confirmed allow-list (part of the approval surface)
}
```

### local-rest (the #3 SSRF / secret-redirect surface)
```jsonc
"route": {
  "baseUrl": "http://127.0.0.1:27123",  // loopback by default; a non-loopback host is opt-in and
                                        // requires an explicit, user-confirmed `allowedHosts` entry
                                        // (the approval surface) — see `transport-policy.ts`
  "allowedHosts": ["127.0.0.1:27123"],  // host allow-list (part of the approval surface)
  "method": "PUT",
  "pathTemplate": "/vault/{path}",      // canonical URL path key (`path` is a legacy alias)
  "secret": { "name": "vault-key", "attach": "bearer" }  // references secrets[] by name
}
```
The secret VALUE never appears in the manifest — it lives under `~/.plexus/secrets/<name>`
and the transport attaches it at dispatch.

### skill / workflow
- skill: no `route`; supply `body`.
- workflow: no `route`; supply `members[]` referencing present entry ids. Cross-source
  attach (a skill/workflow reaching into a *different* source) is OFF by default — it is a
  prompt-injection channel and must be explicitly gated + human-confirmed.

## 4. Security surface (what the human approves)

When you install, the human sees exactly: the **cli bins** the extension may spawn, the
**non-loopback rest hosts** it may reach, any **cross-source** skill attaches, the
**verbs** each capability requires, and whether it is **transport-backed**. Keep the
surface minimal — request only the bins/hosts/verbs you actually need.

## 5. Install flow

1. **Fetch this guide**: `GET /admin/api/extensions/authoring-guide`.
2. **Draft** the manifest as JSON.
3. **Preview (no commit)**: `POST /admin/api/extensions/preview` with `{ manifest }`. Read
   `valid` / `reasons[]`; if `valid:false`, fix the manifest and re-preview. Show the human
   the returned `surface` (cli bins / rest hosts / cross-source / verbs).
4. **Install (human approves)**: `POST /admin/api/extensions` with `{ manifest }`. The local
   user is the connection-key holder = the human approver, so this commits directly and
   audits `source.install`. Response: `{ ok, source, registered, revision, reason? }`.
5. **Remove**: `DELETE /admin/api/extensions/:source`.

::: tip Installed extensions persist across a gateway restart
An admin-installed extension is persisted to `~/.plexus/extensions.json` and **replayed
on boot**, so its capabilities come back after a restart without a re-install.
`DELETE`/remove drops it from that durable store too.
:::

CLI equivalents: `plexus extension preview|add|list|remove`.

## 6. Worked example — a local-rest "vault write" extension

```jsonc
{
  "manifest": "plexus-extension/0.1",
  "source": "my-vault",
  "label": "My local vault",
  "transport": "local-rest",
  "secrets": [{ "name": "my-vault-key", "attach": "bearer" }],
  "capabilities": [
    {
      "name": "notes.read",
      "kind": "capability",
      "label": "Read a note",
      "describe": "Read the markdown of a note at {path}. Use to fetch existing note content.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
      "grants": ["read"],
      "transport": "local-rest",
      "route": {
        "baseUrl": "http://127.0.0.1:27123",
        "allowedHosts": ["127.0.0.1:27123"],
        "method": "GET",
        "pathTemplate": "/vault/{path}",
        "secret": { "name": "my-vault-key", "attach": "bearer" }
      }
    },
    {
      "name": "notes.write",
      "kind": "capability",
      "label": "Write a note",
      "describe": "Create or overwrite the note at {path} with {content}. Use when saving content the user dictated.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] } },
      "grants": ["write"],
      "transport": "local-rest",
      "route": {
        "baseUrl": "http://127.0.0.1:27123",
        "allowedHosts": ["127.0.0.1:27123"],
        "method": "PUT",
        "pathTemplate": "/vault/{path}",
        "body": "{content}",
        "secret": { "name": "my-vault-key", "attach": "bearer" }
      }
    },
    {
      "name": "notes.howto",
      "kind": "skill",
      "label": "How to use my-vault",
      "describe": "Usage guidance for my-vault.notes.read / notes.write.",
      "grants": [],
      "transport": "skill",
      "body": { "format": "markdown", "markdown": "# my-vault\nRead with `notes.read { path }`; write with `notes.write { path, content }`. Paths are relative to the vault root." }
    }
  ]
}
```

This extension is **transport-backed** (local-rest) and **write-capable**, so its
approval surface lists `restHosts: ["127.0.0.1:27123"]` and the `write` verb on
`my-vault.notes.write` — exactly what the human signs off on.

## 7. Best practices & self-check

A manifest that *validates* is not yet a **good citizen**. These practices make your
extension trustworthy to the humans who approve it and useful to the agents who
discover it.

### 7a. Implement the health check

A source SHOULD implement the per-source **health protocol** so the live availability of
its capabilities is surfaced — both in the admin dashboard and to agents that discover it:

```ts
health(): Promise<{ status: "ok" | "degraded" | "unavailable" | "unknown", detail?: string }>
```

- `ok` — reachable and serving. `degraded` — up but impaired. `unavailable` — down/unreachable.
- It is **optional**: a no-op is allowed and just reports `unknown`. But implementing it
  lets agents route around an unavailable source instead of failing an invoke blind.
- If `health()` is **absent**, status is *derived* from `checkRequirements()` (e.g. missing
  binary / unreachable host) — and if that says nothing, it falls back to `"unknown"`.

Health is reconciled with the `source_unavailable` invoke error (§7b): a source that reports
`unavailable` should also fail invokes with `source_unavailable`, so discovery and dispatch agree.

### 7b. Return precise, semantic errors

When a capability fails, feed the calling agent a **standard Plexus error code** plus a clear,
human-readable `message`/`detail` — never an opaque 500 or a vague string. A precise error lets
the agent recover (retry, pick another source) or tell the user exactly what's wrong.

Use the standard codes: `source_unavailable`, `transport_error`, `schema_validation_failed`,
`grant_required` (and the others in [the spec](/extensions/spec)).

```jsonc
// BAD — opaque, unactionable:
{ "error": "failed" }

// GOOD — semantic code + a message the agent (or user) can act on:
{ "code": "source_unavailable",
  "message": "Obsidian REST API not reachable at 127.0.0.1:27124 — is the plugin running?" }
```

### 7c. Self-check checklist (run before installing)

Before you `POST /admin/api/extensions`, tick each of these off:

- [ ] **Manifest validates** — run `plexus extension preview <manifest.json>` and confirm
  `valid:true`. Review the printed **security surface** (declared cli bins / rest hosts).
- [ ] **Transports are reachable & host-confined** — loopback (`127.0.0.1`/`localhost`) is allowed
  by default; a non-loopback host is opt-in and requires an explicit, user-confirmed `allowedHosts`
  entry (the approval surface) — see `transport-policy.ts`. The local service is actually up.
- [ ] **Secrets referenced by name only** — no secret values anywhere in the manifest.
- [ ] **Capabilities are honest** — each has a specific `describe` (what/when/inputs) and an
  accurate `io` schema; you're not over-claiming what a cap does.
- [ ] **Health implemented** (or deliberately skipped) — skipping `health()` is fine, but
  make it a choice, not an oversight (§7a).
- [ ] **Errors are semantic** — failures return a standard code + readable message, not a 500
  or `{error:"failed"}` (§7b).

## 8. Conformance checklist

- [ ] `manifest` is `"plexus-extension/0.1"`; `source` is a non-reserved id.
- [ ] every cap has `name` (`<noun>.<verb>`), `kind`, `label`, a specific `describe`, `grants`, `transport`.
- [ ] cli caps: bare `bin` + `args` + `allowedBins`. local-rest caps: loopback `baseUrl` + `allowedHosts` + secret ref.
- [ ] secrets referenced by NAME only (no values in the manifest).
- [ ] workflows reference present member ids; cross-source attach only if explicitly intended.
- [ ] previewed (`valid:true`) before install; minimal cli-bins / rest-hosts / verbs surface.
