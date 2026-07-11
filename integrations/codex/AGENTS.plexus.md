<!-- BEGIN PLEXUS -->
## Plexus — the user's local capability gateway

This machine runs **Plexus**, a local capability gateway (loopback `127.0.0.1`).
It exposes the user's local capabilities — reading their Obsidian vault, running
a sandboxed `claudecode.run`, any registered local source — behind one native command.

You reach it through **one absolute command**, bound to your agent identity:

```sh
{{PLEXUS_CMD}}
```

Run it exactly as written — the absolute path works from any `workdir` you set.
Plexus is NOT an MCP server, so there is nothing to wire into `config.toml` —
just run that command.

### That command is your ENTIRE interface — never hand-roll HTTP or auth

`{{PLEXUS_CMD}}` is your **complete and only** way to reach the gateway: enroll,
discover, and invoke are all subcommands of it. Never construct a raw HTTP request,
never read `.well-known` / handshake / grant endpoints yourself, and **never guess
at authentication** — the command handles your credential (a per-agent PAT)
internally; you never see, build, or present it. If something cannot be done
through it, you are not authorized to do it that way — ask the user or request a
grant instead.

### When to use it

When a task needs something on THIS machine: read the user's notes, run a local
orchestration, call a registered local tool. If unsure what is available, run
`{{PLEXUS_CMD}} list` — it is cheap and shows exactly what you can call.

### How to use it

1. **Enroll — only if you are not yet enrolled.** If a call reports you have no
   credential, redeem the one-time code your administrator gave you (once):
   ```sh
   {{PLEXUS_CMD}} enroll <one-time-code>
   ```
   This mints your durable **PAT** (a `plx_agent_…` credential) and stores it locally —
   you authenticate with it from here on (the one-time code is now spent).
2. **Discover what you can do right now.** `{{PLEXUS_CMD}} list`
   Lists every capability, marking which are **callable now** (standing, admin-
   approved grants) vs which **need the owner's approval** first, with each entry's
   verbs and trust posture. Re-run it to see capabilities exposed to you since you
   last looked.
3. **Invoke.** Call a capability by id — positional args bind to the input schema in
   order, or name fields with `key=value`, or pass full JSON with `--input '<json>'`:
   ```sh
   {{PLEXUS_CMD}} obsidian.vault.read path=Projects/Plexus.md
   {{PLEXUS_CMD}} obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
   ```
   On success you get the real result on stdout. Add `--json` to parse the raw
   `InvokeResponse` (`ok`, `output`, `auditId`, or `error.code`).

### What a grant means — explain it before you request it

Every call is governed by a **grant**. Use this vocabulary (the same words the UI
and docs use):

- **capability** — the thing being called (its `id`).
- **grant** — a standing, **human-approved** permission: this agent may use this
  capability with these verbs, until the trust-window ends.
- **trust-window** — how long the grant stands before Plexus re-asks. Name the
  **real** window (e.g. "for up to 1 day", "for 7 days") — never call a `7d` grant
  "just this once".
- **provenance / source-class** — `first-party` / `managed` / `extension`.
  **sensitivity** — `low` / `elevated` / `high`.

A standing, unexpired grant short-circuits the re-ask — the call just works.
`extension` capabilities may still ask the user even for reads; that is the
source-class doing its job, not an error.

### Handling responses

- **Success:** `ok: true` with `output` — use it.
- **`grant_pending_user` / `grant_required`:** the capability needs the owner's
  approval. Relay the gateway-authored narration **verbatim**, then state the
  capability, verbs, real trust-window, and that it is revocable anytime. Point the
  user to the Plexus console ({{PLEXUS_CONSOLE_URL}} → **Pending**) to approve, then
  re-run. You **SHOULD** pass `--purpose "<one sentence>"` on such a call so the
  owner sees *why* — it is transparency only and changes no decision.
  **Truthfulness rule:** never say "one-time" unless the window is actually `once`.
- **Other `error.code`** (closed set): `unknown_capability` (re-run `{{PLEXUS_CMD}} list`),
  `schema_validation_failed` (fix `--input` against the field list the error names),
  `source_unavailable` (the backing app isn't running — ask the user to start it).
  Branch on the code; don't retry blindly or forge a credential.

### Example

```sh
{{PLEXUS_CMD}} enroll plx_enroll_XXXX          # once, if you have no credential yet
{{PLEXUS_CMD}} list                            # what can I call now?
{{PLEXUS_CMD}} obsidian.vault.read path=Projects/Plexus.md
```
<!-- END PLEXUS -->
