# How to use `codex.run`

`codex.run({ prompt })` launches the **Codex CLI** (`codex exec`) **headless** to do
real coding work — read files, write code, run a multi-step task — in **ONE authorized
directory**. You describe the task; Plexus runs Codex there and returns its output.

## What it is

- **Real work in one directory.** By default the run is kernel-jailed to the authorized
  directory: its reads, writes and temp files live there, Codex's own login works, and it
  reaches the network for its model. The owner can instead choose to run it with their
  own user permissions. The result's `isolation` field states which policy the run had.
- **A task, not a shell.** You pass a `{ prompt }` (and an optional in-dir `cwd`)
  describing the task. The run is headless, so Codex works through it without stopping
  to ask. Plexus — not the agent, not Codex — decides which directory it works in and
  under which policy.

## Authorization

`codex.run` is an **`execute`** capability on a first-party source, so it is
**sensitive**. Check the **`standing`** flag on your manifest entry:

- **`standing: true`** — the owner pre-authorized this capability for your connection
  (a per-capability Standing opt-in). Calls run **without a per-call approval**.
- **No `standing` flag** — every call **PENDS for the owner's approval**. Issue the
  call and **wait** — Plexus returns "pending" until the owner approves (then it
  proceeds) or rejects (then it aborts cleanly). You cannot self-approve.

For a multi-step build, the owner may pre-authorize a **scoped task bundle** ("for the
next hour, may run Codex repeatedly in project X") so successive calls proceed without a
prompt each time — still scoped to the one directory.

## Input

```json
{ "prompt": "Refactor the timer module in this folder and add unit tests." }
```

- `prompt` (required): the task for Codex to perform **inside the authorized
  directory**. Refer to files by their path within that directory.
- `cwd` (optional): a sub-directory of the authorized dir to run in. Anything that
  escapes the authorized dir is rejected before Codex is ever spawned.

## Output (for audit)

The result states what the run could reach and what it did:

- `isolation.policy`: `jail` (the default) or `host`. Under `jail` the run reads, writes
  and keeps its temp files in the authorized directory, uses Codex's own login, and
  reaches the network. Under `host` it runs with the owner's own user permissions.
- `isolation.scope` (`files`, `temp`, `network`, `toolState`) spells that out.
- `isolation.enforced: true` means the jail was verified and Codex ran inside it.
- `ok` / `launched` / `exitCode` and Codex's captured `output`. When the run did
  not start, `reason` says why.

## Long runs — call it with `async: true`

A real task here runs for **minutes**. The entry is marked `longRunning`, and you should
send `async: true` with the call:

```json
{ "id": "codex.run", "async": true, "input": { "prompt": "…" } }
```

You get **HTTP 202** and a run handle instead of a result:

```json
{ "id": "codex.run", "ok": true, "run": { "runId": "run_…", "status": "running",
  "statusUrl": "https://…/invoke/status?runId=run_…", "expiresAt": "…" } }
```

`ok: true` here means **accepted**, not finished — that is what `run` present and
`output` absent tells you. Then poll `run.statusUrl` (or await the `invoke_resolved`
event on `GET /events`) until `status` is `succeeded`/`failed`; the `result` field is
the exact response the synchronous call would have returned.

Collecting requires being the agent that made the call — present your scoped token or
`X-Plexus-Session`. The read is repeatable until `expiresAt`, so a dropped reply costs
you nothing.

**Call it synchronously only on a fast local wire.** Over anything that caps request
duration — a tunnel, a proxy, your own HTTP client timeout — that hop answers you while
the run continues on the gateway: you lose the result, and retrying starts a **second
real run**. Authorization is unchanged either way; a denial still comes back immediately.

## Working pattern

1. Use the **workspace read** capability to read the inputs (refs, a spec, a PRD).
2. Call `codex.run` with a small, deterministic task (scaffold, then build, then a fix)
   — keep each call focused.
3. **Verify the products between calls** (read the files back) before the next call.
4. Keep all work inside the authorized directory — that is where the tool builds and
   where its writes land. If the local `codex` CLI is not installed, the capability
   reports `source_unavailable` rather than failing the whole session.
