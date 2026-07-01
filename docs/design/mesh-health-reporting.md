# Mesh health-reporting — bidirectional, negotiated at enrollment

> Status: **design → implemented**. SSOT = `federated-mesh-domain-model.md` (§5 invariants,
> esp. B address⟂route and E never-a-hang). EXTENDS `networking-resilience.md` (tonight's
> reconnect/heartbeat/connection-state) — the health frame **subsumes** the bare heartbeat
> when negotiated, it does not add a second liveness timer.

## 0. The problem this closes

Today the primary knows only a proxy's **coarse socket up/down** (the `ResolutionTable`:
`markAvailable`/`markUnavailable`, states `ok|unavailable|unknown`). A mounted remote cap
(`local/proxy-a/workspace.*`) therefore renders **"health unknown"** in the admin: the
synthetic `mesh:<workload>` bridge source has no real `health()` probe, and the primary
deliberately never round-trips to probe a remote cap (that would defeat Invariant E).

Product decision: a proxy-mode gateway **auto-reports its health upstream**, established at
registration, bidirectional. The primary stamps the mounted-cap health from the last report
instead of guessing.

## 1. What is a "health report" here (provenance, not a probe)

Health is **per-source** at the reporter (a source reports health; its capabilities inherit
that one value — the existing `SourceHealthCache` model). A proxy AGGREGATES its local
`SourceHealthCache` into one report and pushes it up. At the primary, every one of that
workload's caps is mounted under **one** synthetic source `mesh:<workload>` — so the
per-source granularity collapses to **one health value per workload** (the report's
`overall`), with the per-source rows retained for admin detail.

The report is **advisory + time-varying** (same contract as `CapabilityHealth`): a snapshot,
never a substitute for the authoritative per-call result. The primary never probes a remote
cap; it only reflects what the home most recently told it.

## 2. Negotiation at registration (handshake challenge leg)

Health reporting is a **mutually-advertised** capability negotiated inside the existing
Ed25519 mutual-auth handshake (`mesh/handshake.ts`), on the **challenge leg** so it re-runs
on every (re)connect — including a challenge-only reconnect where the one-time enroll leg is
skipped. It is **fully optional** and **backward compatible**: a peer that does not advertise
it falls back to today's bare heartbeat + socket up/down, and the existing
`mesh-tunnel-auth` tests (which hand-craft `auth-init`/`auth-challenge` with **no**
`healthReporting` field) keep passing untouched.

```
proxy  → auth-init      { workload, cnonce, healthReporting?: {version, intervalMs} }
primary→ auth-challenge { snonce, sig, healthReporting?: {version, intervalMs} }
proxy  → auth-response  { sig }
primary→ auth-ok
```

- Each peer advertises `{ version, intervalMs }`. **Enable only if BOTH advertise.**
- The negotiated result is computed **identically on both ends** (deterministic):
  `version = min(a,b)`, `intervalMs = max(a,b)` (neither peer is forced to report faster than
  it asked). Result is surfaced to the tunnel via `HandshakeStep.healthReporting` on `done`
  (proxy learns the primary's advert at `auth-challenge`; primary learns the proxy's at
  `auth-init`; both return the same negotiated value on completion).
- When negotiated, both ends store the interval on the connection; when absent → `undefined`
  → bare-heartbeat fallback.

## 3. The `health` frame (first-class tunnel frame)

Added to the published `Frame` union (`@plexus/protocol`) + codec/validation in
`mesh/frames.ts`, framed like every other tunnel frame (`t`,`corr`, JSON):

```ts
interface HealthReportSource { source: SourceId; status: HealthStatus; detail?: string; checkedAt?: IsoTimestamp; }
interface HealthFramePayload {
  reporter: WorkloadName | "primary";   // ADVISORY only — see anti-forgery below
  overall:  "ok" | "degraded" | "down";
  sources:  HealthReportSource[];        // per-source rows (caps inherit their source's status)
  seq:      number;                      // monotonic per reporter; primary drops out-of-order
  ts:       IsoTimestamp;                // when the reporter built it
}
interface HealthFrame { t: "health"; corr: string; payload: HealthFramePayload; }
```

### Anti-forgery (the load-bearing discipline)

The `reporter` field is **client-controlled and therefore never trusted**. The primary
attributes a report to the **authenticated workload bound to the socket it arrived on** —
the exact same discipline as catalog mounting under `authenticatedWorkload` and audit
bubble-up: `onPrimaryInbound(frame, workload)` is handed the socket-bound `workload` by the
tunnel (fan-out A3), and `MeshHealthStore.record(workload, payload)` keys on THAT, ignoring
`payload.reporter`. A proxy that forges `reporter:"other"` still only ever updates its own
workload's health.

## 4. Timing + bidirectionality (reuse the heartbeat, no second timer)

- **Proxy → primary.** When negotiated, the proxy's existing heartbeat loop (MeshClient)
  sends a `health` frame **instead of** a bare `ping`, at the negotiated interval, as a
  correlated request with the heartbeat deadline — so a missed ack still forces a reconnect
  (the health frame **doubles as** the liveness signal; the bare ping is subsumed). Fires an
  **initial snapshot on authenticated connect** (`onAuthenticated`) and **on-change** when a
  local source flips (piggy-backs the catalog-delta subscription: a source coming online /
  going away is the dominant health flip and already bumps the registry revision) via
  `client.reportHealthNow()`.
- **Primary → proxy.** On authenticated connect the primary starts a per-workload interval
  that sends its own `health` frame down (`overall:"ok"` liveness + optional own source
  health) via `server.forward(workload, frame)`; cleared on disconnect/revoke/stop. This
  supports **cascade** (a proxy that is itself an upstream propagates downward) and gives the
  proxy a downward liveness signal.
- **Receiver treats an inbound health frame as liveness.** The primary bumps the
  connection's `lastSeen` on every inbound frame (already true) so a health frame resets the
  idle-teardown clock; the proxy acks the primary's frame and records it.

## 5. Primary stamps mounted-cap health (the state machine)

A new `MeshHealthStore` (sibling of `ResolutionTable`, `mesh/mesh-health.ts`) keyed by
workload holds the last accepted report + the negotiated interval. The synthetic
`mesh:<workload>` bridge source's health — and thus the admin / `.well-known` `health` field
for every `local/<workload>/…` cap — resolves from `stateFor(workload, resolution, now)`:

| Precedence | Condition                                                   | MeshHealthState | Stamped `CapabilityHealth`                 | Invariant |
|-----------:|-------------------------------------------------------------|-----------------|--------------------------------------------|-----------|
| 1 (route)  | `ResolutionTable.healthOf(w) == unavailable` (tunnel down)  | `unavailable`   | `unavailable` + `unavailableSince`         | **E**     |
| 2          | tunnel up, **no report yet**                                | `connecting`    | `unknown` (detail "connecting …")          |           |
| 3          | tunnel up, last report older than `interval × 3`            | `stale`         | `degraded` (detail "health report stale")  |           |
| 4          | tunnel up, fresh report `overall:"down"`                    | `down`          | `unavailable` (detail "remote sources down")|          |
| 5          | tunnel up, fresh report `overall:"degraded"`                | `degraded`      | `degraded`                                 |           |
| 6          | tunnel up, fresh report `overall:"ok"`                      | `ok`            | `ok`                                       |           |

**Route wins over report (row 1 first)**: a dropped socket → `unavailable` regardless of the
last (now-irrelevant) report — preserves **Invariant E** (invoke of a down proxy still
returns typed `capability_unavailable` at the forward boundary; the store never round-trips).
The report NEVER mutates a mounted address or a grant — it only changes the resolved health
value — preserving **Invariant B**; and a transient disconnect still does not unmount
(**Invariant B / Risk-1**: the store keeps the last report; the mount + grants survive).

The wire `HealthStatus` stays the frozen 4-state (`ok|degraded|unavailable|unknown`); the
finer `stale`/`connecting`/`down` distinctions ride in `detail` (and the `/api/mesh`
`workloads` rows) for display.

## 6. Read paths (registry provider + admin + web-admin)

- **Registry.** `CapabilityRegistry.setMeshHealthProvider((sourceId) => CapabilityHealth |
  undefined)`. `stampPosture` / `healthOf` / `healthReport` consult the provider FIRST for a
  `mesh:*` source, falling back to the `SourceHealthCache` for local sources. The mesh
  runtime wires the provider to `MeshHealthStore.stateFor(...)`. This is the one seam that
  turns "unknown" into a real value everywhere a cap's health is serialized (manifest,
  `.well-known` summaries, `/admin/api/sources`, `/admin/api/health`).
- **Admin.** `GET /admin/api/mesh` gains a `workloads[]` array (per-workload connection state
  + rich mesh health state + per-source rows + `seq`/`reportedAt`/`unavailableSince`).
- **web-admin.** The "What I expose" derived source node for a `mesh:<workload>` source now
  reads the health stamped on its capabilities (was `src?.health` → `null` → "unknown");
  `connecting` renders as "Connecting". Minimal, styled consistently with the existing
  `HealthDot`/`HealthReason`.

## 7. Backward compatibility

- No advert from either side ⇒ negotiated `undefined` ⇒ bare `ping` heartbeat + socket
  up/down, exactly as before. Existing enroll/auth/tunnel tests unchanged.
- `health` frames only ever flow on an **already-authenticated** socket (the auth gate
  promotes first); an unknown frame type still gets a benign typed no-op result.
- All new payload fields are additive; a pre-health peer never sends or receives them.
