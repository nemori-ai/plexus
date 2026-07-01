<!--
  [P] — the hand-authored PEDAGOGICAL shell for the compiled Claude Code plugin's
  `use-plexus` SKILL (agent-skill-compile ADR-6/ADR-7, Inv VI). This body is PROSE
  only: task-framing, the call pattern, the grant vocabulary, failure branching, and
  the truthfulness contract. It is the SAME for every compiled integration (per
  agent-TYPE, not per agent) and deliberately carries **no auth mechanics** — the
  redeem -> PAT -> handshake -> token -> invoke chain lives entirely inside the
  `plexus` binary on PATH (tier-3), never in this context. The per-agent bits (your
  agentId, your granted capability list) are TEMPLATED in above this body, not here.
-->

**Plexus** is the user's local capability gateway (loopback `127.0.0.1`). It exposes
their *local software capabilities* — their Obsidian vault, cc-master orchestration,
any registered local app/CLI/service — behind one native command. Plexus is **not**
an MCP server; you reach it through the **`plexus` CLI** this plugin puts on your Bash
PATH. Everything below runs as Bash commands.

## The one thing to know: just call the capability

Your capabilities are **already granted** to you (standing, admin-approved) and your
credential is **already stored locally** — you never see, handle, or manage it. To use
a capability, call it by id:

```bash
plexus <capabilityId> <args...>          # positional args bind to the input schema, in order
plexus <capabilityId> key=value ...      # or name the input fields
plexus <capabilityId> --input '<json>'   # or pass full JSON input
plexus <capabilityId> --json             # print the raw InvokeResponse to parse
```

On success you get the **real result** (note content, workflow output, …) on stdout —
and *only* the result; the auth plumbing stays hidden inside the binary. Use `--json`
whenever you need to parse the output into your answer.

If you are ever **not yet enrolled** (a fresh machine, or your credential was reset),
the CLI will tell you to run `plexus enroll <one-time-code>` with the code your
administrator gave you. That is the only time a code is involved; after it, calls just
work. **Never** invent, forge, or reuse another credential — if you cannot enroll, tell
the user and stop.

## Discover what a capability expects (when the args aren't obvious)

You do not need to guess input shapes. Ask the gateway:

```bash
plexus <capabilityId> --help    # or run with no/again wrong args to see the field list
```

Form your `--input` from what it tells you rather than inventing fields.

## State your purpose when a call may need a human

When a call requests access that isn't already standing — especially any
`write` / `execute` — you **SHOULD** declare *why you need it now* with
`--purpose "<one sentence>"`. Plexus shows it to the user labeled **"the agent says:"**,
kept deliberately **separate** from its own **"Plexus says:"** narration. This is
**transparency only**: your purpose changes **no** authorization decision and can never
widen your scope — it just lets the human approve with context. Write it the way you'd
explain the action to the user: short, concrete, honest.

## What a grant means — explain it before you request it

Every call is governed by a **grant**. Before you rely on a capability — and ALWAYS when
a call needs approval — you must be able to tell the user, truthfully, *what they are
authorizing*. Use this exact vocabulary (the same words the UI and docs use):

- **capability** — the thing being called (its `id`).
- **grant** — a standing, **human-approved** permission: *this agent may use this
  capability with these verbs, until the trust-window ends*.
- **trust-window** — how long the grant **stands** before Plexus re-asks the user. This
  is the clock that matters to the human. Name the **real** window (e.g. "for up to 1
  day", "for 7 days") — never call a `7d` grant "just this once".
- **provenance / source-class** — `first-party` (ships with Plexus) · `managed` (a
  source the user added) · `extension` (wire-registered). **sensitivity** — derived
  risk: `low` / `elevated` / `high`.

A standing, unexpired grant short-circuits the re-ask: the call just works. `extension`
capabilities may still ask the user even for reads — that is the source-class doing its
job, not an error. Do not try to bypass a grant; if you cannot get one approved, tell
the user and stop.

## Failure handling — branch on the closed error code

On failure the CLI exits non-zero and prints a **closed error code** (use `--json` to
read `error.code`). Branch on it deterministically:

- `unknown_capability` → the id is wrong; you referenced a capability you don't have.
- `grant_required` / `grant_pending_user` → this needs the owner's approval; relay the
  gateway-authored narration verbatim (capability + verbs + real trust-window +
  revocability) and ask the user to approve in the Plexus console, then re-run.
- `schema_validation_failed` → your `--input` is wrong; check the field list and retry.
- `source_unavailable` → the backing local app isn't running; ask the user to start it.

**Truthfulness rule (hard):** never tell the user an approval is "one-time" unless the
trust-window is actually `once`. The user always sees your claim and the gateway's truth
side by side — keep them consistent.
