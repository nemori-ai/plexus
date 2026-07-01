# Known limitations (pre-1.0, honest state)

Plexus is moving fast toward 1.0. This page lists what is **not** fully done or fully
verified yet, so nothing in the other docs over-promises. None of these are security
regressions — the trust model (default-deny, per-capability scoped grants, owner approval
for `write`/`execute`, path/sandbox confinement, audit) holds throughout.

## MCP ingestion has no user-facing entry yet

The MCP transport/client is implemented and tested (`packages/runtime/src/transports/mcp*.ts`),
but there is **no shipped "wrap an MCP server as a source" path** and **no MCP source module
in the production registry** (`MODULES`). Today you expose capabilities via the first-party
sources or by authoring an extension.

This is deliberate sequencing, not a gap we're rushing: in Plexus's model, **MCP is just one
transport carrier** — equivalent to an HTTP endpoint, a CLI, or a shell script — for a
scenario-standard capability. If/when it ships, it will be **one generic transport-carrier
ingestion path**, not an MCP special case. Low priority.

## `io.input` validation is intentionally lightweight

The gateway validates a capability's declared `io.input` at the invoke boundary for
**required keys + primitive types** (and rejects unknown top-level keys only when a schema
sets `additionalProperties: false`). It is **not a full JSON-Schema engine** — no nested-schema
recursion, formats, or `$ref`. This is contract-honoring hygiene; deeper structural validation
is a capability's own concern. Confinement and authorization are enforced independently, so a
malformed input never becomes an out-of-scope action.

## CLI allow-list is not yet mandatory for new extensions

The `cli` transport's unconditional denials (paths, shell metacharacters, interpreters)
always apply. An explicit binary allow-list, **when present**, further restricts execution
to the listed names; but an extension that declares **no** allow-list still gets a
structurally-safe bare binary permitted, for back-compat. Tightening the *new-extension*
path so that a `cli`-backed extension must ship an explicit allow-list (rather than
defaulting to "any structurally-safe bare bin") is **planned/tracked**. See
[security.md §5](security.md).

## Onboarding's "witness a call" step still depends on an external agent

Connecting an agent is now **one command**: the **Connect-an-agent** wizard (and
`POST /admin/api/agents/connect`) mints a one-time code + grants a starting cap-set,
and `GET /integration/:agentId` serves a copy-able one-command install that compiles a
per-agent Claude Code plugin. So getting a real agent to the point where it *can* call
is no longer a hand-wiring chore.

What remains true: the onboarding **"witness a call"** verification step is still not a
self-contained demo — it waits for an **external agent to actually make a call** through
the gateway. There is no built-in synthetic caller that fires the witnessed invoke for
you; you still point a real agent (e.g. the just-installed Claude Code plugin) at Plexus
and have it call a granted capability before the step completes.

## The pomodoro demo needs a frontier model

The remote DeepAgent (the demo's "brain") drives multi-step tool use — enumerate files, never
drop a required tool argument, plan, verify. That needs a **top-tier model: Anthropic Sonnet
4.6+ or OpenAI GPT-5.x.** Weaker models were observed to fail: `gpt-4.1-mini` loops to the
recursion limit (omits `path` on `workspace.read`), `gpt-4.1` gives up enumerating `refs/` and
asks the human for filenames, and `anthropic/claude-sonnet-4` (non-4.6, routed via Bedrock)
hangs in the HTTP read. The demo defaults to `claude-sonnet-4-6`; override with
`PLEXUS_DEMO_MODEL`. This is an agent-capability floor, **not** a Plexus limit — the gateway
behaves identically whatever model calls it.

## The live pomodoro demo is a runbook, not a one-click experience

The end-to-end pomodoro demo is a **real runbook with prerequisites** — Bun, a configured
agent, Python, and a frontier-model API key (see above) — not a single-command,
self-contained launch. The **agent-connection half is easier now** (the Connect-an-agent
wizard + one-command install shipped, so wiring a coding agent to the gateway is one
command), but the demo's remote-DeepAgent brain, Python harness, and model key are still
yours to supply. The demo's **Python test suite runs against a fake gateway**, so a green
test run exercises the agent/flow logic but does **not** prove the full live wiring against
a real gateway. Follow the runbook steps and expect to supply the prerequisites yourself.

## New subsystems: code + hermetic-test verified; live-E2E status honest

The per-agent enrollment/compile stack shipped recently; its verification posture, stated
plainly so nothing over-promises:

- **Per-agent enrollment / PAT** (one-time code → durable PAT; connection-key admin-only;
  PAT-auth handshake binds the real `agentId`) — enforced in code and covered by hermetic
  runtime tests + two adversarial red-team reviews (see
  [`docs/design/security-model.md`](design/security-model.md)). Verified by code + tests.
- **Compiled Claude Code plugin + `plexus-<agentId>` launcher** — rendered deterministically
  by the gateway and gated by the build-time Floor verifier (Inv VI). Covered by hermetic
  renderer/verifier tests and the Codex e2e smoke; a **full live install-then-invoke E2E of
  the compiled CC plugin across a fresh machine is not part of this cycle's automated gate** —
  treat it as code + hermetic-test verified, live validation pending.
- **Extension persistence** (`~/.plexus/extensions.json` + boot replay, commit 654dcfa) —
  admin-installed extensions survive a gateway restart; covered by runtime tests.

None of these are security regressions — the trust model (default-deny, per-capability
scoped grants, owner approval for `write`/`execute`, `execute`-never-standing, audit) holds
throughout.

## Desktop / cross-platform / real macOS app providers: code-verified, not E2E-verified this cycle

macOS is the shipped, fully-implemented target. The following are validated by code review +
unit tests + injectable fake providers, but were **not** run end-to-end in an isolated
environment in the current cycle — treat them as *mostly matched, pending live validation*:

- **The Electron desktop app** (tray supervisor + native approval notifications).
- **The real macOS Apple providers** (real `osascript` / JXA for Calendar / Reminders / Things)
  — these need macOS **TCC** grants and a real desktop session; hermetic tests use
  `PLEXUS_FAKE_APPLE=1`.
- **Windows / Linux** `PlatformServices` — typed stubs behind the same seam (a fill-in, not a
  rewrite), not a shipped target.

If you hit a rough edge in any of these, it's expected pre-1.0 — please file it.
