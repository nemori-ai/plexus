---
name: how-to-cite-vault
description: How to read, search, and cite notes from an Obsidian vault opened read-only through Plexus. Use when you have been granted obsidian.vault.read / obsidian.vault.search and need to find, quote, summarize, or reference the user's notes.
---

# How to cite an Obsidian vault (read-only)

`obsidian.vault.read` and `obsidian.vault.search` expose the user's Obsidian
vault as a **path-confined, read-only** view. A vault is just a folder of
Markdown (`.md`) files plus attachments; these capabilities read those files
directly off disk, so they work whether or not the Obsidian app is running.

## Reading

Invoke `obsidian.vault.read` with one argument:

```json
{ "path": "Daily/2026-06-23.md" }
```

- `path` is **relative to the vault root**. Omit it (or pass `""` / `"/"`) to
  list the vault's notes instead of reading a file.
- Reading a directory returns a listing of the notes and sub-folders under it.
- Reading a file returns its UTF-8 text content plus metadata
  (`relativePath`, `bytes`, `modifiedAt`).

## Searching

Invoke `obsidian.vault.search` to find which notes mention a topic before
reading them — much faster than listing and reading every note:

```json
{ "query": "plexus roadmap", "limit": 20 }
```

- `query` — a **case-insensitive substring** matched against each note's
  vault-relative path and its content. Required.
- `limit` — maximum hits (default 20, max 100).
- Each hit is `{ relativePath, line, snippet }`: the note's vault-relative
  path, the 1-based line of the first content match (`0` for a path-only
  match), and a short excerpt around it. `truncated: true` means the cap cut
  the results short — narrow the query or raise `limit`.
- Only `.md` notes are scanned; very large and binary-looking files are
  skipped. The search never leaves the vault root.

## Discovery-first workflow

1. Search for the topic (`obsidian.vault.search { query }`), or call
   `obsidian.vault.read` with no `path` to get the note index.
2. Pick the note(s) relevant to the question.
3. Call `obsidian.vault.read` with each note's `relativePath` to read its
   full content.

## Citing well

- Always cite by the note's **relative path** (e.g. `Projects/Plexus.md`), never
  by an absolute filesystem path — the absolute path is an implementation detail
  and is never returned.
- Quote sparingly and attribute: *"per the note `Projects/Plexus.md`…"*.
- Wiki-links (`[[Other Note]]`) and tags (`#topic`) are content, not navigation —
  resolve a `[[Link]]` by reading `Link.md` (or searching the index) if needed.

## What you CANNOT do

These grants are `["read"]` only. There is **no** write, rename, delete, or
execute path — attempts are rejected by the gateway. Both read and search are
**confined to the vault directory**: any `path` that escapes the vault root
(via `..`, an absolute path, or a symlink pointing outside) is denied with
`transport_error`, and the search walk skips anything that resolves outside the
vault. Do not attempt to reach files outside the vault; ask the user to open
another vault instead.
