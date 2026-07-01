# Phase 4 — Real Multi-Host Mesh Example: Implementation Plan

> Plan doc for the federated-mesh epic, phase 4 (the user's goal). SSOT = `federated-mesh-domain-model.md`.
> A **mac primary** exposing its own caps + **2 ubuntu proxies** (different caps each, one channel-encryption
> ON, one OFF) → ONE aggregated multi-source collection a single agent uses through the primary "like local."
> Dev/test on Docker ubuntu; real VMs user-supplied for the final demo.

## CRITICAL grounding fact (reshapes B7)
The tunnel today binds **`127.0.0.1` + ephemeral port** (`tunnel.ts:323-327`; `runtime.ts startPrimary` passes
no host/port) — **unreachable from any container/VM.** This is THE reachability gap. **B7 = P4-0** must open it:
routable bind-host + FIXED ports + a TLS (wss) listener, so a proxy can dial in cross-host.

## Topology & capability assignment
```
AGENT (Claude Code/curl) ──HTTP :7077── ▶ MAC PRIMARY (mode=primary, workload=mac-laptop)
                                            own caps (Inv A, exposed-by-default): apple-calendar.* + workspace.* (~/PlexusDemo)
                                            tunnel DUAL listener (B7): wss://host:8443 (enc-ON) + ws://host:8080 (enc-OFF)
                                            bound on 0.0.0.0 (routable), NOT 127.0.0.1
   proxy-A  wss://host.docker.internal:8443 (enc-ON)  → workload=proxy-a, exposes workspace.* over /data/proxy-a
   proxy-B  ws://host.docker.internal:8080  (enc-OFF) → workload=proxy-b, exposes cc-master.* (claude on PATH)
```
On Linux only `{cc-master, workspace}` are active (P3-1). Two proxies MUST expose genuinely different ids →
proxy-A=`workspace`, proxy-B=`cc-master`. Fallback if `claude`-in-container is impractical: proxy-B=`workspace`
over a *different root* + assert distinctness by mount-prefix+content (not id). Aggregated `.well-known` at the
primary = mac-own caps + `tenant/proxy-a/workspace.*` + `tenant/proxy-b/cc-master.*` — one list, three sources.

## Network reachability (load-bearing)
- **Tunnel reachable from containers**: B7 adds `PLEXUS_MESH_TUNNEL_HOST=0.0.0.0`, `PLEXUS_MESH_WS_PORT=8080`,
  `PLEXUS_MESH_WSS_PORT=8443`, `PLEXUS_MESH_TLS_CERT/_KEY`, parsed in `config.ts loadMeshBootConfig`, consumed in
  `runtime.ts startPrimary` → `new MeshServer({hostname,port,tls})`. Mint/status must report BOTH endpoints.
- **Container → mac**: `host.docker.internal` (Docker Desktop macOS). Proxy env `PLEXUS_UPSTREAM_URL=wss://host.docker.internal:8443` etc.
- **Fully-dockerized hermetic e2e**: primary also in a container; proxies dial `wss://primary:8443` by compose service DNS (no host.docker.internal).

## P4 task DAG
- **P4-0 = B7** [SPINE]: dual ws+wss listener + routable bind-host + fixed ports + TLS config + mint/status reports both endpoints + CLI lets `--url`/scheme override the 127.0.0.1 default. Files: `mesh/tunnel.ts`, `mesh/runtime.ts startPrimary`, `config.ts`, `core/admin.ts` (mint/status), `mesh-commands.ts`. **Hard dep for all enc-related P4 work.** ← serialized after B6 (runtime.ts).
- **P4-1** Linux proxy run profile (image+entrypoint over `docker/Dockerfile`; proxy-B `claude` layer or workspace-fallback; seed `/data/proxy-a`) ← P3-1. Docker (slow/async).
- **P4-2** `docker/compose.mesh.yml` + `examples/mesh-demo/run-multihost-demo.sh` (2 proxy services, host.docker.internal, cert mount, distinct workloads/roots) ← P4-1, B7.
- **P4-3** Mac-primary config exposing its OWN caps (Inv A) — parallel; `.well-known` lists primary's workspace+apple before any proxy.
- **P4-4** Per-proxy enc-ON/OFF wiring (proxy-A wss+CA-trust, proxy-B ws; per-proxy mint) ← B7, P4-2.
- **P4-5** Aggregated-collection narrated demo (mint→enroll→auto-mount→expose→discover→consent→invoke-across-3→downtime→revoke-one) ← P4-2/3/4; soft-dep B6.
- **P4-6** Hermetic fully-containerized Docker e2e (primary+2 proxies on a compose network, dual-workspace flavor, `--exit-code-from agent`) ← B7, P4-1. **Async CI** (slow docker; reuses P3-2/P3-3).

Critical path: **B6 → B7(P4-0) → P4-2 → P4-4 → P4-5.** P4-1/P4-3 parallel; P4-6 async-CI.

## Real-VM handoff
`PLEXUS_MESH_TUNNEL_HOST=0.0.0.0` + open firewall ports 8080/8443; each VM `PLEXUS_UPSTREAM_URL=wss://<primary-LAN-ip>:8443` (VM-A) / `ws://...:8080` (VM-B) — proxy dials OUT (NAT-friendly, no inbound on VMs). Out-of-band: `plexus mesh mint --json` ×2 → copy `token`(→PLEXUS_JOIN_TOKEN, single-use) + `primaryPubKey`(→PLEXUS_UPSTREAM_PUBKEY, mandatory pin) over SSH. enc-ON: trust the primary's TLS cert on VM-A (`NODE_EXTRA_CA_CERTS` or system store; real cert for public). Install repo+bun per `docker/Dockerfile`, set workload/workspace/claude, launch `bin/plexus`.

## Top-5 risks
1. **Tunnel reachability (highest)** — 127.0.0.1+ephemeral today; until B7/P4-0 routable bind+fixed ports, nothing reaches it. Verify with a bare `docker run curl host.docker.internal:8080` probe first.
2. **Self-signed wss cert from a container** — Bun WS rejects by default; failure is a silent never-authenticating tunnel. Mount CA + `NODE_EXTRA_CA_CERTS` (prod) / `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev); P4-4 test must assert an *untrusted* CA fails fast.
3. **Proxies not genuinely different** — two workspace roots share ids. Prefer proxy-B=`cc-master`; if falling back, assert distinctness by prefix+content, never id.
4. **`cc-master` needs `claude` on PATH** (`cc-master/manifest.ts`) — bake into proxy-B image + assert checkRequirements ok before exposure; document workspace fallback for CI.
5. **Mint URL hardcoded `127.0.0.1`** (`mesh-commands.ts:243`) — operator could hand an unreachable URL. B7 makes mint/status report both real endpoints; the script rewrites host + picks scheme per proxy.
