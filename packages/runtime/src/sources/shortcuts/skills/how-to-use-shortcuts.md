# How to use Apple Shortcuts (`shortcuts.list` + `shortcuts.run`)

This source exposes the owner's **Apple Shortcuts** — their personal, user-defined
automations on this Mac — through two capabilities:

- `shortcuts.list` (**read**) — discover what shortcuts exist.
- `shortcuts.run` (**execute**) — run one of them by name.

## Working pattern: list, then run

1. Call `shortcuts.list({})`. It returns the shortcut **names** (plus the folder
   names they are organized into). It is read-only and never runs anything.
2. Pick the exact name and call `shortcuts.run({ name, input? })`. The `name` must
   match a listed shortcut **verbatim** — always list before you run.
3. `input` (optional) is text handed to the shortcut as its input. `timeoutMs`
   (optional) caps the run (default 60000 ms; the run is killed at the deadline and
   reported with `timedOut: true`).

## `shortcuts.run` is execute-granted and owner-gated

A shortcut is a **user-defined automation** — it can do anything the owner built it
to do (send messages, move files, control apps). So `shortcuts.run` is gated twice:

1. **Execute grant.** It carries `grants:["execute"]`, so every call **PENDS for the
   owner's approval**. Issue the call and **wait** — you cannot self-approve.
2. **Record mode by default.** Even an approved call does not execute until the
   owner has enabled **real launch** for this source (Plexus console → What I
   expose → Shortcuts → Real launch). Until then the gateway is in **record mode**:
   your call returns

   ```json
   { "ok": true, "launched": false, "output": "", "exitCode": null,
     "reason": "record mode: …assembled and audited but not executed" }
   ```

   — the exact `shortcuts run` command that WOULD have run was assembled and
   audited for the owner, but **nothing executed**. Treat `launched: false` as
   "recorded, not executed" and tell the user so; do not retry in a loop.

## Output (real runs)

- `ok` — the shortcut ran and exited 0.
- `launched: true` — a real execution happened.
- `output` — the shortcut's captured output, verbatim.
- `exitCode` / `timedOut` / `reason` — diagnostics when something went wrong.

## Availability

Apple Shortcuts requires macOS. On a machine without the `shortcuts` CLI the source
reports **unavailable** health and calls fail advisorily with `source_unavailable` —
surface that to the user rather than retrying.
