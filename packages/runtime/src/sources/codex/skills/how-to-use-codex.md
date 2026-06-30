# How to use `codex.run`

`codex.run({ prompt })` launches the **Codex CLI** (`codex exec`) **headless** to do
real coding work — read files, write code, run a multi-step task — **confined to ONE
authorized directory** by the macOS sandbox (`sandbox-exec`). You describe the task;
Plexus runs Codex inside the jail and returns its output.

## What it is

- **Real work, locked down.** Codex can read and write freely *inside* the authorized
  directory. Every read/write *outside* it fails at the kernel level (`Operation not
  permitted`). You never receive a shell, the launch command, or any way to reach the
  rest of the machine — only this capability.
- **Sandbox is the trust boundary.** Codex's own approval prompts and internal sandbox
  are bypassed for the headless run *because* the OS seatbelt is the real jail. Plexus —
  not the agent, not Codex — decides which directory may be touched.

## Authorization

`codex.run` is an **`execute`** capability on a first-party source, so it is
**sensitive: it PENDS for the owner's approval** before it runs. Issue the call and
**wait** — Plexus returns "pending" until the owner approves (then it proceeds) or
rejects (then it aborts cleanly). You cannot self-approve.

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

- `sandboxed: true`, `jail: "<authorized dir>"`, `confinement.mechanism: "sandbox-exec"`
- `ok` / `launched` / `exitCode` and Codex's captured `output`.

## Working pattern

1. Use the **workspace read** capability to read the inputs (refs, a spec, a PRD).
2. Call `codex.run` with a small, deterministic task (scaffold, then build, then a fix)
   — keep each call focused.
3. **Verify the products between calls** (read the files back) before the next call.
4. All paths stay inside the authorized directory; anything outside it is unreachable
   by construction. If the local `codex` CLI is not installed, the capability reports
   `source_unavailable` rather than failing the whole session.
