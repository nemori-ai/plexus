# Cloudflare Tunnel — publish the cloud parent on YOUR domain

This is the **edge** half of Option A. The Fly parent runs `cloudflared` co-located with the
stock gateway (baked into `Dockerfile.edge` via `start.sh`); `cloudflared` dials **out** to
Cloudflare and publishes two public hostnames on **your** domain that map to the gateway's
loopback ports:

| public hostname            | → origin (on the Fly Machine) | carries                                   |
|----------------------------|-------------------------------|-------------------------------------------|
| `wss://mesh.<domain>`      | `http://localhost:8080`       | the mesh tunnel (children dial this)      |
| `https://plexus.<domain>`  | `http://localhost:7077`       | the agent-facing HTTP surface             |

TLS terminates at the Cloudflare edge. The Ed25519 mesh mutual-auth (pinned
`PLEXUS_UPSTREAM_PUBKEY`) is app-layer, so plain `ws`/`http` between `cloudflared` and the
gateway over loopback is fine — the child's identity boundary is the pinned key, not the
transport cert.

**Host header (load-bearing):** `cloudflared` forwards the ORIGINAL public Host
(`plexus.<domain>`) to the origin, and the gateway's Host/Origin guard rejects any
authority the owner didn't publish. `fly.toml` therefore sets
`PLEXUS_PUBLIC_HOSTNAME = "plexus.<domain>"` (FEAT public-hostname) — do NOT work around
it with an ingress Host-header override: the same setting also makes the gateway advertise
`https://plexus.<domain>` as its canonical base, which remote agents need anyway. Cloudflare supports WebSockets by default, and `cloudflared` performs the
`Upgrade` when the origin is `http://` (which is why the ingress `service:` is `http://…:8080`,
not `ws://`). See Cloudflare's WebSocket support:
<https://developers.cloudflare.com/network/websockets/>.

> **YOU do all of this, with YOUR OWN Cloudflare account + a domain (zone) on it.** We do not
> create a tunnel or touch your DNS. The commands below were NOT run here (`cloudflared` was
> not installed in the authoring environment); they are transcribed from Cloudflare's docs —
> validate against the linked pages.

---

## Prerequisites

- A domain whose **zone is active on your Cloudflare account** (so you can add hostnames under
  it, e.g. `mesh.example.com`).
- `cloudflared` installed locally to create the tunnel + routes (you do NOT need it running
  locally afterwards — it runs on Fly): <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>.
- The Fly parent already deployed (`./deploy-parent.sh`) — or deploy it right after you have
  the `TUNNEL_TOKEN`.

---

## Steps (CLI path — dashboard-managed / token tunnel, recommended)

Reference: **Create a remotely-managed tunnel**
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/>
and **Routing to a tunnel / public hostnames**
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/dns/>.

```bash
# 1. Authenticate cloudflared to your Cloudflare account (opens a browser; pick your zone).
cloudflared tunnel login

# 2. Create the named tunnel. Prints a tunnel UUID + writes a credentials file locally.
cloudflared tunnel create plexus-parent

# 3. Route the two public hostnames to this tunnel (creates the DNS CNAMEs for you).
cloudflared tunnel route dns plexus-parent mesh.<your-domain>
cloudflared tunnel route dns plexus-parent plexus.<your-domain>

# 4. Get the connector TOKEN — this is the ONLY secret the Fly Machine needs.
cloudflared tunnel token plexus-parent
#   → copy the printed token; set it on Fly (deploy-parent.sh does this if TUNNEL_TOKEN is set):
TUNNEL_TOKEN='<paste-token>' ./deploy-parent.sh
#   …or, if the parent is already deployed:
fly secrets set TUNNEL_TOKEN='<paste-token>' -a plexus-parent
```

### Attach the ingress (public hostname → service) rules

For a **token / remotely-managed** tunnel the ingress rules live in the **Cloudflare Zero
Trust dashboard**, not in a local file:

1. Zero Trust → **Networks → Tunnels →** `plexus-parent` → **Public Hostnames → Add**.
2. Add hostname `mesh.<domain>` → **Type:** `HTTP` → **URL:** `localhost:8080`.
3. Add hostname `plexus.<domain>` → **Type:** `HTTP` → **URL:** `localhost:7077`.

(`localhost` = the gateway on the same Fly Machine as `cloudflared`.) The exact routing is
mirrored, for reference, in [`cloudflared-config.example.yml`](./cloudflared-config.example.yml).

> Steps 3 and the dashboard hostnames are two views of the same thing — `route dns` creates the
> `*.cfargotunnel.com` CNAME; the Public Hostname entry maps that hostname to the origin
> service. If you added the hostname in the dashboard first, it already created the DNS record.

---

## Verify (after the parent is deployed with the token)

```bash
# The agent surface should answer through the edge (well-known is public, unauthenticated):
curl -sS https://plexus.<your-domain>/.well-known/plexus | jq '.capabilities | length'

# cloudflared health, from the Fly Machine's logs:
fly logs -a plexus-parent | grep -i cloudflared
```

A child then dials `wss://mesh.<your-domain>` — see `./mint-join.sh`, `./mac-child.sh`,
`./linux-child.sh`.

---

## Locally-managed alternative (optional)

If you prefer a config-file tunnel instead of a token, run
`cloudflared tunnel --config cloudflared-config.example.yml run` and bake the config +
credentials file into the image rather than passing `TUNNEL_TOKEN`. The ingress in
[`cloudflared-config.example.yml`](./cloudflared-config.example.yml) is then read directly.
The token path is fewer moving parts; prefer it unless you have a reason not to.
