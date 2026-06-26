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

## The pomodoro demo needs a frontier model

The remote DeepAgent (the demo's "brain") drives multi-step tool use — enumerate files, never
drop a required tool argument, plan, verify. That needs a **top-tier model: Anthropic Sonnet
4.6+ or OpenAI GPT-5.x.** Weaker models were observed to fail: `gpt-4.1-mini` loops to the
recursion limit (omits `path` on `workspace.read`), `gpt-4.1` gives up enumerating `refs/` and
asks the human for filenames, and `anthropic/claude-sonnet-4` (non-4.6, routed via Bedrock)
hangs in the HTTP read. The demo defaults to `claude-sonnet-4-6`; override with
`PLEXUS_DEMO_MODEL`. This is an agent-capability floor, **not** a Plexus limit — the gateway
behaves identically whatever model calls it.

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
