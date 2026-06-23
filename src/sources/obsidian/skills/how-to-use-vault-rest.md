---
name: how-to-use-vault-rest
description: How to read, write, and cite notes in an Obsidian vault opened READ-WRITE through Plexus's Obsidian Local REST API integration. Use when you have been granted obsidian-rest.vault.read / .vault.write / .vault.list and need to read, create, update, or reference the user's notes.
---

# How to use an Obsidian vault over the Local REST API (read-write)

This extension talks to the user's running Obsidian app through its **Local REST
API** community plugin (HTTPS on loopback, Bearer-authenticated). Plexus holds the
API key as a secret reference and attaches it for you — you never see or send it.

Three capabilities are exposed:

| Capability | Verb | What it does |
|---|---|---|
| `obsidian-rest.vault.list`  | `read`  | List the vault's notes/folders (`GET /vault/`). |
| `obsidian-rest.vault.read`  | `read`  | Read one note's markdown (`GET /vault/{path}`). |
| `obsidian-rest.vault.write` | `write` | Create or overwrite a note (`PUT /vault/{path}`). |

## Reading

List first, then read what you need:

```json
// obsidian-rest.vault.list  →  the vault index
{}
```

```json
// obsidian-rest.vault.read
{ "path": "Daily/2026-06-23.md" }
```

`path` is **relative to the vault root**. `read` returns the note's markdown
content; `list` returns the files/folders the REST API reports.

## Writing

`obsidian-rest.vault.write` does a `PUT /vault/{path}` whose **body is the raw
markdown** of the whole note. It CREATES the note if absent and OVERWRITES it if
present (there is no partial/append — send the full intended contents):

```json
// obsidian-rest.vault.write
{ "path": "Inbox/From Plexus.md", "content": "# From Plexus\n\nNote body…\n" }
```

- `path` — vault-relative target, e.g. `Inbox/From Plexus.md`.
- `content` — the **entire** markdown body to store at that path.

Because `write` is a mutating grant, granting it **requires a human confirmation**
(it pends under the user-confirm authorizer) — it is never auto-granted to an agent.

## Citing well

- Cite a note by its **vault-relative path** (e.g. `Projects/Plexus.md`).
- Before overwriting a note, **read it first** so you preserve content the user
  wants to keep — `write` replaces the whole note.
- Quote sparingly and attribute: *"per the note `Projects/Plexus.md`…"*.

## Security notes

- Plexus only ever reaches the Obsidian REST API on **loopback** (127.0.0.1); the
  API key is attached only to that loopback host and never leaves the machine.
- The self-signed HTTPS certificate the plugin uses is accepted only because the
  destination is loopback.
