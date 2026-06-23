# How to use Format a file with Prettier (`prettier.code.format`)

## Calling it
Invoke `prettier.code.format` with `{ path }`. Requires the verb(s): **write**.

## Discovery-first workflow
- Check the manifest entry for `prettier.code.format` before calling; read its `io.input` schema.
- Prefer the narrowest call that answers the task; do not over-fetch.

## Using it well
- Format a source file in place using the local prettier binary. Use when the agent has written or edited a file and wants it formatted to the project's style. Mutates the file on disk: requires write.

## What you CANNOT do
- This capability is granted per the verb(s) above ONLY; it cannot exceed them.
- It is confined to the local Format a file with Prettier surface — it cannot reach other apps or the network beyond its declared transport.
