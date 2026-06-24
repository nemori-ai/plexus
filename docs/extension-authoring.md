# Authoring a Plexus extension (agent guide)

You are authoring an **extension** for a local Plexus instance. An extension is a
runtime-registered **connector**: a manifest that declares a `source` and the capability
entries it contributes. Installing it makes those capabilities *discoverable* — it does
NOT grant access. A human still approves every install and issues every grant.

This is the concise contract you (the authoring agent) follow. The full spec is
[`docs/extensions/EXTENSION-SPEC.md`](./extensions/EXTENSION-SPEC.md).

## 1. Manifest shape

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
  "baseUrl": "http://127.0.0.1:27123",  // MUST be loopback (127.0.0.1 / localhost)
  "allowedHosts": ["127.0.0.1:27123"],  // host allow-list (part of the approval surface)
  "method": "PUT",
  "path": "/vault/{path}",
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
surface minimal — request only the bins/hosts/verbs you truly need.

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
        "path": "/vault/{path}",
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
        "path": "/vault/{path}",
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

## 7. Conformance checklist

- [ ] `manifest` is `"plexus-extension/0.1"`; `source` is a non-reserved id.
- [ ] every cap has `name` (`<noun>.<verb>`), `kind`, `label`, a specific `describe`, `grants`, `transport`.
- [ ] cli caps: bare `bin` + `args` + `allowedBins`. local-rest caps: loopback `baseUrl` + `allowedHosts` + secret ref.
- [ ] secrets referenced by NAME only (no values in the manifest).
- [ ] workflows reference present member ids; cross-source attach only if explicitly intended.
- [ ] previewed (`valid:true`) before install; minimal cli-bins / rest-hosts / verbs surface.
