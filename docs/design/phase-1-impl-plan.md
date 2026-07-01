# Phase 1 — Localhost Walking Skeleton: Implementation Plan

> Plan doc for the federated-mesh epic, phase 1. SSOT = `federated-mesh-domain-model.md`
> (this plan conforms to it; cite the invariant/ADR each task satisfies). Phase 1 proves the
> full spine — **enroll → mount → passthrough invoke → audit cascade** — with primary + ONE
> proxy both on localhost, a `mock` source as the proxy workload, zero OS deps.

## Orientation — the spine the mesh extends

- **One invoke chokepoint**: `InvokePipeline.invokeById` (`core/pipeline.ts:165`) enforces
  exposure → liveness → revocation → scope/constraint → schema → health, then routes to a
  per-`(session×source)` `CapabilityBridge` (`bridgeFor`, ~:86). Workflow fan-out already
  re-enters this method via `BridgeDeps.invokeById` — **the mesh forward reuses this seam.**
- **Registry overlay**: `capability-registry.ts ensureRegistryOverlay` (~:465) + `registerExtension`
  (~:707) is the live-mount path; **mesh mounting is a sibling of it.**
- **Two guards (don't conflate)**: `transports/transport-policy.ts isAllowedHost()` = egress
  SSRF guard (local-rest only); `core/security.ts hostOriginGuard()` = ingress loopback-only
  Host/Origin guard on every route (`server.ts:65`).
- **Single audit write path**: `audit/index.ts JsonlAuditWriter.write()` redacts-then-truncates,
  fires `onAppend`. `AuditEvent` already carries redacted `input`/`output`; no `tier`/attribution yet.
- **Boot is mode-agnostic**: `config.ts loadConfig()` → `serve.ts` → `createAppWithState`.

## Seam analysis (all additive unless noted)

- **(a) Mode** (primary/proxy, boot-fixed, Inv A) — additive: `GatewayMode` in protocol;
  `GatewayConfig.mode/upstream/tenant/workload` parsed from env in `config.ts`; threaded through
  `state.ts`/`serve.ts`. Default `primary` ⇒ Q8 backward-compat, zero behavior change.
- **(b) Mesh transport** (Q1/Q2) — new `packages/runtime/src/mesh/`: a single persistent WebSocket
  the proxy dials OUT (`Bun.serve({websocket})` server in `listen.ts` is the only Bun.serve site;
  Bun ships a `WebSocket` client). All channels (enroll/catalog/invoke/audit/ping) multiplex as
  corr-id'd framed RPC. New `Transport` `kind:"mesh"` registered in `transports/index.ts`; a
  `mesh-source.ts SourceModule` is the mount unit. Primary forward is **fully additive to the
  pipeline** (reuses the bridge seam — no new pipeline branch).
- **(c) Enrollment** (Q2/Q3) — `mesh/enrollment.ts` (`EnrollmentRegistry`, persisted like
  `exposure.ts`), `mesh/keys.ts` (Ed25519 via node:crypto). **The loopback puncture**: bind a
  SEPARATE routable listener (`PLEXUS_MESH_PORT`) for the tunnel, with its OWN Ed25519 mutual-auth
  middleware — the agent app stays `127.0.0.1` + `hostOriginGuard` **untouched**. The mesh
  transport has its own pinned-destination policy (enrolled `upstream.url`), so it never becomes
  an SSRF primitive and `transport-policy.ts` stays loopback-strict for extensions.
- **(d) Addressing + primary-mount** (Q4) — `CapabilityAddress` `tenant/<workload…>/source.cap`
  (today's id = the tail, Q8 superset). Proxy advertises BARE ids; primary
  `capability-registry.mountRemoteWorkload()` prefixes + sets `transport:"mesh"` + translates
  back to bare at the forward boundary. Address⟂route (Inv B): prefixed address is the stable
  grant/audit key. Zero-exposure on mount via a per-id `defaultFor()` hook on `ExposureStore`.
- **(e) Audit cascade** (Q7, Inv D) — `AuditEvent.tier?/correlationId?/Attribution`. Proxy
  `onAppend` bubbles a copy up the tunnel (best-effort, never blocks); primary writes it through
  the SAME `JsonlAuditWriter` (same redactor both tiers). Proxy-local log authoritative.
- **(f) Health/downtime** (Inv E) — `mesh/resolution.ts ResolutionTable` (`address→{socket,health,
  unavailableSince}`); mesh source `health()` reads it; `pipeline.ts` health gate yields typed
  `capability_unavailable`. No replica/failover.

## Task DAG (T1–T11)

| Task | Title | Deps | Cites |
| --- | --- | --- | --- |
| T1 | Protocol types & contract surface | — | Q8 superset |
| T2 | Gateway Mode in config/boot | T1 | Inv A |
| T3 | Ed25519 mesh identity keys | — | Q2 |
| T4 | Tunnel transport (WS multiplexer) | T1 | Q1/Q2 |
| T5 | Enrollment handshake (mutual Ed25519) | T3,T4 | Q2/Q3, Inv F |
| T6 | Catalog push + primary mount (address rewrite) | T5 | Q4, Inv B |
| T7 | Mesh transport + invoke forward | T4,T6 | Q1 |
| T8 | Proxy tunnel-trust ingress | T7 | Inv E |
| T9 | Audit cascade / mirror | T7 | Q7, Inv D |
| T10 | Health / downtime signal | T7 | Inv E |
| T11 | E2E walking-skeleton spec + harness | T8,T9,T10 | full spine |

Critical path: **T1→T4→T5→T6→T7→T8→T11**. Parallel: T3 ∥ (T1→T4); T9 ∥ T10 (both consume only T7).
Each task's acceptance + test plan are on the board (`ccm task show <id>`).

## Top risks (tracked)

1. **In-process bridge vs remote proxy** — the mesh bridge must be a thin stateless forwarder over
   a gateway-lived (not session-scoped) socket; `disposeSession` must never tear the tunnel.
2. **(SECURITY-CRITICAL) Two trust boundaries, mismatched crypto** — agent↔primary HS256 vs
   primary↔proxy Ed25519. The **tunnel-trust ingress (T8)** is the ONE place the pipeline's
   "every invoke is authorized" is satisfied by a *different* proof (Ed25519 tunnel, NOT a JWT):
   it injects a synthetic trusted context, must NOT mint/verify a JWT, must NOT leak the HS256
   secret. High-scrutiny + a second (codex) review pass.
3. **Reverse-tunnel mechanics in Bun** — request/response multiplexing, backpressure,
   reconnect-with-inflight, head-of-line blocking over one socket. Mitigation: corr-id map +
   per-request timeout → typed `capability_unavailable`; bounded in-flight window.
4. **Zero-exposure default vs `exposure.ts` "absent = enabled"** — invert the default for
   mesh-mounted ids via `defaultFor()` keyed on mesh-provenance, WITHOUT bloating `exposure.json`
   or regressing local-source semantics.
5. **Address translation correctness** — exactly one prefix/translate per hop; bare id never in a
   primary grant, prefixed address never on the wire. Watch `deriveSource(id)` (`pipeline.ts:263`,
   splits on `.`) once `/` location segments exist. Add an explicit invariant test.
