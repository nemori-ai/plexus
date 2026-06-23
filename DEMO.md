# Plexus v1 — End-to-End Acceptance Demo (t13)

This is the **acceptance proof**: both Plexus v1 scenarios working end-to-end
through the **real gateway**, driven by a real AI-agent protocol client speaking
only the published wire contract.

```
bun run examples/e2e-demo/run.ts
```

It boots a real Plexus gateway on a **concrete free loopback port** (`Bun.serve`,
`127.0.0.1`), registers the real **cc-master** first-party source and a real
**Obsidian vault** read-only source over throwaway temp fixtures, then drives the
t12 `PlexusClient` through both scenarios over real HTTP `fetch`, printing the full
transcript and a PASS / FAIL verdict. It exits `0` iff both scenarios pass.

The same engine (`runDemo()` in `examples/e2e-demo/demo.ts`) backs the acceptance
test `tests/e2e-demo.test.ts`, which asserts the genuine facts of each scenario.

Nothing here is staged. Every step goes through the published surface
(`.well-known` → `/link/handshake` → `/grants` → `/invoke`), the actual sources,
the actual transports, and the actual agent client. The denial cases really deny.

## Safety: the real `~/.claude` is never touched

cc-master's auto-install (`install()`) writes `enabledPlugins` + a marketplace into
`settings.json`. The demo pins that target to a **throwaway temp dir** via
`PLEXUS_CC_CLAUDE_DIR` (and isolates the gateway's own home via `PLEXUS_HOME`). The
real `~/.claude` is **never read or written**. All temp fixtures (temp `.claude`,
temp vault, temp gateway home) are removed in a `finally`.

---

## Scenario A — cc-master first-party orchestration (Flow A)

> The cc-master adapter auto-installs/enables the cc-master CC plugin and exposes
> its orchestration capability `cc-master.orchestration.run`; an agent discovers it
> via Plexus and can invoke it (with grant).

| Step | What runs | Acceptance criterion it proves |
|---|---|---|
| **A0 — auto-install** | `CcMasterSource.install()` merges `enabledPlugins["cc-master@cc-master"]=true` + the marketplace into the **temp** `settings.json`; called twice. | First-class, **idempotent**, audited auto-install (the 2nd call is a no-op). |
| **A1 — DISCOVER** | `GET /.well-known/plexus` | `cc-master.orchestration.run` is discoverable as a `workflow` costing `execute`. |
| **A2 — UNDERSTAND** | `POST /link/handshake` → full manifest | The workflow's full `describe` + `members[]` resolve to **present** registry entries (transitive grant targets are real). |
| **A2b — default-deny** | `POST /invoke` with no grant held | Un-granted invoke is **DENIED** `grant_required`. |
| **A3 — GRANTED** | `PUT /grants` (execute) | Mints the workflow `execute` scope **plus the synthesized transitive member scopes** (`board.create`/write, `agent.dispatch`/execute, `board.status`/read) — surfaced on the token. |
| **A4 — CALL** | `POST /invoke cc-master.orchestration.run` | The granted execute-token passes auth + scope-check and the **WorkflowTransport really fans out** through the uniform pipeline into the first member `cc-master.board.create`. |

### Honest boundary — Scenario A leaf execution

cc-master's board/agent operations (`board.create` / `agent.dispatch` /
`board.status`) execute **inside Claude Code** once the plugin is installed — they
have **no spawnable local binary** by design. This matches the canonical
`docs/protocol/examples/cc-master.orchestration.run.json` (members carry no `bin`)
and the source's own scope note in `src/sources/cc-master/entries.ts`.

So invoking `cc-master.orchestration.run` in the demo **genuinely** routes the
granted execute-token through the `WorkflowTransport` into its first member — the
real fan-out — and the leaf then reports it has no local binary
(`transport_error: cli: entry cc-master.board.create has no extras.route.bin`). The
demo proves the **whole protocol path** (discover → install → handshake →
grant(execute) + synthesized transitive scopes → invoke → real WorkflowTransport
fan-out) and surfaces this leaf boundary **truthfully** rather than faking a green
leaf. A green leaf would require a running cc-master plugin inside Claude Code,
which is out of scope for an offline gateway demo.

What this means for "the agent can invoke it": the agent **does** invoke
`cc-master.orchestration.run` end-to-end through the published protocol — auth,
scope-check, token, and the orchestrator transport all run for real. The only thing
that does not run locally is the in-Claude-Code leaf operation.

---

## Scenario B — Obsidian vault read-only (Flow B)

> One sentence opens an Obsidian vault READ-ONLY; the capability
> `obsidian.vault.read` is self-described, agent-discovered, and read-only
> grantable; an agent reads vault content.

| Step | What runs | Acceptance criterion it proves |
|---|---|---|
| **(setup)** | `openVaultExtension(vaultPath)` → `registerExtension(...)` | One call turns "open my vault read-only" into a self-describe `obsidian.vault.read` capability (`grants: ["read"]`). |
| **B1 — DISCOVER** | `GET /.well-known/plexus` | `obsidian.vault.read` is discoverable as a read-only `capability`. |
| **B2 — UNDERSTAND** | `POST /link/handshake` | The agent **self-selects** the capability by reading its `describe`; full `io` schema is present. |
| **B2b — default-deny** | `POST /invoke` with no grant | Un-granted read is **DENIED** `grant_required`; no note content leaks. |
| **B3 — GRANTED** | `PUT /grants` (read) | Mints a **read-only** scope (no write/execute). |
| **B4 — CALL** | `POST /invoke` (granted read) | Returns **REAL note content** + a real directory listing. |
| **B5 — read-only enforcement** | traversal read + write-grant request | A path-traversal read is **CONFINED** to the vault (`transport_error: confinement`); a **WRITE grant** on the read-only capability is **NOT minted**. |

Read-only is **enforced**, not merely advertised: the only code paths are
`readFile`/`readdir`, every path is confined to the vault root (lexical + realpath,
symlink-safe), and the entry declares only `["read"]` so no write/execute scope can
be minted.

---

## What "real" means here

- **Real gateway** — `createAppWithState(config)` + `Bun.serve` on a concrete free
  loopback port (never `port:0`, so the host-guard's `expectedHost` matches the
  bound authority).
- **Real protocol** — discover → handshake → grants → invoke over the published
  `.well-known` advertisement; the client presents the connection-key only at
  handshake and a short-lived scoped-token as `Bearer` on invoke.
- **Real sources** — the in-`MODULES` `CcMasterSource` and the `openVaultExtension`
  flow; no fakes, no stubs.
- **Real denials** — un-granted invoke (`grant_required`), path traversal
  (confinement `transport_error`), and a refused write grant all genuinely deny.

## Files

- `examples/e2e-demo/demo.ts` — the demo engine (`runDemo()`), boots the gateway and
  drives both scenarios; returns a structured `DemoReport`.
- `examples/e2e-demo/run.ts` — the runnable CLI entrypoint (real loopback socket).
- `tests/e2e-demo.test.ts` — the acceptance test asserting both scenarios PASS.

## Verify

```
bunx tsc --noEmit          # exit 0
bash run-tests.sh          # exit 0 — includes tests/e2e-demo.test.ts
bun run examples/e2e-demo/run.ts   # full transcript + OVERALL VERDICT: PASS
```
