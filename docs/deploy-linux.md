# Deploy the headless Plexus gateway on a Linux server

This is the runbook for running the **minimal headless Plexus gateway on a bare Linux
server** — no desktop, no Electron, no macOS. It is the "remote Linux server" option the
onboarding docs point at.

On Linux the gateway is a **portable capability gateway**: the source registry auto-gates
the **active** first-party sources to the platform-portable set — **`workspace`** (path-confined
filesystem access) and **`sysinfo`** (read-only system stats + a path-jailed log tail). The
macOS-native sources (`apple-calendar`, `apple-reminders`, `things`) and the exec sources
(`codex`, `claudecode`) stay *reserved-but-inactive* — advertised on no platform where they
cannot actually run. Everything else — default-deny, per-capability scoped grants, owner
approval for `write`/`execute`, the audit trail, per-agent enrollment/PAT — behaves exactly as
on macOS.

> This path is **verified end-to-end on a real Linux kernel** (Ubuntu 22.04 + Bun, in Docker).
> The re-runnable proof is [`tests/docker-linux-e2e.sh`](../tests/docker-linux-e2e.sh)
> (`bash run-tests.sh --gate linux-docker`).

---

## Option A — run it directly (bun on the host)

**Prerequisites:** a Linux box (glibc; x86_64 or arm64), outbound HTTPS to install Bun, and a
non-root user to own the gateway state.

```bash
# 1. Install Bun (the runtime — Plexus targets bun >= 1.3.0).
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"          # or restart your shell
bun --version

# 2. Get the repo + install dependencies (fresh Linux install — do NOT copy a macOS
#    node_modules or lockfile artifact over).
git clone <your-plexus-remote> plexus && cd plexus
bun install

# 3. Build the /admin console SO the headless box serves the FULL management UI,
#    not just the agent API. (The runtime serves it from packages/web-admin/dist.)
bun run --cwd packages/web-admin build

# 4. Point the gateway at a dedicated state directory and boot it. PLEXUS_HOME holds the
#    connection-key, the token-signing secret, the Ed25519 mesh identity, and the audit dir.
#    The gateway binds 127.0.0.1 ONLY (loopback) — never 0.0.0.0.
export PLEXUS_HOME="$HOME/.plexus"          # or any dir this user owns
bun run start                                # (equivalently: bun run serve)
```

The gateway prints a machine-readable `PLEXUS_READY {"port":7077,...}` line once bound, then
serves:

- the **agent surface** + discovery at `http://127.0.0.1:7077/.well-known/plexus`,
- the **admin console** at `http://127.0.0.1:7077/admin` (connection-key gated).

Because the bind is **loopback-only**, reach a remote box's console over an **SSH tunnel**
(`ssh -L 7077:127.0.0.1:7077 user@server`) rather than exposing the port. The connection-key
lives at `$PLEXUS_HOME/connection-key` on the server; the desktop app is not involved on a
headless box, so read it there when a client asks for it.

### Connect an agent (headless)

The whole loop is HTTP against the connection-key-gated admin API and the agent's own `plexus`
CLI (`tools/plexus-cli/plexus`, a zero-dependency Node/Bun script):

```bash
KEY=$(cat "$PLEXUS_HOME/connection-key")
GW=http://127.0.0.1:7077

# (a) Optionally materialize the onboarding demo (two workspace-dir sources: demo-intro with
#     approval:auto, your-secret with approval:"ask"). Keep the files inside your state dir.
curl -s -X POST -H "X-Plexus-Connection-Key: $KEY" -H 'content-type: application/json' \
  -d "{\"path\":\"$PLEXUS_HOME/PlexusDemo\"}" "$GW/admin/api/demo-workspace"

# (b) Connect an agent → mint a one-time enrollment code (+ optional starting grants).
curl -s -X POST -H "X-Plexus-Connection-Key: $KEY" -H 'content-type: application/json' \
  -d '{"agentId":"my-agent"}' "$GW/admin/api/agents/connect"     # → { "code": "plx_enroll_..." }

# (c) The agent redeems the code for its durable PAT (stored under ITS OWN home, never the
#     admin key), then calls capabilities natively.
PLEXUS_HOME=/home/agent/.plexus PLEXUS_GATEWAY=$GW PLEXUS_AGENT_ID=my-agent \
  bun tools/plexus-cli/plexus enroll plx_enroll_...
PLEXUS_HOME=/home/agent/.plexus PLEXUS_GATEWAY=$GW PLEXUS_AGENT_ID=my-agent \
  bun tools/plexus-cli/plexus list
```

An `approval:"ask"` call (e.g. `your-secret.read`) **pends** — resolve it from the admin API
(`GET /admin/api/pending` → `POST /admin/api/pending/:id` with `{"action":"approve"|"deny"}`)
or the `/admin` console over your SSH tunnel.

---

## Option B — run it in Docker

The stock gateway image (`docker/Dockerfile`) is the same binary a real Ubuntu VM runs — it
installs deps fresh on Linux **and builds the /admin console into the image**, so a container
serves the full console too.

```bash
# Build (REPO ROOT as context — the Dockerfile lives in docker/):
docker build -f docker/Dockerfile -t plexus-gateway:latest .

# Run headless, gateway state on a container-internal PLEXUS_HOME (never bind-mount a host
# secret dir), loopback published to the host:
docker run --rm -e PLEXUS_HOME=/state -p 127.0.0.1:7077:7077 plexus-gateway:latest
```

Then drive it exactly as in Option A, running the admin `curl` calls and the agent `plexus`
CLI **inside** the container (`docker exec`) so the loopback Host header always matches — this
is precisely what [`tests/docker-linux-e2e.sh`](../tests/docker-linux-e2e.sh) automates.

For a **locked-down single-folder** appliance (read-only rootfs, `cap-drop=ALL`, a curated
manifest) see [`examples/appliance/`](../examples/appliance/README.md). For a **mesh proxy**
that dials a primary over `wss` (NAT-friendly, no inbound ports) see the proxy recipe in
`docker/Dockerfile`'s header and [`docker/compose.mesh.yml`](../docker/compose.mesh.yml).

---

## What to remember

- **Loopback only.** The gateway binds `127.0.0.1`. To reach a remote console, tunnel — do not
  publish the port. Publishing it (`PLEXUS_PUBLIC_HOSTNAME`) is a deliberate, separately-documented
  step that makes the connection-key the trust boundary (front it with Cloudflare Access).
- **`PLEXUS_HOME` is the secret dir.** connection-key + signing secret + mesh identity live there.
  Give the gateway its own state dir; give each agent a *different* home (the agent stores only its
  own PAT — the admin connection-key is never written to an agent's home, ADR-019).
- **Build the console.** `packages/web-admin/dist` is a local build artifact (gitignored); without
  the `web-admin build` step the box boots API-only with a "console never built" warning.
