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

## Exec-result confinement diagnostics: wire/audit split shipped for codex + claudecode

`codex.run` / `claudecode.run` results now return the **minimal wire set** to the calling
agent (`ok`, `launched`, `sandboxed`, `output`, `exitCode`, `reason?`); the confinement
diagnostics — absolute jail path, the owner's home directory, tool install path/version,
the full sandbox argv (prompt masked) — go to the **owner's audit record only**
(`detail` on the invoke event). A jail-root behavior contract (`AGENTS.md` for codex,
`CLAUDE.md` for claude; owner-authored files win) additionally steers the spawned tool
itself to use relative paths and not volunteer machine details — because the tool's own
stdout is returned verbatim (the gateway never rewrites tool output), that steering is
advisory, not a guarantee. Related
backlog: split `codex.plan` (read, dry-run) from `codex.run` (execute, real) so the
record-mode/real distinction lives in the capability id rather than a settings knob; the
approval narration should state the current real-launch mode either way.

**Depth follow-ups (tracked, not yet done):** (a) the wire/audit split is a per-bridge
convention (`toData`/`toAuditDiagnostics` duplicated in `codex` + `claudecode`), not a
pipeline-enforced projection keyed off the declared `io.output` schema — a generic seam at
`core/pipeline.ts` would cover any future exec source for free; (b)
`realLaunchEnabled(sourceId, envFallback)` re-states the `REAL_LAUNCH_SOURCES` registry's
env mapping at each call site — a registry lookup keyed on `sourceId` alone would remove the
duplication; (c) `publicHostnames` uses array-position-0 as the canonical advertised base
(an implicit positional contract assembled from env + `network.json` + de-dup) — an explicit
`canonicalHostname` (or "one hostname + aliases") field would make it structural; (d) the
stale-dist warning compares src/dist mtimes (git doesn't preserve mtimes) — a build stamp
(git rev / src content hash embedded at Vite build) would be deterministic.

## Publishing the gateway makes the admin console internet-reachable (by design; harden with Access)

Setting `PLEXUS_PUBLIC_HOSTNAME` (the [home-gateway](../examples/home-gateway/) recipe)
publishes not just the agent surface but the `/admin` SPA + `/admin/api/*` through the
tunnel. Those stay **connection-key gated** (the key never leaves the owner's machine; the
compare is `timingSafeEqual`; the key is high-entropy `randomBytes(32)`), and the Host/Origin
guard + https-only origin allowance hold — but the trust boundary is now "the public
internet" rather than loopback/LAN. There is no per-IP throttle and no audit event on a
**failed** key/enrollment attempt, so brute-force attempts from the edge are unthrottled and
invisible. Brute force is infeasible against the entropy, but an owner exposing a gateway
long-term should front the hostname with **Cloudflare Access** (service token for the agent,
email OTP for `/admin`) — the gateway composes cleanly behind it. Tracked: failed-auth audit
events + a basic redeem/key-verify throttle. An invalid `PLEXUS_PUBLIC_HOSTNAME` is also
dropped silently at boot (fail-closed → every edge request 403s); a boot warning on rejected
entries is a pending nicety.

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
- **Windows** `PlatformServices` — a **concrete** implementation behind the same seam
  (`packages/runtime/src/platform/win32.ts`: `PATHEXT`-aware binary resolution, `cmd.exe`/`.ps1`
  spawn shimming), unit-tested via injected env/fs, but **not yet validated on a real Windows
  host** — treat as code-verified, live validation pending.

(**Linux** `PlatformServices` is **no longer** in this "not E2E-verified" set — it is
implemented *and* verified end-to-end on a real Linux kernel; see the dedicated note below.)

If you hit a rough edge in any of these, it's expected pre-1.0 — please file it.

## Linux portable gateway: implemented and end-to-end verified

The **headless portable Linux gateway is a shipped, verified target** (P3 series). The Linux
`PlatformServices` seam (`packages/runtime/src/platform/linux.ts`) is a concrete implementation —
login-shell `PATH` probe (`$SHELL -lic 'echo $PATH'`), `which`-style binary resolution with an
`X_OK` walk, and `bwrap` kernel confinement for the exec sources (fail-closed when `bwrap` is
absent). On Linux the source registry auto-gates the **active** first-party modules to the
portable allowlist `{workspace, sysinfo}`; the macOS-native sources (`apple-calendar`,
`apple-reminders`, `things`) and the exec sources stay **reserved-but-inactive** (advertised on
no platform where they can't run — never "advertised but dead").

This is not just code-verified: the full new-code flow — **managed workspace-dir multi-instance +
per-instance `approval:"ask"` posture + the demo onboarding loop** — has been run **end-to-end
against a real Linux kernel** in Docker (Ubuntu 22.04 + Bun, gateway state on a container-internal
`PLEXUS_HOME`, loopback-only bind). The re-runnable proof is `tests/docker-linux-e2e.sh`
(`bash run-tests.sh --gate linux-docker`, which SKIPs cleanly when Docker is absent); the operator
runbook is [`docs/deploy-linux.md`](deploy-linux.md). The verified path covers: `demo-intro.read`
flowing with no approval, `your-secret.read` **pending** under `approval:"ask"` → owner approve →
the fake secret returned → re-run pends again → owner deny → the agent receives an explicit
`DENIED` (exit 77), and the ADR-019 no-leak invariant (the admin connection-key never appears in
the agent's home).

## Managed workspace-dir + per-instance approval posture (P1a/P1b): deferred optimizations

These are performance/altitude follow-ups, not correctness or security gaps — behavior is
correct and covered by tests; the work is post-1.0:

- **`askSources` hot-path recomputation** — the authorizer's per-decision provenance/posture
  derivation clones the managed-source set (~3N per authorize); memoizable behind a revision
  counter but non-blocking, deferred to a later pass.
- **Onboarding step-4 double polling** — the "witness a call" step layers two 3s pollers
  (audit + grants/pending/sources); functional but wasteful, to be collapsed into one when the
  desktop live-event stream lands.
- **Posture layering unification** — `health()` / `askSources` / provenance each re-derive a
  source's posture from its config; a single `postureOf(source)` enum (the altitude-review
  direction) is the right consolidation but a larger refactor, deferred past 1.0.

## Task Grants (Mode-2 bundles): backend mechanism retained, no 1.0 UI or e2e (ADR-020)

Task Grants — the named bundle of standing grants pre-authorized to one agent — is **deliberately
hidden from the 1.0 admin console** (the concept was hard for new users and the composer's create
path could error). This is a *remove-the-UI, keep-the-mechanism* decision, the intended proto-ticket
for the [authorization-extensibility roadmap](design/adr/) (ADR-020), not a feature removal:

- The **backend is intact**: `POST`/`GET /admin/api/bundles`, the grant-service `bundleId`
  audit-stamping + `synthesizedFor` propagation (ADR-012/013), and the bundle backend tests
  (`tests/authz-ux-bundle.test.ts`) all stay. A bundle member persists as a normal standing grant.
- What is **not present in 1.0**: any console surface to create/list/revoke a bundle, and any
  UI-level e2e for that surface. A bundle member simply shows on the Standing Grants page as an
  ordinary standing grant; the Approvals page still renders a pended bundle request (the retained
  approval path). The client methods `api.bundles/createBundle/revokeBundle` are kept but unused.

Reintroducing the surface is a post-1.0 task, gated on the ticket lifecycle (open/close, task
boundary, ticket-level narration) that ADR-020 specifies.

## Realtime view is a best-effort live stream, not the authoritative ledger

The **Realtime** view (WHAT HAPPENED ▸ Realtime) is a live, animated projection of the management
event stream (`GET /v1/events`), reconciled against an initial `api.audit` snapshot. On mount and on
every reconnect it re-fetches the snapshot and merges by stable event id (dedup, sorted by time), so
the normal fetch/stream overlap drops nothing and doubles nothing. What it does **not** implement is
`Last-Event-ID` gap recovery: during a *long* disconnect (backoff climbs to 15s), a handful of events
that occurred and rolled out of the 200-event snapshot window before the reconnect-reconcile could
be missed from the animated stage. This is cosmetic — the **authoritative, append-only record is the
Activity page / the audit JSONL**, which the Realtime view never replaces. The stage caps its ledger
at 140 rows and is explicitly a "god's-eye glance", not a system of record.
