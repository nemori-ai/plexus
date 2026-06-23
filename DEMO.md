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
| **A4 — CALL** | `POST /invoke cc-master.orchestration.run` | The granted execute-token passes auth + scope-check, the **WorkflowTransport really fans out** through the uniform pipeline across **all three members**, and the leaf runs for real: `cc-master.board.create` **creates a real board JSON on disk** (`<temp .claude>/cc-master/<boardId>.json`). The demo reads that board file **back off disk** — a **genuinely green leaf**, not a trusted return value. |

### Honest green leaf — Scenario A board operations

A cc-master orchestration board is a **plain local JSON file** at
`<claudeDir>/cc-master/<boardId>.json`, and its board primitives are **genuine local
operations that do not need the LLM**. The three workflow members run as **real
in-process operations** (gateway-owned code in `src/sources/cc-master/board.ts`,
served by `CcMasterBridge` — the same in-process-handler pattern as the Obsidian
vault read), so invoking the workflow returns **`ok:true` honestly**:

- **`board.create`** — creates (or idempotently re-opens) the board JSON, seeding a
  root node. The demo asserts the green leaf by **reading the board file back off
  disk** and checking its `kind`/`boardId`/`goal` — never by trusting the return.
- **`board.status`** — reads that board file and returns a real status summary
  (node counts, whether the orchestration is underway).
- **`agent.dispatch`** — records a real `dispatched` node on the board (a genuine,
  readable board mutation) with `execution: "pending"`.

So invoking `cc-master.orchestration.run` with a granted execute token routes
through the `WorkflowTransport`, fans out across all members, and produces a **real,
file-verifiable board** — the whole protocol path (discover → install → handshake →
grant(execute) + synthesized transitive scopes → invoke → real fan-out → **real
board op**) goes green honestly.

**The one honest boundary (`agent.dispatch`).** Offline, we do **not** spawn a real
background agent — that would be a fake green. The full LLM-driven agent run happens
**inside Claude Code** once cc-master is loaded. So `agent.dispatch` performs only
the real, verifiable **local** half of a dispatch (recording the dispatch node +
intent on the board) and **defers the actual agent execution to Claude Code**
(`deferredTo: "claude-code"`, `agentExecution: "deferred"`). It never claims to have
run an agent it did not run.

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
  flow; no fakes, no stubs. cc-master's board members run **real local board ops**
  on an on-disk JSON board.
- **Real denials** — un-granted invoke (`grant_required`), path traversal
  (confinement `transport_error`), and a refused write grant all genuinely deny.

## Files

- `examples/e2e-demo/demo.ts` — the demo engine (`runDemo()`), boots the gateway and
  drives both scenarios; returns a structured `DemoReport`.
- `examples/e2e-demo/run.ts` — the runnable CLI entrypoint (real loopback socket).
- `src/sources/cc-master/board.ts` — the real local board primitives (create / status
  / dispatch-record) on an on-disk JSON board.
- `src/sources/cc-master/bridge.ts` — `CcMasterBridge`: serves the three members via
  those in-process board ops (workflow + skills take the standard base path).
- `tests/e2e-demo.test.ts` — the acceptance test asserting both scenarios PASS.
- `tests/ccmaster-board.test.ts` — asserts the real board ops (read back), green-leaf
  members, idempotent create, and scan-gating.

## Verify

```
bunx tsc --noEmit          # exit 0
bash run-tests.sh          # exit 0 — includes tests/e2e-demo.test.ts
bun run examples/e2e-demo/run.ts   # full transcript + OVERALL VERDICT: PASS
```
