# Plexus 1.0-rc acceptance玩法 — codex × claudecode × Obsidian

A TRUE end-to-end, user-perspective acceptance scenario that exercises the WHOLE
Plexus system through the **real** runtime pipeline (real handshake → real extension
register+approve → real grants+approve → real token mint → real invoke → real audit →
real revoke). It is **hermetic** and **repeatable**: temp `PLEXUS_HOME`, temp Obsidian
vault, an ephemeral loopback write-server, the gateway driven in-process (never binds
`:7077`), claudecode.run in record-only mode (no real `claude` spawn), and `claude` presence
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
   `notes-writer.vault.write` (write), and `claudecode.run` (execute). Any
   that pend are human-approved; tokens are minted.
5. **Content creation → write into Obsidian**:
   - Invoke `claudecode.run` to "create content" in **record-only mode**
     (`PLEXUS_CC_HEADLESS_LAUNCH` unset) — it assembles + audits the sandboxed command
     it **would** run, honestly reporting `launched:false`, `sandboxed:true`. No real
     `claude` spawn, fully offline.
   - Read existing context from Obsidian via `obsidian.vault.read`.
   - Compose the note deterministically (real headless gen is gated off for
     hermeticity — that's a separate manual smoke) and **WRITE** it into Obsidian via
     `notes-writer.vault.write` (real invoke, Bearer token). The file genuinely lands in
     the temp vault and is read back via `obsidian.vault.read`.
6. **Audit review** — `GET /admin/api/audit?limit=200` asserts the full chain is present
   and ordered sanely: `handshake`, `source.install` (the extension register),
   `grant.allow`/`grant.pending`, `token.issue`, and `invoke` events for the claudecode
   run, the obsidian read, and the vault write. A readable summary is printed.
7. **Revoke** — revoke the write grant via `POST /grants/revoke { jti }`, then re-invoke
   `notes-writer.vault.write` with the old token → it FAILS with **HTTP 401**
   `token_revoked`. The read token still works (only the write grant was revoked), and
   no file lands on disk — access is genuinely gone.

Interleaved through the happy path are **negative-authz beats** — deny-path probes through
the *same live pipeline* that prove the authz linchpin holds under **misuse**, not just the
happy path. Each is labeled `negative-authz` in the transcript and counted in the verdict:

- **`invoke-before-grant`** (step 3b) — invoking `notes-writer.vault.write` after it goes
  LIVE but *before any grant exists* → denied `grant_required`, no file on disk.
- **`revoked-token-replay-cross-capability`** (step 7b) — replaying the *revoked* write
  token on a **different**, still-granted capability (`obsidian.vault.read`) → still denied
  `token_revoked` (revocation is jti-keyed; a revoked token can't be laundered onto another
  cap).
- **`cross-capability-token-reuse`** (step 7b) — using a valid READ token on the write
  capability it was *never granted for* → denied `grant_required`, no file on disk.

## Run it

```bash
# Print the full transcript (the story):
bun run tests/harnesses/acceptance/run.ts

# Run it as part of the gate (headless, asserts every step):
bun test tests/acceptance-e2e.test.ts
# or the whole gate:
bash run-tests.sh
```

## What is "scripted" vs real

- **Real**: the gateway, the pipeline, the extension register/approve flow, grants,
  token mint, the local-rest transport, the obsidian-fs read source, the claudecode
  source (record-mode), the audit log, and the revoke + denial.
- **Scripted (the玩法 actors)**: the *codex agent* itself (`scenario.ts`, faithfully
  doing what codex would over the HTTP API) and the *human approvals* (a background loop
  approving pending items — modeling the user clicking "Approve").

## Notes / where this is intentionally simplified

- **claudecode.run is exercised in record-mode.** This玩法 proves the WIRING (the
  sandboxed command the bridge *would* run). The real sandboxed-launch behavior is
  covered by `tests/claudecode-run.test.ts` (record-mode argv assertions + a hermetic
  fake-`claude` shim under a real sandbox).
  - **Product vs. test split.** The shipped/dev **desktop app** defaults this gate
    **ON**: its runtime-sidecar supervisor (`packages/desktop/main/supervisor.js`)
    sets `PLEXUS_CC_HEADLESS_LAUNCH=1` in the child env, so the packaged + `electron .`
    app launches Claude Code for real. The runtime's **bare default**
    (`launcher.ts::headlessLaunchEnabled`) stays **OFF** for test/CI hermeticity —
    `bash run-tests.sh`, this acceptance e2e, CI, and a bare `bun run start` run the
    runtime directly (not through the supervisor) so they never inherit the flag. Set
    `PLEXUS_CC_HEADLESS_LAUNCH=1` manually to make a bare runtime launch for real.
- **The write backend is a loopback HTTP stand-in** for the user's local Obsidian-write
  service (the same `local-rest` transport the real Obsidian Local REST API uses). The
  real Obsidian Local REST API serves **HTTPS on loopback with a self-signed cert**; that
  real-shaped path (and the transport's loopback-only TLS relaxation) is covered by the
  tracked **HTTPS SMOKE** in `tests/local-rest-https-loopback.test.ts`, which drives
  `LocalRestTransport` against an ephemeral self-signed HTTPS `Bun.serve` on `127.0.0.1`.
- The `claude` binary is **faked at the platform seam** (`resolveBinary`) so the
  claudecode source surfaces as available without a real install — keeping the run hermetic.
