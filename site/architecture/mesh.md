---
title: The federated mesh
description: The developer model of the Plexus federated mesh — one primary gateway, many dial-out proxies, provenance-as-address, and the enrollment / tunnel / invoke-forward machinery that binds them.
---

# The federated mesh — developer model

::: tip Status
**Implemented** (the P1–P5 mesh epic). This is the operator/extender companion to
the DDD SSOT
[`federated-mesh-domain-model.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/federated-mesh-domain-model.md):
where that doc defines the *language + invariants*, this one maps every load-bearing
invariant onto the **code that enforces it**, cites `file:line`, and tells you where
to hook in. When the two disagree, the code wins and this doc notes it (§13).

Code root for everything below: `packages/runtime/src/mesh/` unless another path is
given.
:::

## Mental model in 5 sentences

1. A **mesh** is exactly one `primary` gateway (the agent's front door — it holds grants, runs
   the authorizer, sinks audit) and any number of `proxy` gateways that live next to real
   services and **dial out** a single persistent tunnel to the primary (NAT-forced: no inbound
   hole on a proxy host).
2. A proxy **enrolls once** with a 256-bit one-time join token that the primary minted
   out-of-band; enrollment pins the proxy's Ed25519 public key into a durable ledger
   (`enrollments.json`) and the token *is* the anti-replay nonce.
3. Every reconnect re-proves identity with an **Ed25519 mutual challenge** over the tunnel;
   only an authenticated socket is *promoted* to carry data frames, and the proxy trusts any
   `invoke` arriving on that socket as **already authorized** (the primary is the authority —
   tunnel-trust).
4. A proxy advertises **bare `source.capability` ids**; the primary **mounts** them under
   `tenant/workload/…` to form the stable **address** (identity), while health/reachability is
   a mutable **route** fact — so grants bind to addresses and survive reconnects, downtime, and
   failover.
5. An agent `invoke` on the primary for a mounted address is **forwarded down** that workload's
   tunnel, executed against the bare id, and returned origin-agnostically; if the home is down
   the caller gets a typed `capability_unavailable` (never a hang), and revoking a workload
   tombstones its enrollment + unmounts + purges grants + drops the socket in one ordered cascade.

## 1. Topology & roles

![The federated mesh — proxies each tunnel up to one primary](/diagrams/mesh-topology.png)

```
            AGENT (Claude Code / Codex)
              │  connection-key / HS256 JWT   ← trust boundary ①  (UNCHANGED by the mesh)
              ▼
        ┌───────────────┐   HTTP :7077 (agent surface) + admin
        │    PRIMARY    │   holds grants · runs authorizer · audit sink · resolution table
        │  (authority)  │   MAY ALSO bear its own local workload (0-source is just the minimal case)
        └───────┬───────┘
      ws / wss  │  second listener (the "tunnel acceptor") — the proxy DIALS this
   ┌────────────┼───────────────┐   trust boundary ②  (Ed25519 mutual auth — NEW)
   ▼            ▼               ▼
┌────────┐  ┌────────┐     ┌────────┐
│ PROXY  │  │ PROXY  │ …   │ PROXY  │   each bears local sources, keeps a local exposure veto +
│  (m1)  │  │  (m2)  │     │ egress │   local audit, and DELEGATES authorization UP the tunnel
└────────┘  └────────┘     └────────┘
```

**Two orthogonal axes** (SSOT §0, Invariant A). *Authority mode* (`primary` | `proxy`) is decided
at boot and immutable; *workload-bearing* (do I expose local caps?) is runtime and independent. A
primary may bear its own workload; a proxy may bear none (a pure "egress" router). The mode split
in code is a single boot branch:

- Mode is parsed from `PLEXUS_MODE` in `config.ts:593` (`loadMeshConfig`), defaulting to
  `"primary"`; an unknown value or `proxy` without `PLEXUS_UPSTREAM_URL` **fails fast**
  (`config.ts:601`, `config.ts:615`).
- `MeshRuntime.start()` branches once: `runtime.ts:534` → `startPrimary()` (`runtime.ts:556`,
  binds the acceptor) vs `startProxy()` (`runtime.ts:933`, dials out). Everything downstream is
  wired inside those two methods; the two modes share no live socket wiring.

**Configuring a node (env contract).** All read in `config.ts`:

| Var | Meaning | Read at |
| --- | --- | --- |
| `PLEXUS_MODE` | `primary` \| `proxy` (default primary) | `config.ts:593` |
| `PLEXUS_TENANT` | address top segment (default implicit `local`) | `config.ts:605` |
| `PLEXUS_WORKLOAD` | this gateway's workload name (proxy declares at enroll) | `config.ts:606` |
| `PLEXUS_UPSTREAM_URL` | proxy → which primary to dial | `config.ts:607` |
| `PLEXUS_UPSTREAM_PUBKEY` | proxy → the primary's **pinned** Ed25519 key (M1, mandatory) | `config.ts:611` |
| `PLEXUS_JOIN_TOKEN` | proxy → one-time admission token (first join only) | `runtime/serve.ts:95` |
| `PLEXUS_MESH_TUNNEL_HOST` / `_WS_PORT` / `_WSS_PORT` | primary tunnel bind (default loopback + ephemeral ws) | `config.ts:539–541` |
| `PLEXUS_MESH_TLS_CERT` / `_KEY` | primary wss TLS material | `config.ts:542–543` |
| `PLEXUS_MESH_REQUIRE_ENCRYPTION` | primary refuses plain-ws proxies (default off) | `config.ts:544` |

## 2. Enrollment — the one-time join token

Enrollment is the **second trust boundary** and is security-critical (`enrollment.ts:1–43`). It is
fully separate from the agent↔primary HS256 wire. All of it is default-deny / fail-closed: any
malformed frame, bad/expired/reused token, or bad signature **admits nothing and persists nothing**.



```
 PROXY                                             PRIMARY (authority)
 ─────                                             ───────────────────
 (operator runs `plexus mesh mint` →)             mintJoinToken()  → raw 256-bit token
        one-time token delivered OUT-OF-BAND  ◄──  (only sha256(token) ever hits disk)
 buildEnrollRequest(payload, proxyKey)             admit(request, primaryIdentity):
   sign role-tagged transcript  ──{payload,sig}─►   1. claim shape · pubkey importable · mode==proxy
                                                     2. token: replay? → unknown? → expired? → valid
                                                     3. proxy sig verifies (proves key ownership)
                                                     4. workload UNIQUE + active (Inv F)
                                                     5. PIN proxyPubKey, persist active record +
                                                        ZERO-EXPOSURE marker, consume token (fsync)
   verifyEnrollAccepted(...)   ◄──{ok,primaryPubKey,sig}─  primary signs the SAME transcript (mutual)
     verify primary sig + enforce the primary-key PIN
```

- **Token = nonce, single-use.** Each token is fresh 256-bit entropy (`enrollment.ts:377–378`)
  bound into the signed transcript (`enrollment.ts:167–176`), so a signature/response from one
  handshake can't be replayed into another. Consumption is atomic on the success path
  (`enrollment.ts:472–474`); a replay is caught by the `consumed` set
  (`enrollment.ts:427`). Only the **hash** is persisted (`enrollment.ts:186`, comment 36).
- **Admission order is deliberate and fail-closed** — checks 1–5 at `enrollment.ts:404–493`; the
  token is consumed and the record written **only** after every check passes.
- **Durable-before-admit (L1).** The consume+pin is `fsync`'d before success is reported
  (`persistDurable`, `enrollment.ts:366–368`, called at `481`); a write failure **rolls back** the
  in-memory mutation and returns `persist_failed` (`enrollment.ts:482–487`) so a one-time token can
  never silently resurrect after a lost write + reload.
- **Zero-exposure entry (Q3).** An admitted workload's caps default **hidden** — `exposureDefault:
  "hidden"` on the record (`enrollment.ts:468`), so *join ≠ access*: exposure + grant still gate.
- **The durable ledger** is `~/.plexus/mesh/enrollments.json`, `0600`, atomic write
  (`enrollment.ts:565–570`, `350–358`). Records are keyed by workload (uniqueness index, Inv F —
  `enrollment.ts:287`).
- **Minting surface.** In-process authority is `EnrollmentRegistry.mintJoinToken`
  (`enrollment.ts:377`); the operator reaches it via `POST /admin/api/mesh/join-token`
  (`core/admin.ts:940`, primary-only 409 otherwise) which also returns the tunnel endpoints +
  primary pubkey so the proxy env can be assembled in one step. The `plexus mesh mint` CLI drives
  that route (`packages/cli/src/mesh-commands.ts`; contract in `tests/mesh-cli-mint.test.ts`).

::: info Lineage note (worth knowing)
This one-time-token→redeem→pinned-identity+durable-ledger primitive is the pattern the later
**agent-PAT enrollment** reused (the agent↔primary side has its own `agentEnrollment.revoke`
tombstone path, `core/admin.ts:691`). The mesh enrollment is the original; the shape
(token-is-nonce, single-use, tombstone-not-delete) is deliberately shared.
:::

## 3. Tunnels & transport

The tunnel is a **single persistent WebSocket the proxy dials out** (SSOT §7 transport premise).
Enrollment, catalog push, invoke-forward, audit bubble-up and health all multiplex over it. Code:
`tunnel.ts` (client + server + mux), framing in `frames.ts`.

- **Framing.** Every multiplexed message is a `Frame` from `@plexus/protocol`, JSON-encoded
  newline-free (`frames.ts:32`), decoded fail-safe — a malformed frame throws and the hot path
  catches-and-drops so one garbage frame can't wedge the mux (`frames.ts:59–70`). Correlation ids
  (`newCorr`, `frames.ts:73`) key request/reply. The `FrameMux` pending map is keyed by `corr`
  (`tunnel.ts:144–145`); `request()` stamps + sends (`tunnel.ts:175`), `dispatch()` matches a reply
  to its waiter or routes an inbound request to `onRequest` (`tunnel.ts:202–226`).
- **ws vs wss (dual listener).** The `MeshServer` (`tunnel.ts:345`) always binds a plain-`ws`
  acceptor (`tunnel.ts:438`) and *additionally* a `wss` acceptor when TLS + a wss port are
  configured (`tunnel.ts:439–446`). Both spread the **same** connection handlers.
- **Encryption policy — `encrypted` is unforgeable.** The flag is not read off the socket; it is
  baked into which listener accepted the connection: `buildHandlers(false)` for ws vs
  `buildHandlers(true)` for wss (`tunnel.ts:438,444`; signature `tunnel.ts:557`), threaded into the
  handshake driver at `tunnel.ts:572`. When `requireEncryption` is set, a non-encrypted connection
  is refused at the **first** handshake message with typed `encryption_required`, *before* any
  admit/pin and *before* the token is consumed (`handshake.ts:399–405`) — so the operator can retry
  the same token over wss. `enc-off` (default) keeps plain ws working (back-compat, SSOT Q8). Config
  fails fast if `requireEncryption` is set without TLS (`config.ts:564`).
- **Reconnect resilience** (client, `MeshClient` `tunnel.ts:870`):
  - Exponential backoff, hard-capped: `backoffMs = min(backoffMs*2, max)` (`tunnel.ts:1181`),
    initial 50ms / max 2000ms (`tunnel.ts:53–54`), **equal-jitter** delay `raw/2 + rand·raw/2`
    (`tunnel.ts:1183`). Backoff **resets on READY (authenticated), not on socket open**
    (`markReady`, `tunnel.ts:1044–1045`; the open handler explicitly does not, `tunnel.ts:962–963`)
    — so a rejected/plain-ws/revoked proxy doubles toward the cap instead of storming.
  - Heartbeat: proxy sends a correlated `ping` (or a `health` frame when negotiated) every
    ~15s with a 5s deadline (`tunnel.ts:56–57,1060–1071`); a missed pong calls `forceReconnect()`
    (`tunnel.ts:1077`) which closes the socket → `handleDown` (`tunnel.ts:1158`) → backoff redial.
    This converts a silent half-open socket into an observable drop.
  - Primary-side idle teardown: `lastSeen` bumped on every inbound frame (`tunnel.ts:627`); a
    connection silent past ~3× the proxy interval is swept + torn down firing `onDisconnect`
    (`tunnel.ts:529–533`) so the resolution table stamps it unavailable promptly.
- **TLS hot-reload.** `reloadTls()` (`tunnel.ts:463`) stops + re-serves only the wss listener; on a
  failed rebind it **rolls back** to the previous known-good material (`tunnel.ts:489–492`), and if
  rollback also fails it lands in a consistent DOWN state and rethrows loudly (`tunnel.ts:495–498`).
  The ws listener + HTTP plane are untouched. Rotation procedures in
  [`encryption-policy.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/encryption-policy.md) §2.

## 4. Handshake & trust

The raw mux is identity-agnostic; `handshake.ts` is the gate that authenticates the socket before a
single data frame is honored (`handshake.ts:1–43`). It is driven opaquely by the tunnel via a
`HandshakeDriver` (`handshake.ts:135`); all crypto lives in `handshake.ts`, none in `tunnel.ts`.

Two legs, run lock-step by the dialing proxy (NAT-forced — the proxy speaks first,
`handshake.ts:382`):

```
 leg 1 (first join only, token in hand):
   proxy → enroll { SignedEnrollRequest }        primary runs LIVE admit() (handshake.ts:409–412)
   primary → enroll-result { EnrollOutcome }      proxy enforces the primary-key PIN (M1)
 leg 2 (EVERY connect — binds THIS socket):
   proxy   → auth-init      { workload, cnonce, healthReporting? }
   primary → auth-challenge { snonce, sig_primary, healthReporting? }   sig over (workload,cnonce,snonce)
   proxy   → auth-response  { sig_proxy }
   primary → auth-ok        → socket PROMOTED
```

- **How a node proves identity.** Fresh per-connection nonces make each transcript unique
  (`authSignedBytes`, `handshake.ts:177`), so a captured signature can't authenticate a different
  socket. The primary verifies `sig_proxy` against the **ledger-pinned** key
  (`pinnedProxyPubKeyFor`, wired `runtime.ts:613`; verify `handshake.ts:447`); an unenrolled /
  revoked workload has **no pin** → `auth-fail not_enrolled` (`handshake.ts:443–445`). The proxy
  verifies `sig_primary` against its **mandatory** pinned `upstream.primaryPubKey`
  (`handshake.ts:304–311`) — no bare-TOFU: the driver refuses to even start without it
  (`handshake.ts:218–223`, echoed at `runtime.ts:942`).
- **Promotion.** Only a `done` step promotes the socket to carry frames: server side deletes the
  pending handshake and `register()`s the connection + fires `onConnect` (`tunnel.ts:617–619`); a
  frame arriving on a non-promoted gated socket is closed (`tunnel.ts:631–637`).
- **Handshake reaper (DoS guard).** The idle sweep only sees *promoted* connections. An accepted
  socket that stalls mid-handshake lives in the unauthenticated `handshakes` set; the same sweep
  reaps any entry not promoted within `handshakeDeadlineMs` (default ~10s, `tunnel.ts:64,534–546`),
  closing the socket without firing `onDisconnect` (it was never a workload). Disable with
  `handshakeDeadlineMs:0`. See `tests/mesh-handshake-reaper.test.ts`.
- **A subtle survivability detail (L-1).** A *lost* `enroll-result` after the token was already
  consumed by a prior join is **not fatal**: the proxy sees `token_consumed`, treats itself as
  enrolled, and falls through to the challenge leg, which re-proves against the ledger-pinned key
  (`handshake.ts:274–287`). An imposter that never enrolled has no pin, so its challenge still fails
  closed. All *other* reject reasons stay fatal.

## 5. Capability addressing & catalog (provenance-as-address)

**Grammar** (`addressing.ts` is the one place it's constructed/inverted, `addressing.ts:1–23`):

```
  tenant / <workload-path…> / source.capability
    └ '/' separates LOCATION segments (tenant + variable-depth workload path)
    └ '.' separates the source.capability TAIL — today's bare CapabilityId
```

- **Address is identity; route is location** (Invariant B). The address is the join key that grants
  + audit bind to across every lifecycle stage; a bare id never contains `/`, so the location prefix
  and the bare tail are cleanly separable (tail = everything after the last `/`).
- **Primary mount / NAT-for-names (Q4, Invariant F).** A proxy is **workload-agnostic on the wire**:
  it pushes only bare ids and never embeds its own mesh name, so it's renamable/relocatable without
  redeploy. `mountAddress(tenant, workload, bareId)` prepends the prefix **once** on ascent
  (`addressing.ts:53–68`, throws on a non-bare id — fail-closed against double-mount);
  `forwardTranslate(address)` recovers the bare id **once** at the forward boundary
  (`addressing.ts:79–82`). Round-trip law: `forwardTranslate(mountAddress(t,w,bare)) === bare`.
- **Catalog ascent / cascade** (`catalog.ts`). The proxy builds a `catalog` frame with bare
  entries — `buildCatalogPush` asserts every id is bare, fail-closed (`catalog.ts:41–63`). The
  primary applies it via `applyCatalog` → `registry.mountRemoteWorkload` (`catalog.ts:81–91`), which
  mounts under `tenant/workload/`, marks them `transport:"mesh"`, defaults them **zero-exposure /
  hidden**, and bumps the registry revision.
- **Live ascent + deltas.** On **every** authenticated (re)connect the proxy re-pushes its full
  catalog (`onAuthenticated → pushCatalog`, `runtime.ts:986,1021`); it also pushes deltas as its
  local set changes (`pushCatalogDelta`, `runtime.ts:1040`) — `added/updated` as `entries`,
  `removed` as `withdrawn` (the **only** legitimate un-mount path besides revoke; a transient drop
  never unmounts — Risk-1).
- **Anti-forgery on mount.** The primary mounts under the **socket-bound authenticated workload**,
  never `frame.payload.workload` (`runtime.ts:796–809`) — a forged payload workload is ignored.
- **v1 depth cap.** The grammar is variable-depth (`parseAddress` tolerates a multi-segment workload
  path, `addressing.ts:98–107`); the operational convention caps depth at 1 via enrollment policy,
  not grammar, so deeper topologies never force an address migration. Depth >1 (regional
  delegation, a `primary` behind a `primary`) is explicitly out of scope for v1 (SSOT §6).

::: info Cross-reference
This is the `provenance-as-address` capability-addressing model — address=identity (URN),
route=location (URL), glob=scoped-grant grammar, cascade=mount/NAT-for-names.
`tests/mesh-catalog-ascent.test.ts`, `tests/mesh-catalog.test.ts` pin the contracts.
:::

## 6. Resolution & invoke forwarding

**Through-the-primary equivalence (Q1).** The agent talks only to the primary; a mounted address is
invoked exactly like a local one and the caller can't tell the origin. Data-plane passthrough is
*structurally required* (not a convenience): content-aware approval needs the authority to see the
payload before execution.

The forward path (`runtime.ts` primary forward boundary `runtime.ts:869–929`; `transports/mesh.ts`
wiring):

```
 POST /invoke (primary, mounted address)
   → mesh transport resolves address → { workload, bareId }  via registry.forwardAddress
       (resolveTarget, transports/mesh.ts:82)
   → forwarder.isEnrolledDestination(workload)?   PIN the target — active enrollment only,
       (runtime.ts:871; transports/mesh.ts:146)    no SSRF via a mutable mounted route
   → forwardInvoke(target, address, input, correlationId)   (runtime.ts:877)
       builds invoke frame: FULL address (audited URN) + BARE id (proxy executes) + correlationId
       (runtime.ts:895–904)
   → server.forward(workload, frame)  routes DOWN exactly that workload's socket (runtime.ts:911)
   ─────────────────── over the tunnel ───────────────────►
   PROXY onProxyInbound → executeForwardedInvoke (runtime.ts:1085,1123)
       runs the BARE id through the proxy's OWN InvokePipeline under a synthetic
       TUNNEL-TRUST context (mintTunnelTrustContext, runtime.ts:1132): grant/scope/session
       SKIPPED (primary already authorized — Inv E), but local EXPOSURE VETO + schema/health
       gates + local AUDIT still run (Inv C)
   ◄─────────────── invoke-result (verbatim InvokeResponse) ──
```

- **No replica/failover.** A capability has exactly one home (its workload). "Unavailable" means
  that home is down — the accurate signal, not a DR story.
- **Never a hang (Invariant E).** A `forward` to a down/absent proxy rejects
  (`MeshDisconnectedError`/`MeshTimeoutError`), caught at `runtime.ts:912–921` and turned into a
  typed `capability_unavailable` carrying `unavailableSince` (how long down). A forward timeout
  itself stamps the resolution unavailable so subsequent reads agree (`runtime.ts:917`).
- **Tunnel-trust ingress is unforgeable.** The auth-skip rides a *module-private brand* mintable only
  in `executeForwardedInvoke`; the agent HTTP surface cannot forge it (`runtime.ts:1107–1140`). A
  locally-disabled cap still returns `capability_unexposed` even on the trust path
  (`runtime.ts:1149–1157`) — exposure is the resource-owner's veto and always runs.
- `tests/mesh-invoke-forward.test.ts` proves forward + bare-on-wire + pinned-destination; the
  multiproxy fan-out (invoke for A can never reach B's socket) is `tests/mesh-multiproxy.test.ts`.

## 7. Health reporting (bidirectional, negotiated)

The primary tracks **two** health facts per workload and resolves route-first:

1. **Route** (coarse, `ResolutionTable`, `resolution.ts`). `markAvailable` on socket promotion,
   `markUnavailable` on drop/close/timeout (`resolution.ts:72–90`), keyed by workload. `unknown` =
   *never observed* — no socket has ever connected for this workload (`resolution.ts:42–43`).
   `unavailableSince` is stamped once and preserved across redundant down-signals
   (`resolution.ts:82–90`).
2. **Report** (fine, `MeshHealthStore`, `mesh-health.ts`). The proxy's aggregated per-source health,
   pushed up.

- **Negotiated at registration**, on the challenge leg so it re-runs every (re)connect
  (`negotiateHealthReporting`, `handshake.ts:120–127`): enabled **iff both** peers advertise a
  structurally-valid `{version, intervalMs}`; `version=min`, `intervalMs=max`, clamped to
  `MAX_NEGOTIATED_INTERVAL_MS` (60s, `handshake.ts:90`) so a peer can't push the stale window
  arbitrarily high. A malformed/partial advert is treated as *no advert* (fail-closed against a
  `setInterval(…, NaN)` flood, `handshake.ts:100–110`).
- **Reuses the heartbeat, no second timer.** When negotiated, the proxy's liveness beat sends a
  `health` frame *instead of* a bare `ping` (`tunnel.ts:1090–1107`); an initial snapshot fires on
  authenticated connect and an on-change push when a local source flips
  (`reportHealthNow`, `runtime.ts:998`). Primary→proxy is symmetric (cascade + downward liveness),
  `startPrimaryHealthLoop` `runtime.ts:676`.
- **Anti-forgery.** `record(workload, payload)` keys on the socket-bound authenticated workload,
  ignoring `payload.reporter` (`mesh-health.ts:12`, `runtime.ts:774–780`). A proxy that forges
  `reporter:"other"` only ever updates its own health.
- **Resolution precedence** (`stateFor`, `mesh-health.ts:160–199`): route `unavailable` wins (row 1,
  Inv E) → no report yet ⇒ `connecting` → stale (older than `interval×3`) ⇒ `stale` → else the
  report's aggregate (`down`/`degraded`/`ok`). The wire `HealthStatus` stays the frozen 4-state;
  finer distinctions ride in `detail` (`mesh-health.ts:221`).
- **"unknown" specifically** surfaces two ways: the route `unknown` (never-connected workload,
  `resolution.ts:43`), and the wire mapping of `connecting` → `status:"unknown"`
  (`mesh-health.ts:234`). Every mesh-sourced health value is stamped **`reported:true`**
  (`mesh-health.ts:213–224`) — it is the remote home's *unverified self-assertion* relayed over the
  tunnel, never something the primary probed; it stays advisory (route/resolution gates invoke, not
  the report). Reconnect-epoch handling (a restarted proxy's seq resets to 1 without wedging
  recovery) is `beginConnection` + the epoch-scoped seq gate (`mesh-health.ts:113–116,133–149`).
- Surfaced at `GET /admin/api/mesh` `workloads[]` (`core/admin.ts:919–935`).

## 8. Revocation & audit cascade

**Whole-workload revoke (B6)** — `revokeWorkload` (`runtime.ts:733–751`), reachable via
`POST /admin/api/mesh/revoke` (primary-only, `core/admin.ts:1000`). The order is load-bearing and
runs the *terminal, throwing* step first so nothing half-revokes:

```
 1. TOMBSTONE   enrollment.revoke(workload)  → flip record to terminal "revoked" (fsync; THROWS
                on a failed durable write, BEFORE anything destructive)   runtime.ts:735
 2. UNMOUNT     capabilities.unmountWorkload(workload) → remove its addresses  runtime.ts:737
 3. PURGE       grants.removeForCapability(address) for each unmounted addr    runtime.ts:740–741
 4. DROP        server.dropConnection(workload) → close the live socket        runtime.ts:744
 5. STAMP       resolutionTable.markUnavailable + stop primary→proxy health    runtime.ts:747
```

- The tombstone is what makes revoke **terminal**: `isActive` / `pinnedProxyPubKeyFor` /
  `isEnrolledDestination` all gate on `status==="active"` (`enrollment.ts:541`,
  `runtime.ts:632–634,874`), so a reconnect with the old pinned key finds no pin → `not_enrolled`,
  and the forward boundary refuses it. The row is tombstoned, **never deleted**
  (`enrollment.ts:511–526`), so a replayed/stale token can't resurrect a revoked workload.
- **Idempotent.** Unknown / already-revoked workload → `tombstoned:false` but steps 2–5 still run
  as no-ops. Per-*grant* revocation of a single mounted address stays on `POST /api/revoke`
  (`core/admin.ts:509`) and leaves the enrollment + mount + tunnel intact
  (`tests/mesh-revocation.test.ts` case e).
- **`dropConnection` vs teardown.** Revocation drops the socket with `fireDown=false`
  (`tunnel.ts:721`) — the workload is being revoked, not merely disconnected, so it doesn't re-run
  the transient-drop path.

**Audit cascade (Invariant D).** Each gateway's local log is authoritative for its own caps; the
primary keeps a full **redacted mirror** for single-pane audit, and the bubble-up never blocks the
hot path:

- Proxy subscribes to its own audit write path and bubbles a copy up the tunnel as an `audit` frame,
  fire-and-forget + fully swallowed (`bubbleAudit`, `runtime.ts:1066–1074`; wired
  `runtime.ts:1006–1008`).
- Primary mirrors it best-effort: `mirrorProxyAudit` (`runtime.ts:833–851`) re-stamps
  authority-owned metadata (`tier:"proxy"`, the socket-bound originating workload — **never** trusted
  from the payload) and writes through the **same redactor** both tiers run, so the mirror can never
  reveal more than the proxy's local log. A mirror-write failure is swallowed and never delays the
  ack (`runtime.ts:848–850`).
- The `correlationId` threads the primary's edge-span to the proxy's workload-span (distinct from the
  per-frame mux `corr`) — passed into the invoke frame (`runtime.ts:902`) and the tunnel-trust
  context (`runtime.ts:1139`). `tests/mesh-audit-cascade.test.ts` proves same-redactor + shared
  correlationId + a broken bubble never blocking the invoke.

## 9. Confinement (in scope; two independent appliances)

Neither is on the mesh wire, but both are how a proxy safely *bears a workload*.

- **Linux exec confinement (`bwrap`).** `platform/sandbox-backend.ts` abstracts "run this exec
  command confined to these paths" behind `SandboxBackend`; `DarwinSandboxBackend` wraps the
  unchanged seatbelt `.sb` profile (byte-for-byte identical argv), `LinuxSandboxBackend` builds an
  equivalent bwrap jail (empty namespace + explicit bind allow-list — the dual of seatbelt
  `(deny default)+(allow subpath)`). An **availability gate** re-activates the `codex`/`claudecode`
  exec sources on Linux **iff** bwrap can *actually build a namespace* (the probe runs a real jailed
  command, not `bwrap --version`, so a present-but-unusable bwrap on a userns-disabled host correctly
  reports unavailable and the sources stay gated OUT — never "advertised but unjailed"). Full
  seatbelt→bwrap mapping in
  [`linux-confinement.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/linux-confinement.md).
- **Containerization appliance** ("expose a capability, not a system"). An official minimal
  container whose entrypoint is `appliance/boot.ts`: it reads a manifest (`PLEXUS_APPLIANCE_MANIFEST`),
  validates it fail-closed (strict unknown-key rejection; sensitive-path rejection), translates it
  into the stock env, boots the same `startRuntime`, and installs a **standing default-deny
  resolver** via `exposure.setDefaultResolver` so any capability the manifest doesn't name is hidden
  *at query time* — not a boot-time snapshot (closing the scan-race / `POST /extensions` /
  `list_changed` leak). With `upstream` set, the appliance boots as a **mesh proxy** (dials out, caps
  ascend under `tenant/workload/…`, default hidden). Design + threat model in
  [`capability-appliance.md`](https://github.com/nemori-ai/plexus/blob/main/docs/design/capability-appliance.md).

## 10. Invariants (A–G) tied to enforcing code

| # | Invariant (SSOT §5) | Enforced by |
| --- | --- | --- |
| **A** | Mode ⟂ Workload; exactly one primary | Boot branch `runtime.ts:534–536`; mode parse `config.ts:593`; a proxy may bear no workload (pure egress) |
| **B** | Address is identity, route is location | Mount/translate seam `addressing.ts:53–82`; route health never mutates address/grant (`resolution.ts:14–17,72–90`); no-unmount-on-transient-drop `mesh-health.ts:113`; Risk-1 in `networking-resilience.md §4` |
| **C** | Effective access = granted ∧ exposed ∧ ¬revoked ∧ coversInput | Local exposure veto runs even on the tunnel-trust path (`runtime.ts:1149–1157`, `core/pipeline.ts`); revoke purges grants `runtime.ts:740–741` |
| **D** | Audit local-authoritative + bubbles up, never blocking | `bubbleAudit` fire-and-forget `runtime.ts:1066–1074`; `mirrorProxyAudit` best-effort + same redactor `runtime.ts:833–851` |
| **E** | Authority terminates at the primary; never a hang | Proxies delegate up; tunnel-trust ingress re-decides nothing (`runtime.ts:1080–1084`); typed `capability_unavailable` `runtime.ts:912–921`; forward pinned to active enrollment `runtime.ts:871–875` |
| **F** | Workload unique under parent; addresses cascade-rewritten on ascent | Uniqueness index `enrollment.ts:287,456–459`; primary mount `catalog.ts:81–91`, `addressing.ts:53–68` |
| **G** | Companion skill travels with the capability address | Carried in the `CapabilityEntry` pushed + mounted (`catalog.ts:41–91`); skills ride the entry up the cascade |

## 11. Extending the mesh — where to hook in

- **Add a transport / change the wire.** The `Frame` union is the published language of the boundary
  (owned by `@plexus/protocol`); `frames.ts` owns codec + validation only. To add a frame type: add
  the variant in the protocol package, extend the codec/validation if it carries bounded data (mirror
  `validateHealthPayload`'s fail-closed caps, `frames.ts:120`), and handle it in `onPrimaryInbound`
  (`runtime.ts:771`) and/or `onProxyInbound` (`runtime.ts:1085`). The mux (`tunnel.ts`) is
  frame-type-agnostic — it carries, never interprets — so a new frame needs no tunnel change.
- **Add a capability source on a proxy.** Nothing mesh-specific: register the source in the normal
  registry (`core/registry.ts` / `sources/index.ts`); its bare `source.capability` ids ascend
  automatically on the next catalog push (`pushCatalog`/`pushCatalogDelta`). If it shells out on
  Linux and needs a kernel jail, implement it behind `SandboxBackend` and add an availability gate so
  it stays gated OUT where it can't be confined (see §9).
- **Add a new node type / authority topology.** Everything hangs off the boot branch
  (`runtime.ts:534`). The grammar already tolerates a variable-depth workload path
  (`addressing.ts:98–107`), so *regional delegation* (a `primary` behind a `primary`) composes
  without new address nouns — but it's out of scope for v1 (SSOT §6.3); wiring a mid-tier that does
  its own exposure/audit before bubbling up is the real work, not the addressing.
- **Add an admission or exposure policy.** Enrollment admission is one method, `EnrollmentRegistry.admit`
  (`enrollment.ts:404`) — its check order is the policy seam. Exposure is a per-id resolver
  (`exposure.setDefaultResolver`, the same seam the appliance and mesh zero-exposure use), so a new
  default-deny/allow policy is a resolver, not a code fork.
- **Observe topology/health.** `MeshClient.onStateChange` (`tunnel.ts:930`) for the proxy's own 5-state
  dial; `ResolutionTable.healthOf` + `MeshHealthStore.stateFor` for the primary's per-workload view;
  both surface at `GET /admin/api/mesh`.

## 12. Test map (contracts, not implementation)

| Concern | Test |
| --- | --- |
| Enrollment admission / replay / durability | `tests/mesh-enrollment.test.ts`, `tests/mesh-join-token-admin.test.ts` |
| Tunnel mux / framing | `tests/mesh-tunnel.test.ts`, `tests/mesh-protocol-types.test.ts` |
| Handshake mutual auth / trust / reaper | `tests/mesh-tunnel-auth.test.ts`, `tests/mesh-tunnel-trust.test.ts`, `tests/mesh-handshake-reaper.test.ts` |
| Dual listener + require-encryption | `tests/mesh-dual-listener.test.ts`, `tests/mesh-require-encryption.test.ts` |
| Reconnect / backoff / heartbeat | `tests/mesh-reconnect-resilience.test.ts`, `tests/mesh-backoff-heartbeat.test.ts` |
| Catalog ascent / mount | `tests/mesh-catalog-ascent.test.ts`, `tests/mesh-catalog.test.ts` |
| Invoke forward / multiproxy | `tests/mesh-invoke-forward.test.ts`, `tests/mesh-multiproxy.test.ts` |
| Health reporting / downtime | `tests/mesh-health-reporting.test.ts`, `tests/mesh-health-downtime.test.ts` |
| Revocation + audit cascade | `tests/mesh-revocation.test.ts`, `tests/mesh-audit-cascade.test.ts` |
| End-to-end walking skeleton / Linux proxy | `tests/mesh-e2e-walking-skeleton.test.ts`, `tests/mesh-linux-proxy-e2e.test.ts` |

Live hybrid demo: `bash examples/mesh-demo/launch-mesh-hybrid.sh` (native mac primary + 2 Docker
Linux proxies, one wss + one ws), admin at `http://127.0.0.1:7077/admin`.

## 13. Where the code surprised me vs the SSOT

Small, worth a maintainer's eye — none are bugs, but the SSOT reads as if some are still open:

1. **`enroll` is a handshake message, not a first-class `Frame`.** The SSOT §7/§3.4 talks about the
   `enroll` frame "over the T4 tunnel mux". In code the enroll + auth legs are a *separate*
   module-local union keyed by `h` (`handshake.ts:144–151`) that rides the **raw socket in a pre-mux
   phase**, precisely to keep the mux identity-agnostic. The `Frame` union (keyed by `t`) only ever
   flows on an *already-promoted* socket. This is a cleaner split than the SSOT wording implies.
2. **Audit has no dedicated cross-tier machinery in the tunnel.** The SSOT lists an `audit` frame and
   a bubble-up mechanism; in code it's an ordinary correlated request on the generic proxy→primary
   request path (`runtime.ts:783–787,1066–1074`) — `tunnel.ts` carries it, never interprets it. The
   "cascade" is entirely `MeshRuntime`-level, not transport-level. Anyone extending audit should hook
   `runtime.ts`, not the tunnel.
3. **`persist_failed` is an enrollment reject reason the SSOT doesn't enumerate.** It's the L1
   durable-write rollback (`enrollment.ts:133,480–487`) — a real admission-failure outcome distinct
   from a bad token/sig. Same for the `revoke` throw-before-destructive contract (`enrollment.ts:511–526`);
   both are "durable-before-report" hardening the DDD invariants imply but don't name.
4. **Health `reported:true` provenance marker.** `mesh-health.ts:213–224` stamps *every* mesh-sourced
   health value as an unverified remote self-assertion. The SSOT frames health as advisory but doesn't
   surface this on-the-wire marker; it's a meaningful contract for any consumer distinguishing
   "remote says ok" from a locally-probed "gateway proved ok".
5. **`unknown` has two distinct sources** (never-connected route vs `connecting`→`unknown` wire
   mapping). Worth stating explicitly in the SSOT health table since a reader could conflate them.
