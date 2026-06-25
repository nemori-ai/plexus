# How to use `claudecode.run`

`claudecode.run({ prompt })` launches **headless Claude Code** to do real coding work
— read files, write code, run a multi-step build — **confined to ONE authorized
directory** by the macOS sandbox (`sandbox-exec`). You describe the task; Plexus runs
Claude Code inside the jail and returns its output.

## What it is

- **Real work, locked down.** Claude Code can read and write freely *inside* the
  authorized directory. Every read/write *outside* it fails at the kernel level
  (`Operation not permitted`). You never receive a shell, the launch command, or any
  way to reach the rest of the machine — only this capability.
- **Sandbox is the trust boundary.** Claude Code's own per-action approval prompts are
  bypassed for the headless run *because* the OS sandbox is the real jail. Plexus — not
  the agent, not Claude Code — decides which directory may be touched.

## Authorization

`claudecode.run` is an **`execute`** capability on a first-party source, so it is
**sensitive: it PENDS for the owner's approval** before it runs. Issue the call and
**wait** — Plexus returns "pending"; the helper polls until the owner approves (then it
proceeds) or rejects (then it aborts cleanly). You cannot self-approve.

For a multi-step build, the owner may pre-authorize a **scoped task bundle** ("for the
next hour, may run Claude Code repeatedly in project X") so successive calls proceed
without a prompt each time — still scoped to the one directory.

## Input

```json
{ "prompt": "Build a single-page pomodoro web app from PRD.html in this folder. Implement the quirky 4th-pomodoro grayscale walk rule." }
```

- `prompt` (required): the task for Claude Code to perform **inside the authorized
  directory**. Refer to files by their path within that directory.

## Output (for audit)

The result records the confinement for the owner to reconstruct what happened:

- `sandboxed: true`, `jail: "<authorized dir>"`, `confinement.mechanism: "sandbox-exec"`
- `ok` / `launched` / `exitCode` and Claude Code's captured `output`.

## Working pattern

1. Use the **workspace read** capability to read the inputs (refs, `me.md`, a PRD).
2. Call `claudecode.run` with a small, deterministic task (scaffold, then build, then a
   fix) — keep each call focused.
3. **Verify the products between calls** (read the files back) before the next call.
4. All paths stay inside the authorized directory; anything outside it is unreachable
   by construction.
