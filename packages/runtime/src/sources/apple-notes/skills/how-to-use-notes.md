# How to use Apple Notes via Plexus

These capabilities read and (with an explicit write grant) ADD TO the user's
**Apple Notes** on this Mac through the macOS Notes app.

## The write surface is CREATE-ONLY (read this first)

The only write that exists is `apple-notes.notes.create` — it makes a **new**
note. There is **no capability to update, delete, move, or rename an existing
note**; those operations do not exist in this source at all, so do not plan
around them. If the user asks to "edit" a note, the honest options are: create a
new note with the revised content (and tell the user where it is), or ask the
user to edit the original themselves.

## When to use

- **`apple-notes.folders.list`** (read) — discover the folders (and their
  accounts, e.g. "iCloud") first: to know where notes live, and to pick a valid
  `folder` before creating a note. Creating into a non-existent folder fails —
  folders are never silently created.
- **`apple-notes.notes.search`** (read) — find notes by a substring of the
  title or body text. Returns a BOUNDED hit list — `id`, `title`, `folder`,
  `modifiedAt`, and a short `snippet` — never full bodies. `limit` defaults to
  20 (hard cap 50). Prefer specific queries: a broad query over a large library
  is slow and gets truncated at the cap. If you got exactly `limit` hits,
  assume there may be more — narrow the query rather than raising the limit.
- **`apple-notes.notes.read`** (read) — fetch ONE note's full content by `id`
  (preferred — take it from a search hit) or by EXACT `title`. Notes bodies are
  stored as HTML, so you get BOTH `text` (plain-text extraction — usually what
  you want to quote) and `html` (the raw body — use when formatting matters).
- **`apple-notes.notes.create`** (WRITE) — create a new note with a `title`,
  optional plain-text `body` (line breaks become paragraphs), and optional
  target `folder` (from `folders.list`). Use ONLY when the user explicitly
  asked to save/capture a note.

## Citing notes

Always cite a note by its **id** (stable, from search/read/create results) or,
when talking to the user, by its **exact title** and folder. Never invent or
paraphrase a title as if it were the real one — the `title` field from a
result is the citation.

## The WRITE-grant caveat

`notes.create` **mutates the user's Notes** — a real native write to their
device. It declares `grants: ["write"]` and the gateway requires an explicit,
human-approved write grant before the call is allowed. Do not assume a read
grant covers it. Confirm the user's intent, then request the write grant.

The **first** real call also triggers the macOS Automation prompt (System
Settings › Privacy & Security › Automation — allow Plexus/your terminal to
control Notes). If access is denied, the source reports `unavailable` with that
reason — surface it to the user rather than retrying blindly.

## Examples

Discover folders (read grant):

```json
{ "id": "apple-notes.folders.list", "input": {} }
```

Find the focaccia recipe (read grant):

```json
{ "id": "apple-notes.notes.search", "input": { "query": "focaccia", "limit": 10 } }
```

Read the note you found, by id (read grant):

```json
{ "id": "apple-notes.notes.read", "input": { "id": "x-coredata://ABC/ICNote/p123" } }
```

Capture a new note into "Work" (WRITE grant):

```json
{
  "id": "apple-notes.notes.create",
  "input": {
    "title": "Standup follow-ups",
    "body": "Ping Sam about the ADR.\nBook the retro room.",
    "folder": "Work"
  }
}
```
