---
name: how-to-cite-vault
description: How to read and cite notes from an Obsidian vault opened read-only through Plexus. Use when you have been granted obsidian.vault.read and need to quote, summarize, or reference the user's notes.
---

# How to cite an Obsidian vault (read-only)

`obsidian.vault.read` exposes the user's Obsidian vault as a **path-confined,
read-only** view. A vault is just a folder of Markdown (`.md`) files plus
attachments; this capability reads those files directly off disk, so it works
whether or not the Obsidian app is running.

## Calling it

Invoke `obsidian.vault.read` with one argument:

```json
{ "path": "Daily/2026-06-23.md" }
```

- `path` is **relative to the vault root**. Omit it (or pass `""` / `"/"`) to
  list the vault's notes instead of reading a file.
- Reading a directory returns a listing of the notes and sub-folders under it.
- Reading a file returns its UTF-8 text content plus metadata
  (`relativePath`, `bytes`, `modifiedAt`).

## Discovery-first workflow

1. Call with no `path` (or `path: ""`) to get the note index.
2. Pick the note(s) relevant to the question.
3. Call again with each note's `relativePath` to read its content.

## Citing well

- Always cite by the note's **relative path** (e.g. `Projects/Plexus.md`), never
  by an absolute filesystem path — the absolute path is an implementation detail
  and is never returned.
- Quote sparingly and attribute: *"per the note `Projects/Plexus.md`…"*.
- Wiki-links (`[[Other Note]]`) and tags (`#topic`) are content, not navigation —
  resolve a `[[Link]]` by reading `Link.md` (or searching the index) if needed.

## What you CANNOT do

This grant is `["read"]` only. There is **no** write, rename, delete, or execute
path — attempts are rejected by the gateway. The read is **confined to the vault
directory**: any `path` that escapes the vault root (via `..`, an absolute path,
or a symlink pointing outside) is denied with `transport_error`. Do not attempt
to reach files outside the vault; ask the user to open another vault instead.
