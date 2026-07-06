# mesh-security-audit — CLOUD topology · the enterprise resource-pool direction

This runs the same flagship story the [local hero topology](../local/) runs on one Mac —
but with an **always-on, neutral parent gateway** on cloud compute, mounting capabilities
borne by workload children (a Mac, a Linux box) that dial out to it. That shape — one
resource-pool authority fronting many machines — is the **enterprise direction** (see
ADR-020's reserved `Attribution.principal`/`policyRef` fields for where it goes).

> **If you are one person publishing your own machine, you don't need any of this** — the
> natural primary is your own computer, and the far simpler
> [`examples/home-gateway`](../../home-gateway/) is the recipe (no Fly, no mesh, verified
> end-to-end). Come back here when the resources belong to a fleet, not a person.

Same story, same agent, same reusable scripts as `local/`; only the **topology** changes.

> **The story (unchanged):** an agent scans a Linux box's status + reads its security/access
> log → hands it to **Codex** (on your Mac) to analyze → writes the conclusion into an
> **Obsidian/workspace vault** (on your Mac) → you see **per-host audit** (sysinfo on the
> Linux box, codex+vault on the Mac) → you **revoke** the agent and watch the next call fail.

```
                         ┌──────────────────────────────────────────┐
   cloud agent           │      Cloudflare edge  (YOUR domain)       │
   (driver.py) ── https ─┤  https://plexus.<domain>   → :7077 agent  │
                         │  wss://mesh.<domain>       → :8080 mesh    │
                         └──────────────────────────────────────────┘
                                        ▲ cloudflared (dials OUT; no inbound ports)
                                        │
                         ┌──────────────┴───────────────┐
                         │  Fly.io Machine (ALWAYS-ON)   │   PARENT / primary
                         │  stock gateway + cloudflared  │   (Dockerfile.edge)
                         │  volume /state  ← Ed25519 mesh identity + connection-key PERSIST
                         └───────────────────────────────┘
                             ▲                         ▲
             wss://mesh.<domain>            wss://mesh.<domain>
                             │                         │
             ┌───────────────┴──────┐      ┌───────────┴────────────────┐
             │  MAC child (native)  │      │  LINUX child (Docker)       │
             │  workload=mac        │      │  workload=linux             │
             │  codex.run + vault   │      │  sysinfo.processes/resources/log
             └──────────────────────┘      └────────────────────────────┘
```

Both children **dial OUT** to the Cloudflare edge (NAT-friendly, no inbound ports). Their
caps mount on the parent as `local/mac/codex.run`, `local/mac/workspace.write`,
`local/linux/sysinfo.*`. The agent talks ONLY to the parent, at `https://plexus.<domain>`.

---

## What YOU supply (we deploy nothing — no creds, and it costs money)

Everything below runs on **your** accounts with **your** credentials:

| you supply | for |
|---|---|
| a **Cloudflare account** + a **domain (zone) active on it** | the stable `mesh.<domain>` / `plexus.<domain>` hostnames |
| a **Fly.io account** (`fly auth login`) | the always-on parent Machine + its persistent volume (bills you) |
| a **Mac** | the native Mac child (codex is macOS-native + exec-class → it lives here) |
| **any Docker host** | the Linux child container (a VM, a laptop, a CI box — it dials the public edge) |
| CLIs: **flyctl**, **cloudflared**, **docker**, plus `jq`, `curl`, `bun`, `python3` | driving the recipe |

The only **secret** you set on Fly is the cloudflared `TUNNEL_TOKEN`. The gateway's admin
**connection-key is NOT injected** — it is auto-generated into `/state/connection-key` on
first boot and persists on the volume; you retrieve it with `fly ssh` (step C).

---

## Files in this directory

| file | role |
|---|---|
| `fly.toml` | the parent Fly app (persistent volume `/state`, mesh port, env) |
| `Dockerfile.edge` | `FROM plexus-gateway:latest` (stock) + `cloudflared`; gateway binary unchanged |
| `start.sh` | in-image supervisor: cloudflared (bg, self-healing) + stock gateway (fg) |
| `deploy-parent.sh` | build stock image → `fly deploy` → volume → `TUNNEL_TOKEN` → scale 1 |
| `cloudflared.md` | exact Cloudflare Tunnel setup (create tunnel, routes, token) — **cite CF docs** |
| `cloudflared-config.example.yml` | reference ingress (`mesh→:8080`, `plexus→:7077`) |
| `mint-join.sh` | mint a one-time join token on the parent (`fly ssh`) + derive the pinned pubkey |
| `mac-child.sh` | run the native Mac proxy (codex + vault) dialing the edge |
| `linux-child.sh` + `compose.linux.yml` | run the Docker Linux proxy (sysinfo) dialing the edge |

Reused **by reference** (owned elsewhere in this example — do not copy):
`../agent/driver.py` (the address-agnostic agent), `../scripts/grant-setup.sh`,
`../scripts/show-audit.sh`, `../scripts/revoke.sh`, and the seeded log `../local/seed/`.

---

## The ordered walkthrough

Run everything from this directory (`examples/mesh-security-audit/cloud/`) unless noted.
Substitute your real domain for `<domain>` and your app name for `plexus-parent`.

### A. Deploy the parent (Fly)

```bash
# Edit fly.toml FIRST: set `app` (globally unique) and `primary_region`.
fly auth login
./deploy-parent.sh          # builds the stock image, deploys the edge image, creates the
                            # /state volume, scales to 1 always-on Machine.
```

`deploy-parent.sh` will prompt you (via a note) to set `TUNNEL_TOKEN` — get it in step B, then
either re-run with `TUNNEL_TOKEN=… ./deploy-parent.sh` or `fly secrets set TUNNEL_TOKEN=…`.

### B. Publish it on your Cloudflare domain

Follow **[`cloudflared.md`](./cloudflared.md)** end to end:
create the tunnel, route `mesh.<domain>` → `localhost:8080` and `plexus.<domain>` →
`localhost:7077`, grab the `TUNNEL_TOKEN`, set it on Fly. Verify:

```bash
curl -sS https://plexus.<domain>/.well-known/plexus | jq '.capabilities | length'
```

### C. Retrieve the parent's connection-key (admin credential)

```bash
fly ssh console -a plexus-parent -C 'cat /state/connection-key'
# → export it for the scripts below:
export PLEXUS_BASE_URL="https://plexus.<domain>"
export PLEXUS_CONNECTION_KEY="plx_live_…"     # the value you just printed
```

### D. Attach the Mac child (codex + vault) — on your Mac

```bash
# Mint a one-time join token on the parent + derive the pinned pubkey:
MESH_HOSTNAME=mesh.<domain> ./mint-join.sh mac > mac.join.env

# Run the native Mac proxy (foreground; background it or use tmux/launchd to persist).
# Default = codex record-mode (no cost). For a REAL codex run: CODEX_REAL=1 (needs a
# logged-in `codex`, costs model tokens).
MAC_JOIN_ENV=mac.join.env ./mac-child.sh
```

Its caps mount on the parent as `local/mac/codex.run`, `local/mac/workspace.*` (and
`local/mac/obsidian-*` if you configure the Obsidian REST source on the Mac).

### E. Attach the Linux child (sysinfo) — on any Docker host

```bash
MESH_HOSTNAME=mesh.<domain> ./mint-join.sh linux > linux.join.env
LINUX_JOIN_ENV=linux.join.env ./linux-child.sh
```

Its caps mount as `local/linux/sysinfo.{processes.list,resources.read,log.read}`.

### F. Authorize the agent (against the cloud parent)

Reuse the shared setup script — it is **address-agnostic** (matches caps by suffix, so it
works whether ids are bare or mesh-mounted) and takes the parent's `BASE_URL`:

```bash
# uses PLEXUS_BASE_URL + PLEXUS_CONNECTION_KEY from step C
bash ../scripts/grant-setup.sh
# → prints a one-time enroll code + the base URL for the agent.
```

### G. Run the agent flow

```bash
PLEXUS_BASE_URL="https://plexus.<domain>" \
PLEXUS_ENROLL_CODE="plx_enroll_…" \
  python ../agent/driver.py --run
```

`codex.run` (execute) and the vault write (write) **pend** on each call — approve them in the
Plexus UI or via `POST /admin/api/pending` (against `https://plexus.<domain>`) when the driver
blocks. That HITL beat is the point.

### H. See the per-host audit split

Each gateway logs only what **it** executed. In the cloud topology the executors are the two
children (the parent holds forwards + mirrors + the grant lifecycle):

```bash
# Mac child (codex + vault) + Linux child (sysinfo), from the Mac:
PLEXUS_HOME="$HOME/.plexus-mesh-mac" \
PLEXUS_LINUX_AUDIT_CMD="docker compose -f $(pwd)/compose.linux.yml exec -T linux sh -c 'cat /state/audit/*.jsonl 2>/dev/null'" \
  bash ../scripts/show-audit.sh
#   NOTE: show-audit labels the PLEXUS_HOME stream "PRIMARY" (local-topology wording); in the
#   cloud topology that stream is the MAC CHILD's codex+vault log — the CONTENT split is right:
#   codex+vault on the Mac, sysinfo on the Linux box, neither logs the other's.

# The PARENT's own aggregate (edge-span forwards + mirrors + grant/revoke lifecycle) on Fly:
fly ssh console -a plexus-parent -C 'sh -lc "cat /state/audit/*.jsonl"' | tail -n 40
```

### I. Revoke — prove the next call fails closed

```bash
# uses PLEXUS_BASE_URL + PLEXUS_CONNECTION_KEY from step C
bash ../scripts/revoke.sh
# revokes the agent, runs driver.py --probe, and shows the revoke event in the parent audit.
```

Tear down: `fly apps destroy plexus-parent` (removes the Machine + volume — this deletes the
mesh identity), stop the Mac child (Ctrl-C), and
`docker compose -f compose.linux.yml --env-file mesh.env down -v`.

---

## Per-node env reference (every name cross-checked against `packages/runtime/src/config.ts`)

**Parent** (fly.toml `[env]` + `TUNNEL_TOKEN` secret; connection-key auto-generated on `/state`):

| env | value | why |
|---|---|---|
| `PLEXUS_INSTANCE` | `flagship-parent` | label |
| `PLEXUS_PORT` | `7077` | agent HTTP (loopback; cloudflared → `plexus.<domain>`) |
| `PLEXUS_PUBLIC_HOSTNAME` | `plexus.<domain>` | **required** — the guard accepts the forwarded public Host AND the gateway advertises `https://plexus.<domain>` as its base (without it every edge request is `host_forbidden`) |
| `PLEXUS_HOME` | `/state` | state root == the persistent volume |
| `PLEXUS_MESH_TUNNEL_HOST` | `0.0.0.0` | bind the mesh listener so cloudflared reaches it |
| `PLEXUS_MESH_WS_PORT` | `8080` | fixed mesh ws port (cloudflared → `mesh.<domain>`) |
| `TUNNEL_TOKEN` *(secret)* | cloudflared token | the edge connector's credential |

*No `PLEXUS_MESH_WSS_PORT` / TLS cert on the parent — TLS is at the CF edge.*

**Mac child** (native; from `mint-join.sh mac` + `mac-child.sh`):

| env | value |
|---|---|
| `PLEXUS_MODE` | `proxy` |
| `PLEXUS_WORKLOAD` | `mac` |
| `PLEXUS_UPSTREAM_URL` | `wss://mesh.<domain>` |
| `PLEXUS_UPSTREAM_PUBKEY` | pinned raw Ed25519 pubkey (from mint) |
| `PLEXUS_JOIN_TOKEN` | one-time token (from mint) |
| `PLEXUS_HOME` | `~/.plexus-mesh-mac` (isolated) |
| `PLEXUS_CODEX_AUTHORIZED_DIR` | codex jail dir |
| `PLEXUS_CODEX_HEADLESS_LAUNCH` | `1` only for a REAL codex run (`CODEX_REAL=1`) |
| `PLEXUS_WORKSPACE_DIR` | the vault folder |

**Linux child** (Docker; from `mint-join.sh linux` + `compose.linux.yml`):

| env | value |
|---|---|
| `PLEXUS_MODE` | `proxy` |
| `PLEXUS_WORKLOAD` | `linux` |
| `PLEXUS_HOME` | `/state` (named volume) |
| `PLEXUS_UPSTREAM_URL` | `wss://mesh.<domain>` |
| `PLEXUS_UPSTREAM_PUBKEY` | pinned raw Ed25519 pubkey (from mint) |
| `PLEXUS_JOIN_TOKEN` | one-time token (from mint) |
| `PLEXUS_SYSINFO_LOG_DIR` | `/var/log/plexus-demo` (seed mounted read-only) |

No `NODE_EXTRA_CA_CERTS` on either child — the CF edge cert is publicly trusted (unlike the
local self-signed topology). The pinned `PLEXUS_UPSTREAM_PUBKEY` is the identity boundary.

---

## What we verified vs. what only a real deploy confirms

**Verified here (no cloud spend):**
- The FEAT public-hostname mechanics this recipe now leans on — the guard accepting the
  forwarded public Host, the https origin allowance, and the advertised-base switch — are
  covered by unit tests (`tests/network-binding.test.ts` §6) AND verified end-to-end
  against a live Cloudflare named tunnel on a real domain in
  [`examples/home-gateway`](../../home-gateway/) (same edge path this recipe uses; only
  the compute differs). Earlier revisions of this recipe lacked `PLEXUS_PUBLIC_HOSTNAME`
  and would have 403'd every edge request — that class of bug is what the live
  verification closed.
- `bash -n` on every `.sh` in this directory (clean).
- Every `PLEXUS_*` / mint flag cross-checked against `packages/runtime/src/config.ts`,
  `packages/cli/src/mesh-commands.ts`, the sources' env (`PLEXUS_SYSINFO_LOG_DIR`,
  `PLEXUS_CODEX_AUTHORIZED_DIR`, `PLEXUS_WORKSPACE_DIR`), and the working
  `examples/mesh-demo/run-multihost-docker.sh` join flow.
- The join flow (mint → pinned pubkey → dial → enroll → live-ascent → auto-mount → revoke)
  matches the proven local + docker demos; only the dial target changes (a public
  `wss://mesh.<domain>` instead of a same-host primary).
- Persistence: the mesh identity lives at `/state/mesh/identity/id_ed25519` and the
  connection-key at `/state/connection-key` (both under `PLEXUS_HOME`), so the volume at
  `/state` preserves the pinned pubkey across restarts (confirmed in `mesh/keys.ts` +
  `core/connection-key.ts`).

**Only a real deploy confirms (we have no Fly/CF creds; deploying costs money):**
- `fly config validate` and the actual `fly deploy` / volume attach / secrets (flyctl was
  not installed in the authoring env — `fly.toml` was checked structurally against Fly's
  schema, not run).
- `cloudflared` tunnel creation, the DNS routes, and the WebSocket upgrade through the edge
  (cloudflared was not installed — `cloudflared-config.example.yml` is transcribed from CF
  docs; validate with `cloudflared tunnel ingress validate`).
- End-to-end reachability of a child dialing `wss://mesh.<domain>` and the agent reaching
  `https://plexus.<domain>` (edge + DNS propagation are environmental).
