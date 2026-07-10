---
name: how-to-use-contacts
description: How to look up the user's Apple Contacts (bounded search + full-card read) read-only through Plexus. Use when you have been granted apple-contacts.contacts.search and/or apple-contacts.contacts.read and need someone's email, phone, address, or birthday.
---

# How to read Apple Contacts (read-only)

This source exposes the user's **macOS Apple Contacts** as two **read-only**
capabilities. They read live data from Contacts.app via a fixed, gateway-owned
JXA/AppleScript bridge — there is **no** create, update, or delete path.

## The two capabilities

### `apple-contacts.contacts.search`
Case-insensitive **substring** search across names, email addresses, and phone
numbers. `query` is required; results are **bounded** (`limit` defaults to 20,
hard cap 50):

```json
{ "query": "dana", "limit": 20 }
```

Returns:

```json
{
  "contacts": [
    {
      "id": "person-1",
      "name": "Dana Chen",
      "organization": "Chen Design Co",
      "emails": ["dana@example.com"],
      "phones": ["+1 (415) 555-0134"]
    }
  ],
  "total": 1,
  "truncated": false
}
```

- Phone matching compares **digits only** — a query needs at least 3 digits to
  match a phone number (searching `"555-0134"` or `"5550134"` both work).
- `truncated: true` means more contacts matched than the limit returned —
  narrow the query.

### `apple-contacts.contacts.read`
The **full card** for one contact, by the `id` a search returned:

```json
{ "id": "person-1" }
```

Returns `{ contact: { id, name, firstName, lastName, organization, birthday,
emails, phones, addresses } }` where `emails`/`phones`/`addresses` are
`[{ label, value }]` lists (e.g. label `"Work"`) and missing scalars are `null`
(`birthday` is an ISO `yyyy-mm-dd` date when set).

## Recommended workflow

1. `contacts.search` with the person's name (or a fragment of their email/phone).
2. If several match, disambiguate with the user by **name + organization**.
3. `contacts.read` for the one card you need. Cite details by label
   (e.g. "Work email", "Mobile").

## Handling "Contacts access not granted" (Automation / TCC)

The first read triggers a one-time macOS privacy prompt. If a call fails with a
`transport_error` mentioning **"Contacts access not granted"** (detail
`reason: "not_authorized"`), do **not** retry in a loop. Tell the user to grant
access once:

> System Settings ▸ Privacy & Security ▸ **Automation** ▸ enable the Plexus
> host app's control of **Contacts**.

After approval the same call succeeds. The source's HEALTH shows
**unavailable** with this reason until access is granted.

## What you CANNOT do

Both grants are `["read"]` only. There is **no** create-contact, edit, merge, or
delete path — none exists in the gateway. Contact data is personal: quote only
what the user's task actually needs.
