# How to use Apple Reminders via Plexus

These capabilities read and (with an explicit write grant) modify the user's
**Apple Reminders** on this Mac through the macOS Reminders app.

## When to use

- **`apple-reminders.lists.list`** (read) — discover the user's lists
  (e.g. "Reminders", "Groceries") before reading or creating items.
- **`apple-reminders.reminders.list`** (read) — fetch reminders to answer a
  question, summarize the user's to-dos, or decide what to add next. Optionally
  pass `list` (by name) and/or `completed` (true/false) to filter.
  **Default:** when you OMIT `completed`, the list returns only INCOMPLETE
  reminders (the common case, and far faster on a large library). Pass
  `completed: true` to read completed items.
- **`apple-reminders.reminders.create`** (WRITE) — add a new reminder. Use ONLY
  when the user explicitly asked to add a to-do / reminder.
- **`apple-reminders.reminders.complete`** (write) — check an existing reminder
  off by its `id` (from `reminders.list`).

## The WRITE-grant caveat (read this before creating/completing)

`reminders.create` and `reminders.complete` **mutate the user's Reminders** — a
real native write to their device. They declare `grants: ["write"]` and the
gateway will require an explicit, human-approved write grant before the call is
allowed. Do not assume a read grant covers a write. Confirm the user's intent,
then request the write grant.

The **first** real call also triggers the macOS privacy prompt
(System Settings ▸ Privacy & Security ▸ Reminders). If access is denied, the
capability reports `unavailable` with that reason — surface it to the user rather
than retrying blindly.

## Examples

Read the "Groceries" list (read grant):

```json
{ "id": "apple-reminders.reminders.list", "input": { "list": "Groceries", "completed": false } }
```

Create a reminder due tomorrow morning (WRITE grant):

```json
{
  "id": "apple-reminders.reminders.create",
  "input": {
    "title": "Buy oat milk",
    "list": "Groceries",
    "notes": "the barista kind",
    "dueDate": "2026-06-26T09:00:00"
  }
}
```

Complete a reminder you found via `reminders.list` (write grant):

```json
{ "id": "apple-reminders.reminders.complete", "input": { "id": "rem-3" } }
```
