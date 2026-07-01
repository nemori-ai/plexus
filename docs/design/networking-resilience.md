# Networking resilience — proxy auto-reconnect, heartbeat, connection-state

> Status: **design** (drives the "networking hardening" implementation track).
> SSOT = `federated-mesh-domain-model.md`. This doc covers the PROXY↔PRIMARY tunnel's
> liveness: how a `proxy` survives a transient network drop, how a half-open socket is
> detected, how the connection state is surfaced, and — load-bearing — why a transient
> disconnect must **never** unmount a workload's capabilities or drop its grants.

## 0. Scope + the invariants it hangs off

The tunnel is the single persistent WebSocket a `proxy` **dials out** to its `primary`
(mesh §7 transport premise — NAT-forced, no inbound hole on the proxy host). Everything
multiplexes over it. When it drops, the proxy must heal it without operator action and
without losing the authority state that lives at the primary.

Two invariants govern the design:

- **Invariant B (address ⟂ route).** A grant binds to an **address**; resolution binds
  `address → route`. A dropped socket is a **route** fact — it changes what `resolve()`
  reports, it **never** mutates a mounted address or a grant. So a reconnect re-uses the
  same addresses and the same grants survive (mesh §5 B; §3.1 ResolutionTable).
- **Invariant E (never a hang).** While the home is down, the forward boundary returns a
  typed `capability_unavailable` + `unavailableSince` — not a hang. Reconnect flips the
  resolution back to `ok`; no re-grant, no re-mount.

And the directly-relevant ADR ledger row:

- **Risk 1 — No-unmount-on-transient-disconnect (ADOPTED).** Keep a workload
  **mounted-but-unavailable** across a socket drop; the **only** legitimate un-mount paths
  are an explicit `withdrawn` catalog delta and a `revoke` (B6). A transient tunnel drop
  is neither. (mesh §7 revocation row.)

## 1. Auto-reconnect (exponential backoff + jitter, bounded)

The `MeshClient` (proxy side) already redials after a drop. This track hardens it:

- **Exponential backoff with a hard cap.** `delay = backoffInitial · 2^attempt`, clamped
  to `backoffMax`. The base doubles on each *failed* cycle and is reset to `backoffInitial`
  only when the tunnel reaches **`connected`** (authenticated + ready) — **not** on a mere
  socket `open`. This is what keeps a failing-auth loop (e.g. a plain-ws proxy rejected by
  the encryption policy, or a revoked workload) **bounded**: each rejection re-doubles the
  delay toward the cap instead of resetting it, so there is no tight reconnect storm.
- **Jitter.** The scheduled delay is **equal-jitter**: `actual = delay/2 + rand(0, delay/2)`.
  This de-correlates a fleet of proxies that all lost a primary at once (they would
  otherwise reconnect in lock-step and thundering-herd the primary). Jitter is applied to
  the *scheduled* delay only; the doubling sequence stays deterministic so the cap still
  bounds it. Disable-able (`backoffJitter:false`) for deterministic tests.
- **Re-run the join on reconnect.** A fresh handshake driver is built **per connect**, so a
  reconnect re-runs the Ed25519 mutual challenge (and the one-time enroll leg only on the
  first ever join — the token is single-use, mesh §7 Q3). On every authenticated (re)connect
  the proxy **re-pushes its full catalog** (`onAuthenticated` → `pushCatalog`) so the
  primary's mounted directory is rebuilt after any downtime (A2 live ascent).
- **In-flight requests heal.** A `request()` that raced the drop is re-sent on the fresh
  socket (same `corr`), bounded by the overall deadline; a genuinely-silent peer still fails
  as a clean `MeshTimeoutError` (no hang).

## 2. Heartbeat / keepalive (detect a half-open socket)

A TCP socket can die silently (NAT timeout, peer power-loss): no `close`/`error` fires, so
the proxy believes it is connected while every frame is black-holed. Reconnect logic that
only triggers on `close` never fires. The fix is an application-level heartbeat:

- **Proxy → primary `ping` every `heartbeatIntervalMs`** (default 15s), sent through the mux
  as a real correlated request with a short `heartbeatTimeoutMs` (default 5s) deadline. The
  primary already echoes `ping` (`onPrimaryInbound`), so a live tunnel round-trips it.
- **A missed pong forces a reconnect.** If the heartbeat request rejects (timeout on a
  half-open socket, or disconnect), the client tears the socket down — which runs the normal
  `handleDown` path → backoff redial → re-auth → re-push catalog. The half-open socket is
  thus converted into an observable drop.
- **The heartbeat runs only while `connected`** (started on ready, stopped on down/close), so
  it never races the handshake and never leaks a timer past `close()`.
- **Primary-side idle teardown (opt-in).** The primary tracks `lastSeen` per connection
  (bumped on every inbound frame, including the proxy's heartbeat) and, when configured with
  a `heartbeatTimeoutMs`, sweeps and tears down a connection that has been silent past the
  timeout — firing `onDisconnect` so the `ResolutionTable` stamps the workload **unavailable**
  promptly (Invariant E) even when no forward was attempted. The runtime wires this to ~3×
  the proxy heartbeat interval so a single missed beat does not trip it.
- **Primary-side handshake-phase reaper (DoS guard).** The idle teardown above only sees
  *promoted* (authenticated) connections. An accepted socket that stalls mid-handshake — or
  never sends a frame at all — lives in the server's unauthenticated `handshakes` set, which
  the heartbeat clock never touches. Left unbounded, a peer reaching the `ws`/`wss` listener
  could hold many half-open unauthenticated sockets and exhaust FDs / grow the map. The same
  sweep therefore also reaps any `handshakes` entry not promoted within a bounded
  `handshakeDeadlineMs` (default ~10s) by closing the socket and dropping the entry. It fires no
  `onDisconnect` (the socket was never a workload) and never touches already-promoted
  connections. Disabled with `handshakeDeadlineMs:0`; armed only on the gated (`createHandshake`)
  path, since the raw transport never half-opens.

## 3. Connection-state surfacing

Operators/admin need to see a proxy as connected / reconnecting / down. The `MeshClient`
exposes a small state machine; the runtime re-publishes it (`proxyConnectionState`):

```
 closed ◄───────────────── close()
   ▲
   │            ┌──────────────────────────────────────────┐
   │            ▼                                            │
connecting ──open──► authenticating ──ready──► connected ──drop──► reconnecting
   ▲                  (handshake)                                      │
   └──────────────────────── backoff timer fires ◄────────────────────┘
```

- `connecting` — dialing (initial or post-backoff).
- `authenticating` — socket open, Ed25519 handshake running (skipped on the raw no-gate path).
- `connected` — authenticated + ready; frames flow; heartbeat armed; backoff reset.
- `reconnecting` — dropped, waiting out the (jittered) backoff before the next dial.
- `closed` — permanently closed (`close()`), no further reconnect.

An `onStateChange` callback lets the runtime/admin observe transitions. On the **primary**
side, per-workload reachability is already surfaced by the `ResolutionTable`
(`healthOf(workload)` → `ok` | `unavailable` + `unavailableSince`); the connection-state
machine above is the **proxy's** view of its own dial.

## 4. The no-unmount-on-transient-disconnect invariant (load-bearing)

When a socket drops, the primary's `MeshServer` fires `onDisconnect(workload)` → the
`ResolutionTable` marks that workload **unavailable**. It does **not**:

- un-mount the workload's addresses from the `CapabilityDirectory`, nor
- purge or suspend the grants bound to those addresses.

The mounted addresses stay in the directory (resolving "unavailable"); the standing grants
stay valid. This is **Invariant B** (a route change never touches an address/grant) and the
**ADOPTED Risk-1 decision**: the demo's downtime→recovery story depends on it — a proxy that
blips for 2 seconds must come back to the *same* mounted, *same*-granted capabilities, with no
operator re-exposure and no agent re-grant. The only un-mounts are the two **deliberate**
ones: an explicit `withdrawn` catalog delta (the proxy's local cap genuinely went away) and a
`revoke` (B6, terminal tombstone). A transient disconnect is neither, so it un-mounts nothing.

## 5. Test obligations

- **Reconnect recovers, grants/mount survive.** Force a transient socket drop from the
  primary; assert the proxy auto-reconnects (resolution `unavailable` → `ok`) **without** a
  manual restart, the mounted address stays in the directory throughout, the grant survives,
  and an invoke resumes end-to-end.
- **Backoff is bounded.** Point a client at a dead URL with a small cap; assert every
  scheduled delay is ≤ cap and the sequence grows then plateaus (no reset-on-open storm).
- **Heartbeat detects a half-open socket** and forces a reconnect (covered at the tunnel
  level with a server that goes silent).
- **Handshake-phase reaper closes a stalled unauthenticated socket.** Connect to the listener
  under the auth gate and never complete the handshake; assert the socket is closed and removed
  from the server's `handshakes` set once `handshakeDeadlineMs` elapses, while promoted
  connections are untouched.
