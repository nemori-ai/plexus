---
name: how-to-use-vault-rest
description: How to read, search, write, append to, and cite notes in an Obsidian vault opened READ-WRITE through Plexus's Obsidian Local REST API integration. Use when you have been granted obsidian-rest.vault.read / .vault.list / .vault.search / .vault.write / .vault.append and need to find, read, create, update, or reference the user's notes.
---

# How to use an Obsidian vault over the Local REST API (read-write)

This extension talks to the user's running Obsidian app through its **Local REST
API** community plugin (HTTPS on loopback, Bearer-authenticated). Plexus holds the
API key as a secret reference and attaches it for you — you never see or send it.

Five capabilities are exposed:

| Capability | Verb | What it does |
|---|---|---|
| `obsidian-rest.vault.list`   | `read`  | List the vault's notes/folders (`GET /vault/`). |
| `obsidian-rest.vault.read`   | `read`  | Read one note's markdown (`GET /vault/{path}`). |
| `obsidian-rest.vault.search` | `read`  | Text-search the vault (`POST /search/simple/`). |
| `obsidian-rest.vault.write`  | `write` | Create or **overwrite** a note (`PUT /vault/{path}`). |
| `obsidian-rest.vault.append` | `write` | **Append** to a note's end (`POST /vault/{path}`). |

## Finding & reading

Search (or list) first, then read what you need:

```json
// obsidian-rest.vault.search  →  which notes mention a topic
{ "query": "plexus roadmap", "contextLength": 100 }
```

```json
// obsidian-rest.vault.list  →  the vault index
{}
```

```json
// obsidian-rest.vault.read
{ "path": "Daily/2026-06-23.md" }
```

- `search` returns an array of `{ filename, score, matches: [{ context, match:
  { start, end } }] }` — the matching note's path, a relevance score, and the
  matched text in context (`contextLength` chars around each match, default 100).
  Use it to locate notes before reading them.
- `path` is **relative to the vault root**. `read` returns the note's markdown
  content; `list` returns the files/folders the REST API reports.

## Writing: append vs. write

**Prefer `append` for additive edits.** `obsidian-rest.vault.append` does a
`POST /vault/{path}` whose body is the markdown to add at the **end of the
note**, leaving everything already there untouched (the note is created if it
does not exist yet). Use it for log entries, follow-ups, captured items:

```json
// obsidian-rest.vault.append
{ "path": "Inbox/Log.md", "content": "\n- 2026-07-10: captured from Plexus\n" }
```

`obsidian-rest.vault.write` does a `PUT /vault/{path}` whose **body is the raw
markdown of the whole note**. It CREATES the note if absent and **REPLACES the
entire note** if present — never use it to "add" content; anything you don't
resend is lost. Reserve `write` for creating a new note or deliberately
rewriting one, and **read the note first** so you can resend what must be kept:

```json
// obsidian-rest.vault.write
{ "path": "Inbox/From Plexus.md", "content": "# From Plexus\n\nNote body…\n" }
```

- `path` — vault-relative target, e.g. `Inbox/From Plexus.md`.
- `content` — for `append`: the markdown to add; for `write`: the **entire**
  markdown body to store at that path.

Because `write` and `append` are mutating grants, granting them **requires a
human confirmation** (they pend under the user-confirm authorizer) — they are
never auto-granted to an agent.

## Citing well

- Cite a note by its **vault-relative path** (e.g. `Projects/Plexus.md`).
- To add to a note, use `append`. Before overwriting one with `write`, **read
  it first** so you preserve content the user wants to keep — `write` replaces
  the whole note.
- Quote sparingly and attribute: *"per the note `Projects/Plexus.md`…"*.

## Security notes

- Plexus only ever reaches the Obsidian REST API on **loopback** (127.0.0.1); the
  API key is attached only to that loopback host and never leaves the machine.
- The self-signed HTTPS certificate the plugin uses is accepted only because the
  destination is loopback.
