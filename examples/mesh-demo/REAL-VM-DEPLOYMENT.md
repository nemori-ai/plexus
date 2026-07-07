# Real 2-Ubuntu-VM Federated Mesh — Deployment Handoff

This is the production analogue of the localhost demo (`run-multihost-local.sh`) and the
fully-containerized demo (`run-multihost-docker.sh`). Same topology, now on **real machines**:

```
                         ┌───────────────────────────────────────────────────────────┐
   AGENT (curl / CC) ──▶ │  PRIMARY VM  (mode=primary, workload=primary-box)          │
   HTTP 127.0.0.1:7077   │    own caps:  workspace.* (over ~/PlexusDemo)              │
                         │    tunnel DUAL listener, bound 0.0.0.0:                     │
                         │      wss://<primary-LAN-ip>:8443  (enc-ON, TLS)            │
                         │      ws://<primary-LAN-ip>:8080   (enc-OFF)                │
                         └───────────────────────────────────────────────────────────┘
                                  ▲                              ▲
            dials OUT (wss/enc-ON)│                              │dials OUT (ws/enc-OFF)
   ┌──────────────────────────────┴──────┐      ┌────────────────┴─────────────────────┐
   │  VM-A  (mode=proxy, workload=proxy-a)│      │  VM-B  (mode=proxy, workload=proxy-b) │
   │    workspace.* over /srv/proxy-a     │      │    workspace.* over /srv/proxy-b      │
   │    NODE_EXTRA_CA_CERTS = primary cert │      │    (plain ws — no CA trust needed)    │
   └──────────────────────────────────────┘      └───────────────────────────────────────┘
```

**The proxies dial OUT.** No inbound ports are opened on VM-A / VM-B — NAT-friendly. Only the
**primary** needs reachable inbound ports (8080/8443). The agent talks only to the primary.

> Distinct-cap note: VM-A and VM-B both expose `workspace` over **different roots**, so they are
> distinct by mount **prefix** (`local/proxy-a/…` vs `local/proxy-b/…`) + content — never by bare id.
> On a second VM, set `PLEXUS_WORKLOAD=proxy-b` to expose `sysinfo.*` instead
> for a genuinely different capability id (verify `checkRequirements` passes before relying on it).

---

## 0. The same stock binary everywhere

Every node runs the **stock gateway** — the exact entrypoint baked into `docker/Dockerfile`
(`bun run packages/runtime/src/index.ts` → `startRuntime`). Role is chosen purely by env:
`PLEXUS_MODE` unset = primary; `PLEXUS_MODE=proxy` = proxy. On Linux the active first-party
modules auto-gate to the portable allowlist `{workspace, sysinfo}` (P3-1) — the macOS-native
sources (apple-*, things, claudecode, codex) are never scanned. A6 means the stock proxy reads its
one-time `PLEXUS_JOIN_TOKEN` straight from env — no custom launcher.

## 1. Install on each VM (Ubuntu 22.04+) — mirror the Dockerfile

```bash
# deps (same set the Dockerfile installs)
sudo apt-get update && sudo apt-get install -y --no-install-recommends \
  curl unzip ca-certificates git bash openssl

# pinned Bun (matches docker/Dockerfile ARG BUN_VERSION)
curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.11
export BUN_INSTALL="$HOME/.bun"; export PATH="$BUN_INSTALL/bin:$PATH"
bun --version    # expect 1.3.11

# the repo + a fresh Linux dependency install
git clone <your-plexus-remote> plexus && cd plexus
git checkout feat/federated-mesh
bun install
```

## 2. PRIMARY VM — open the routable tunnel

The tunnel today defaults to `127.0.0.1` + an ephemeral port (unreachable off-box). Make it
routable with the `PLEXUS_MESH_*` env (B7/P4-0): bind `0.0.0.0`, fix the ports, serve TLS for wss.

### 2a. TLS cert for the wss endpoint

For a quick internal run, a self-signed cert whose **SAN matches the host the proxies dial**:

```bash
PRIMARY_IP=192.168.1.10   # the primary's LAN IP the proxies will reach
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout ~/plexus-primary-key.pem -out ~/plexus-primary-cert.pem \
  -subj "/CN=${PRIMARY_IP}" \
  -addext "subjectAltName=IP:${PRIMARY_IP},DNS:primary.local"
```

For anything beyond a lab, use a **real cert** (internal CA or Let's Encrypt for a DNS name) so the
proxies need no custom CA trust. Whatever you use, the proxy's `PLEXUS_UPSTREAM_URL` host must be
covered by the cert's SAN.

### 2b. Boot the primary

```bash
cd ~/plexus
PLEXUS_WORKLOAD=primary-box \
PLEXUS_PORT=7077 \
PLEXUS_WORKSPACE_DIR="$HOME/PlexusDemo" \
PLEXUS_MESH_TUNNEL_HOST=0.0.0.0 \
PLEXUS_MESH_WS_PORT=8080 \
PLEXUS_MESH_WSS_PORT=8443 \
PLEXUS_MESH_TLS_CERT="$HOME/plexus-primary-cert.pem" \
PLEXUS_MESH_TLS_KEY="$HOME/plexus-primary-key.pem" \
  bun run packages/runtime/src/index.ts
# (run under systemd / tmux for a long-lived service)
```

Seed the primary's own workspace so an invoke is visibly attributable:
`mkdir -p ~/PlexusDemo && echo 'from the primary VM' > ~/PlexusDemo/primary-note.txt`.

### 2c. Firewall — only the primary needs inbound

```bash
sudo ufw allow 8080/tcp   # mesh tunnel ws  (enc-OFF)
sudo ufw allow 8443/tcp   # mesh tunnel wss (enc-ON)
# Port 7077 (agent surface) stays loopback — do NOT expose it; the agent runs on the primary,
# or you SSH-tunnel 7077 to your workstation. (To LAN-bind it deliberately, see §6.)
```

## 3. Out-of-band enrollment handoff (per proxy, single-use)

On the **primary**, mint one token per proxy — `--host` rewrites the printed URL to the reachable
LAN IP, `--scheme` picks the endpoint. Single-use: mint a fresh token for each VM.

```bash
# VM-A → wss (enc-ON)
bun run packages/cli/src/bin/plexus mesh mint \
  --host ${PRIMARY_IP} --scheme wss --workload proxy-a --json
# VM-B → ws (enc-OFF)
bun run packages/cli/src/bin/plexus mesh mint \
  --host ${PRIMARY_IP} --scheme ws  --workload proxy-b --json
```

Each `--json` mint prints:
- `token`         → the proxy's `PLEXUS_JOIN_TOKEN` (one-time; presented once at enrollment),
- `primaryPubKey` → the proxy's `PLEXUS_UPSTREAM_PUBKEY` (**mandatory pin** — no bare TOFU),
- `endpoints`     → confirms the advertised `ws://…:8080` + `wss://…:8443`.

**Copy the token + pubkey to each VM over SSH** (out-of-band — never on the tunnel itself). Treat the
token like a one-time secret; it is consumed on first enrollment.

## 4. VM-A — proxy over **wss (enc-ON)**

Copy the **primary's cert** to VM-A and trust it via `NODE_EXTRA_CA_CERTS` (the stock proxy path
honors the host trust store / this env — never a global `NODE_TLS_REJECT_UNAUTHORIZED` bypass). With
a real publicly-trusted cert you can skip this entirely.

```bash
scp primary:~/plexus-primary-cert.pem ~/plexus-primary-cert.pem   # (or install into the system store)
mkdir -p /srv/proxy-a && echo 'from VM-A' > /srv/proxy-a/from-proxy-a.txt

cd ~/plexus
PLEXUS_MODE=proxy \
PLEXUS_WORKLOAD=proxy-a \
PLEXUS_WORKSPACE_DIR=/srv/proxy-a \
PLEXUS_UPSTREAM_URL=wss://${PRIMARY_IP}:8443 \
PLEXUS_UPSTREAM_PUBKEY='<primaryPubKey from the proxy-a mint>' \
PLEXUS_JOIN_TOKEN='<token from the proxy-a mint>' \
NODE_EXTRA_CA_CERTS="$HOME/plexus-primary-cert.pem" \
  bun run packages/runtime/src/index.ts
```

> Alternatively install the cert system-wide: `sudo cp ~/plexus-primary-cert.pem
> /usr/local/share/ca-certificates/plexus-primary.crt && sudo update-ca-certificates`, then drop
> `NODE_EXTRA_CA_CERTS`. An **untrusted** cert fails fast (the tunnel never authenticates) — that is
> the intended fail-closed behavior, not a silent hang.

## 5. VM-B — proxy over **ws (enc-OFF)**

No CA trust needed (plain ws). Identity is still Ed25519-mutual — `ws` drops only channel
confidentiality, not authentication. Use a **different workspace root** so it is distinct from VM-A.

```bash
mkdir -p /srv/proxy-b && echo 'from VM-B' > /srv/proxy-b/from-proxy-b.txt

cd ~/plexus
PLEXUS_MODE=proxy \
PLEXUS_WORKLOAD=proxy-b \
PLEXUS_WORKSPACE_DIR=/srv/proxy-b \
PLEXUS_UPSTREAM_URL=ws://${PRIMARY_IP}:8080 \
PLEXUS_UPSTREAM_PUBKEY='<primaryPubKey from the proxy-b mint>' \
PLEXUS_JOIN_TOKEN='<token from the proxy-b mint>' \
  bun run packages/runtime/src/index.ts
```

## 6. Drive the aggregated collection from the agent

On the **primary VM** (the agent's vantage; the connection-key lives at
`$HOME/.plexus/connection-key` or `$PLEXUS_HOME/connection-key`):

```bash
KEY=$(cat ~/.plexus/connection-key)
BASE=http://127.0.0.1:7077

# 1. Both proxies auto-mount under their provenance prefixes (default HIDDEN — join ≠ access).
curl -s "$BASE/admin/api/exposure" -H "X-Plexus-Connection-Key: $KEY" \
  | jq -r '.capabilities[].id | select(startswith("local/proxy-"))'

# 2. Owner enables exposure on each mounted address (deliberate access act):
for addr in $(curl -s "$BASE/admin/api/exposure" -H "X-Plexus-Connection-Key: $KEY" \
                | jq -r '.capabilities[].id | select(startswith("local/proxy-"))'); do
  enc=$(jq -rn --arg s "$addr" '$s|@uri')
  curl -s -X POST "$BASE/admin/api/exposure/$enc" \
    -H "X-Plexus-Connection-Key: $KEY" -H 'content-type: application/json' -d '{"enabled":true}'
done

# 3. ONE aggregated catalog: primary-own workspace.* + local/proxy-a/* + local/proxy-b/*
curl -s "$BASE/.well-known/plexus" | jq -r '.capabilities[].id'

# 4. Handshake → grant (consent any pend via PUT /admin/api/grants) → invoke each source.
#    See run-multihost-local.sh / run-multihost-docker.sh for the exact grant+invoke calls.
```

To drive it from a **workstation** instead, SSH-local-forward the loopback agent port
(`ssh -L 7077:127.0.0.1:7077 primary`) — keeps 7077 unexposed. Only if you must bind it LAN-wide,
use the configurable-binding seam (`~/.plexus/network.json` / the /admin Network panel) and treat the
connection-key as the trust boundary.

## 7. Lifecycle parity with the demos

- **Downtime** — stop VM-B's gateway: its `local/proxy-b/*` invoke returns a typed
  `capability_unavailable` (bounded by the forward deadline, no hang) while the primary + VM-A persist.
- **Revocation** — on the primary: `bun run packages/cli/src/bin/plexus mesh revoke proxy-a` →
  tombstones the enrollment, un-mounts its addresses, purges their grants, drops its socket. Its caps
  vanish from `.well-known`; a reconnect with the old key fails closed. Per-workload + terminal.

---

### Env reference (the load-bearing seams)

| Env | Role | Meaning |
|-----|------|---------|
| `PLEXUS_MODE` | both | unset = primary; `proxy` = dial out + enroll |
| `PLEXUS_WORKLOAD` | both | the workload identity this gateway claims (`proxy-a` / `proxy-b`) |
| `PLEXUS_WORKSPACE_DIR` | both | path-confined root for the `workspace` source |
| `PLEXUS_MESH_TUNNEL_HOST` | primary | bind host for the tunnel listener — `0.0.0.0` to be routable |
| `PLEXUS_MESH_WS_PORT` / `PLEXUS_MESH_WSS_PORT` | primary | fixed tunnel ports (enc-OFF / enc-ON) |
| `PLEXUS_MESH_TLS_CERT` / `PLEXUS_MESH_TLS_KEY` | primary | PEM cert+key for the wss listener |
| `PLEXUS_UPSTREAM_URL` | proxy | the primary tunnel endpoint to dial (`wss://ip:8443` / `ws://ip:8080`) |
| `PLEXUS_UPSTREAM_PUBKEY` | proxy | pinned primary Ed25519 pubkey (mandatory — no bare TOFU) |
| `PLEXUS_JOIN_TOKEN` | proxy | one-time enrollment token from `mesh mint` |
| `NODE_EXTRA_CA_CERTS` | proxy (wss) | trust a self-signed primary cert (omit for a real cert) |
