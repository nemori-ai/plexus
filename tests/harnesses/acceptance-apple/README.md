# Acceptance玩法 — codex × Plexus's Apple-native first-party sources

An end-to-end, **hermetic + repeatable** playthrough (玩法) of a realistic codex flow over
Plexus's three new Apple-native, **first-party** capability sources:

| source            | access      | capabilities used in this玩法 |
| ----------------- | ----------- | ----------------------------- |
| `apple-calendar`  | read        | `apple-calendar.events.list` (+ `calendars.list`) |
| `apple-reminders` | read+write  | `apple-reminders.reminders.create` (write), `reminders.list` (read) |
| `apple-notes`     | read+create | `apple-notes.notes.create` (write), `apple-notes.notes.search` (read) |

All three ship in the runtime's compile-time `MODULES` and are reserved as first-party, so
they **auto-register** — there is no admin source-add step. Under `PLEXUS_FAKE_APPLE=1` each
source resolves a **fake provider** with deterministic in-memory fixtures (sample calendars/
events, reminder lists, to-dos); the write capabilities mutate those in-memory fixtures. No
real macOS, no TCC permission, no `osascript`, no Calendar/Reminders/Notes app, no network.

## The玩法 (the story)

A user wires a **codex agent** into Plexus. codex:

1. **Setup (hermetic).** The runtime boots on a temp `PLEXUS_HOME` with `PLEXUS_FAKE_APPLE=1`.
   The three Apple sources are first-party + auto-registered.
2. **Integrates.** `GET /.well-known/plexus` (discover — the apple-calendar / apple-reminders /
   notes capabilities appear, each `provenance: first-party`, each with a `health` field) →
   `POST /link/handshake` (registers `client:{name:"codex"}`) → reads the full manifest.
3. **Grants ("为他授权对应功能").** codex requests the grants its task needs:
   `apple-calendar.events.list` (read), `apple-reminders.reminders.create` (write), and
   `apple-notes.notes.create` (write). The **read auto-approves** (first-party read posture); the two
   **writes are first-party-elevated and PEND** → the admin approve-loop (driven by the
   connection-key, modeling the user clicking **Approve**) approves them. Tokens minted.
4. **Dispatch + complete the task ("派个任务..看看完成情况").** The dispatched task is:

   > *Review today's calendar and create a follow-up reminder + a prep note for the day.*

   codex invokes `apple-calendar.events.list` for today's window (fake events come back),
   composes a deterministic follow-up from the first event ("Team sync"), invokes
   `apple-reminders.reminders.create` (`"Follow up on Team sync"`) and `apple-notes.notes.create`
   (`"Prep for Team sync"`). It then **verifies completion**: `reminders.list` shows the new
   reminder and `todos.list` shows the new to-do — the writes really landed in the fake stores.
5. **Audit review ("审计一下日志").** `GET /admin/api/audit` returns the full ordered chain —
   handshake → grant.allow/pending per cap → token.issue → the invokes (calendar read,
   reminders.create, notes.create, the verifying reads) with outcomes. The harness asserts the
   handshake precedes the first invoke and that both write-invokes are present + `ok`.
6. **Revoke.** The reminders-write grant is revoked; re-invoking `reminders.create` with the
   old token is **denied (`token_revoked` / HTTP 401)**, while the calendar **read still works**
   — proving only the write was revoked and the access is genuinely gone.

Everything runs through the **real gateway pipeline** (real discover → handshake → grants +
approve → token mint → invoke → audit → revoke), in-process via `app.request` (fetch-shaped,
same pipeline, no socket — **never binds :7077**). The only "scripted" parts are the codex
agent itself (`scenario.ts`, faithfully doing what codex would do over the HTTP API) and the
human approvals (a background loop approving pending items).

## Run it

```bash
# the readable transcript (the story, ✓/✗ per step + evidence)
bun run tests/harnesses/acceptance-apple/run.ts

# the headless gate (asserts every step — part of `bash run-tests.sh`)
bun test tests/acceptance-apple-e2e.test.ts
```

`run.ts` exits non-zero if any check fails. The whole thing is deterministic: same fake
fixtures, same window, same composed follow-up ("Team sync") every run.

## Files

- `scenario.ts` — the engine. `runScenario()` plays the codex flow over the real HTTP API and
  returns a structured `ScenarioReport` of the genuine facts (discovered caps, grant flow,
  seen events, created reminder/to-do, audit chain, revoke denial).
- `run.ts` — prints the transcript story + an evidence summary.
- `tests/acceptance-apple-e2e.test.ts` — runs it headless and asserts every step.

## Where codex is scripted vs. a real codex agent

The codex *role* is scripted in `scenario.ts` — it makes the exact HTTP calls a real codex
agent would make (discover → handshake → grants → invoke → verify), and the human approvals
are a background approve-loop rather than a person clicking in the management UI. The gateway,
authz, grants, tokens, invokes, audit, and revoke are all **real**. A **real-codex variant**
(an actual codex agent driving the same endpoints) is a separate, out-of-band run.

## Live / real-TCC smoke (NON-hermetic, manual)

With `PLEXUS_FAKE_APPLE` **unset** on a real Mac, the same sources shell out to `osascript`/
JXA (calendar + reminders + notes). The **first live use**
of each triggers the macOS **TCC** consent prompts (System Settings ▸ Privacy ▸ Calendars /
Reminders / Automation). A live smoke therefore reads/writes the user's **real** Calendar /
Reminders / Notes and is **not** hermetic — run it deliberately, by hand, on a Mac you own.
This automated harness **never** does that: it always sets `PLEXUS_FAKE_APPLE=1`.
