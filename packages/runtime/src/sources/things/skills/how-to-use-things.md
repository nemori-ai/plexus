# How to use Things 3

Plexus exposes the user's **Things 3** task app with a clear split between **reads**
(via the AppleScript dictionary) and a single bounded **write** (via the Things
URL-scheme). Use the reads to ground yourself in the user's actual tasks before you add
anything.

## Read the user's tasks

- **`things.todos.list`** (read) — lists to-dos as `{ id, title, notes, status, list? }`.
  Pass an optional `{ list }` to confine to a named list/project, e.g.
  `{ "list": "Groceries" }`. Omit it to list everything.
- **`things.projects.list`** (read) — lists projects as `{ id, title, area?, status }`.
  Use it to learn the user's project structure before adding or organizing to-dos.

Both reads go through the Things AppleScript dictionary (`osascript`). They are
**read-only** — they never change anything.

## Add a to-do

- **`things.todos.add`** (write) — appends a **new** to-do via the Things URL-scheme
  (`things:///add?title=...`). This is a *well-bounded* write: it **adds** a to-do; it
  does **not** edit, complete, or delete existing ones.

  Input: `{ title, notes?, when?, list? }`
  - `title` (required) — the to-do title.
  - `notes` — optional free-text body.
  - `when` — a Things schedule value: `today`, `tomorrow`, `evening`, `anytime`,
    `someday`, or a date.
  - `list` — target a named list/project.

  Example: `{ "title": "Buy oat milk", "when": "today", "list": "Groceries" }`.

## Etiquette

- Prefer reading first (`things.todos.list` / `things.projects.list`) so you add to the
  right list and don't duplicate an existing to-do.
- The add capability requires a **write** grant — it changes the user's task store.
- There is no edit/delete capability by design; the write surface is intentionally just
  "append a to-do".
