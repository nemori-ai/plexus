# How to use <label> (`<id>`)

## Calling it
Invoke `<id>` with `{ <fields> }`. Requires the verb(s): **<verbs>**.

## Discovery-first workflow
- Check the manifest entry for `<id>` before calling; read its `io.input` schema.
- Prefer the narrowest call that answers the task; do not over-fetch.

## Using it well
- <the one-line outcome from describe>
- <a worked example or convention>

## Gotchas
- <e.g. path is relative to the vault root, not absolute>

## What you CANNOT do
- This capability is granted per the verb(s) above ONLY; it cannot exceed them.
- It is confined to the local <app> surface — it cannot reach other apps or the
  network beyond its declared transport.
