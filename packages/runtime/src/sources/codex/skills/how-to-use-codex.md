# How to use `codex.run`

`codex.run({ prompt })` launches the **Codex CLI** (`codex exec`) **headless** to do
real coding work — read files, write code, run a multi-step task — **sandboxed to ONE
authorized directory**. You describe the task; Plexus runs Codex there and returns its output.

## What it is

- **Real work, write-confined.** Codex does its work *inside* the authorized directory
  and **cannot create or modify files outside it** — writes outside that directory are
  blocked. You never receive a shell, the launch command, or any other way to drive the
  rest of the machine — only this capability.
- **Plexus owns the boundary.** Codex's own approval prompts are skipped for the headless
  run because it runs sandboxed (write-confined) to the one authorized directory. Plexus —
  not the agent, not Codex — decides which directory it works in.

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

The result records the confinement for the owner to reconstruct what happened:

- `sandboxed: true`, `jail: "<authorized dir>"`, `confinement.mechanism: "codex-workspace-write"`
- `ok` / `launched` / `exitCode` and Codex's captured `output`.

## Working pattern

1. Use the **workspace read** capability to read the inputs (refs, a spec, a PRD).
2. Call `codex.run` with a small, deterministic task (scaffold, then build, then a fix)
   — keep each call focused.
3. **Verify the products between calls** (read the files back) before the next call.
4. Keep all work inside the authorized directory — that is where the tool builds and
   where its writes land. If the local `codex` CLI is not installed, the capability
   reports `source_unavailable` rather than failing the whole session.
