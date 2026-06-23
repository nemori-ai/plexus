# How to use Search Acme notes (`acme-notes.notes.search`)

## Calling it
Invoke `acme-notes.notes.search` with `{ query }`. Requires the verb(s): **read**.

## Discovery-first workflow
- Check the manifest entry for `acme-notes.notes.search` before calling; read its `io.input` schema.
- Prefer the narrowest call that answers the task; do not over-fetch.

## Using it well
- Search the user's local Acme notes by full-text query so the agent can cite their personal notes. Use when the task references the user's notes or prior decisions. Read-only: never mutates.

## What you CANNOT do
- This capability is granted per the verb(s) above ONLY; it cannot exceed them.
- It is confined to the local Search Acme notes surface — it cannot reach other apps or the network beyond its declared transport.
