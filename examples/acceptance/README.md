# Plexus 1.0-rc acceptance玩法 — codex × cc-master × Obsidian

A TRUE end-to-end, user-perspective acceptance scenario that exercises the WHOLE
Plexus system through the **real** runtime pipeline (real handshake → real extension
register+approve → real grants+approve → real token mint → real invoke → real audit →
real revoke). It is **hermetic** and **repeatable**: temp `PLEXUS_HOME`, temp Obsidian
vault, an ephemeral loopback write-server, the gateway driven in-process (never binds
`:7077`), cc-master in record-only mode (no real `claude` spawn), and `claude` presence
faked at the platform seam so the run does **not** depend on a real `claude` install.

## The玩法 (the playthrough)

A user wires a **codex agent** into Plexus. Plexus ships an Obsidian vault **READ**
source — but **no write**. So:

1. **Setup** — a temp Obsidian vault (seeded with `Index.md` + `Daily/2026-06-23.md`)
   is registered as an `obsidian-fs` READ source via `POST /admin/api/sources`
   (`{ kind: "obsidian-fs", route: { vaultPath } }`).
2. **codex integrates** — `GET /.well-known/plexus` (discover) →
   `POST /link/handshake` (session + manifest) → reads the manifest.
3. **Create + stitch an extension (the key step)** — the codex agent **authors** an
   `ExtensionManifest` that adds a **vault WRITE capability** (`notes-writer.vault.write`,
   `grants: ["write"]`, `transport: "local-rest"`). It registers it via
   `POST /extensions { sessionId, manifest }`. Because it is transport-backed it
   **PENDS** (`grant_pending_user`); the human approves it (the harness's modeled-user
   approver, the same pending store `/admin/api/pending` reads) and it goes **LIVE**.
   The write backend is a tiny **loopback HTTP writing service** (`Bun.serve` on
   `127.0.0.1:0`, Bearer-authenticated) that stands in for the user's local
   Obsidian-write daemon: the capability `POST`s `{ path, content }` to `/write` and the
   server writes the file into the temp vault.
4. **Grants** — the agent requests `PUT /grants` for `obsidian.vault.read` (read),
   `notes-writer.vault.write` (write), and `cc-master.agent.dispatch` (execute). Any
   that pend are human-approved; tokens are minted.
5. **Content creation → write into Obsidian**:
   - Invoke `cc-master.agent.dispatch` to "create content" in **record-only mode**
     (`PLEXUS_CC_HEADLESS_LAUNCH` unset) — it records the dispatch on a real local board
     and returns the **argv it would run**, honestly reporting `agentExecution:"recorded"`,
     `launched:false`. No real `claude` spawn, fully offline.
   - Read existing context from Obsidian via `obsidian.vault.read`.
   - Compose the note deterministically (real headless gen is gated off for
     hermeticity — that's a separate manual smoke) and **WRITE** it into Obsidian via
     `notes-writer.vault.write` (real invoke, Bearer token). The file genuinely lands in
     the temp vault and is read back via `obsidian.vault.read`.
6. **Audit review** — `GET /admin/api/audit?limit=200` asserts the full chain is present
   and ordered sanely: `handshake`, `source.install` (the extension register),
   `grant.allow`/`grant.pending`, `token.issue`, and `invoke` events for the cc-master
   dispatch, the obsidian read, and the vault write. A readable summary is printed.
7. **Revoke** — revoke the write grant via `POST /grants/revoke { jti }`, then re-invoke
   `notes-writer.vault.write` with the old token → it FAILS with **HTTP 401**
   `token_revoked`. The read token still works (only the write grant was revoked), and
   no file lands on disk — access is genuinely gone.

## Run it

```bash
# Print the full transcript (the story):
bun run examples/acceptance/run.ts

# Run it as part of the gate (headless, asserts every step):
bun test tests/acceptance-e2e.test.ts
# or the whole gate:
bash run-tests.sh
```

## What is "scripted" vs real

- **Real**: the gateway, the pipeline, the extension register/approve flow, grants,
  token mint, the local-rest transport, the obsidian-fs read source, the cc-master
  source + board ops, the audit log, and the revoke + denial.
- **Scripted (the玩法 actors)**: the *codex agent* itself (`scenario.ts`, faithfully
  doing what codex would over the HTTP API) and the *human approvals* (a background loop
  approving pending items — modeling the user clicking "Approve").

## Notes / where this is intentionally simplified

- **cc-master is exercised in record-mode.** The real headless `claude --plugin-dir
  <embedded cc-master> -p ...` launch is gated behind `PLEXUS_CC_HEADLESS_LAUNCH=1` and
  is a separate manual smoke (it needs a real `claude` + network). Here the dispatch is
  recorded on a real board and returns the exact argv it would run.
- **The write backend is a loopback HTTP stand-in** for the user's local Obsidian-write
  service (the same `local-rest` transport the real Obsidian Local REST API uses). A
  real-Obsidian variant would point `route.baseUrl` at the actual plugin.
- The `claude` binary is **faked at the platform seam** (`resolveBinary`) so cc-master's
  orchestration surface appears without a real install — keeping the run hermetic.
