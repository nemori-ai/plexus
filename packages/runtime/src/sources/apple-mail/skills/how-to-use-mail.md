---
name: how-to-use-mail
description: How to read the user's Apple Mail (mailboxes, bounded search, single-message read) STRICTLY read-only through Plexus. Use when you have been granted apple-mail.mailboxes.list, apple-mail.messages.search, and/or apple-mail.message.read and need to find or read the user's email.
---

# How to read Apple Mail (strictly read-only)

This source exposes the user's **macOS Apple Mail** as three **read-only**
capabilities. They read live data from Mail.app via a fixed, gateway-owned
JXA/AppleScript bridge.

**This source is strictly read-only.** There is **no drafting capability and no
sending capability — they do not exist** in this source, and neither do move,
delete, flag, or mark-as-read. Do not promise the user you can draft, send,
reply to, or modify email through Plexus.

**Results are bounded and truncated by design.** Searches return at most 50
results (default 20) with ~200-char snippets; message bodies are capped at
20,000 characters. When something got cut, the response says so
(`truncated: true`) — narrow the query instead of assuming you saw everything.

## The three capabilities

### `apple-mail.mailboxes.list`
Lists accounts and each account's mailboxes with unread counts. Takes **no input**.

```json
{ "accounts": [ { "account": "Work", "mailboxes": [ { "name": "INBOX", "unreadCount": 1 } ] } ] }
```

Call this first to discover mailbox/account names for a scoped search, or to
answer "how much unread mail do I have?".

### `apple-mail.messages.search`
Searches **one mailbox** (never all mail at once). All fields optional:

```json
{
  "mailbox": "INBOX",
  "account": "Work",
  "sender": "dana",
  "subject": "roadmap",
  "since": "2026-06-01T00:00:00Z",
  "before": "2026-07-01T00:00:00Z",
  "limit": 20
}
```

> The dates above are illustrative — always compute date bounds from the
> **current date/time you were given**, never copy the example.

- `mailbox` defaults to `"INBOX"` (the unified inbox across accounts).
- `sender` / `subject` are **case-insensitive substrings**.
- `limit` defaults to **20** and is **hard-capped at 50** — you cannot page
  through an entire mailbox.
- Returns newest-first `{ messages: [{ id, sender, subject, date, snippet, mailbox }], total, truncated }`.
  `truncated: true` means more matched than were returned — add filters.

**Performance:** searching a very large mailbox with only a broad substring can
be slow (the query is evaluated inside Mail per message) and will **time out
with a clear error rather than hang**. Prefer a `since`/`before` date range
and/or a sender filter, and scope to a specific mailbox when you can.

### `apple-mail.message.read`
Reads **one** message's plain-text body by the `id` a search returned:

```json
{ "id": "12345", "mailbox": "INBOX", "account": "Work" }
```

Pass the **same mailbox/account the search used** — ids are located within a
mailbox. Returns `{ id, sender, subject, date, mailbox, content, truncated, totalChars }`.
Bodies longer than 20,000 chars are truncated (`truncated: true`, with the full
length in `totalChars`); you may pass a smaller `maxChars` (min 200) to read less.

## Recommended workflow

1. `apple-mail.mailboxes.list` — find the account/mailbox names (and unread counts).
2. `apple-mail.messages.search` — scoped, filtered, bounded. Cite messages by
   **sender + subject + date**.
3. `apple-mail.message.read` — only for the specific message(s) you need in full.

## Handling "Mail access not granted" (Automation / TCC)

The first read triggers a one-time macOS privacy prompt. If a call fails with a
`transport_error` mentioning **"Mail access not granted"** (detail
`reason: "not_authorized"`), do **not** retry in a loop. Tell the user to grant
access once:

> System Settings ▸ Privacy & Security ▸ **Automation** ▸ enable the Plexus
> host app's control of **Mail**.

After approval the same call succeeds. The source's HEALTH shows
**unavailable** with this reason until access is granted.

## What you CANNOT do

All grants are `["read"]` only. **No draft, send, reply, forward, move, delete,
or flag path exists anywhere in this source** — the gateway has no such
capability to grant.
