# Phase 2 — Cross-process wiring + harden: Implementation Plan

> Plan doc for the federated-mesh epic, phase 2. SSOT = `federated-mesh-domain-model.md`.
> Phase 1 spine works IN-PROCESS; a live demo revealed 2 cross-process seams unwired.
> **Ordered cross-process-FIRST**, then harden. Conform to the SSOT; cite the invariant/ADR.

## Why P2 exists (the demo finding)
The phase-1 spine (enroll/auth/forward/audit) already runs over a real socket between two
processes — but a TRUE 2-OS-process deployment can't complete because: (1) `mintJoinToken()`
has no out-of-process surface; (2) `onPrimaryInbound` returns "not handled" for `catalog`
frames, so a primary never mounts a *remote* proxy's catalog (e2e+demo mount in-process).

## Minimal 2-process subset = **A1 + A2 + A4**. (A3, B5–B7 not required for a single-proxy 2-host demo.)

## Task DAG (cross-process-first)
```
A1 mint ──[MIN-2P, ∥]                                  B5 L-1 ──[∥ isolated handshake.ts]
   │ (runtime getter + admin route + cli)
   ▼
A2 catalog ──[MIN-2P, SER:runtime.ts]
   │ (proxy pushCatalog on auth; onPrimaryInbound catalog→mountRemoteWorkload under
   │  the SOCKET-bound workload; re-push on delta; NO unmount on transient drop — Risk 1)
   ├──────────────┬───────────────────────────┐
   ▼              ▼                            ▼
A4 2-proc demo   A3 fanout ──[SER:runtime+tunnel]   (A4 ∥ A3 — disjoint files)
[MIN-2P]          │ (socket-per-workload map; forward(workload); L-2 cross-route refusal)
deps A1+A2        ├────────────┬──────────────┐
                  ▼            ▼               
              B6 revoke    B7 enc-knob
              [SER:runtime] [SER:tunnel]  (serialize B6→B7: both touch runtime.ts)
```

## Task cards (acceptance + tests on the board; deps name the consumed artifact)
- **A1 — Join-token mint surface** [MIN-2P, ∥]. `meshPublicKey` getter (runtime.ts); gated
  `POST /api/mesh/join-token` + `GET /api/mesh` (admin.ts); `packages/cli/src/mesh-commands.ts`
  + `plexus mesh mint` dispatch/help. Accept: `plexus mesh mint` prints token + UPSTREAM_URL/PUBKEY/WORKLOAD;
  409 on a proxy; mgmt-key gated. Additive.
- **A2 — Live catalog ascent** [MIN-2P, SER:runtime.ts] ← A1. `onAuthenticated` cb (tunnel MeshClient);
  `pushCatalog()`+subscribe re-push (startProxy); `catalog` branch in `onPrimaryInbound` mounting under
  **`server.authenticatedWorkload`** (NOT the untrusted payload workload). Accept: a connecting proxy
  auto-mounts `tenant/workload/<bare>` (hidden by default) with NO in-process mount call; forged-workload
  catalog mounts under the authenticated prefix only. **Risk 1: do NOT unmount on transient disconnect**
  (grants survive, Inv B; demo downtime depends on it) — unmount only on explicit withdraw + revocation.
- **A4 — True 2-OS-process demo** [MIN-2P] ← A1,A2. Rework `examples/mesh-demo` into a script that boots a
  primary, `plexus mesh mint`s a token, spawns a real proxy process, drives the agent via fetch. Accept:
  full spine across 2 real processes; kill proxy proc → `capability_unavailable`; restart recovers.
- **A3 — Multi-proxy fan-out** [SER:runtime+tunnel] ← A2. socket-per-workload map + `forward(workload,frame)`
  (MeshServer); `forwardInvoke` gates `authedWorkload===target.workload` (L-2). Per-connection workload
  identity threaded into onPrimaryInbound/audit (Risk 4). Accept: 2 proxies (A,B) concurrent; invoke to A
  never reaches B; independent downtime; keep single-proxy back-compat getters.
- **B5 — L-1 fix** [∥ isolated handshake.ts]. On `token_consumed` during enroll → `onEnrolled()`+`startAuth()`
  fall-through (pinned key still gates; imposter w/ consumed token still fails `not_enrolled`). Quick win.
- **B6 — Revocation** [SER:runtime.ts] ← A2,A3. `enrollment.revoke(workload)` tombstone; `unmountWorkload`
  (registry); `revokeWorkload()` orchestrator (unmount+grant-purge+socket-drop+resolution); admin route + cli.
- **B7 — Encryption knob (wss/TLS)** [SER:tunnel.ts] ← A3. `mesh.tls` config; `tls` into Bun.serve;
  **dual ws+wss listeners** (Risk 2 — phase-4 needs one enc-ON + one enc-OFF proxy concurrently); scheme-driven
  client; default-on. Ed25519 is the identity layer (Q2 identity⟂encryption) so self-signed-confidentiality is OK.
- **B8 — Coverage** continuous gate: mesh/ ≥90% after each task.

## Risks (full list in the dispatch log)
1. **No-unmount-on-transient-disconnect** (ADOPTED — keep mounted-but-unavailable; Inv B).
2. **ws+wss need 2 listeners** for the enc-on/off example (not a boolean).
3. **Self-signed wss cert trust** in Bun's WebSocket client — spike before B7.
4. **Per-connection workload identity** must thread through the mux handler under fan-out (A3 generalizes A2).
5. **`EnrollmentStatus` tombstone value** — confirm/add `"revoked"` in protocol.
