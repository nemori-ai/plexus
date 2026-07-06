# home-gateway — your machines, one front door (the personal-developer example)

Your resources live at **home** (notes, files, tools on your Mac). Your agent lives
somewhere else — **Claude Code on the office machine**, a laptop on hotel wifi. This
example publishes your home Plexus gateway under one hostname so that remote agent can
**discover → enroll → call** your capabilities from anywhere, while every mutating move
still pends for *you* and one revoke kills the agent everywhere.

No mesh, no cloud compute, no new trust story: the home machine **is** the primary, and
the tunnel is just reachability. This is the middle example of three:

| | example | shape |
|---|---|---|
| 1 | [`pomodoro-demo`](../pomodoro-demo/) / [`mesh-security-audit/local`](../mesh-security-audit/local/) | everything on one machine |
| **2** | **`home-gateway` (this)** | **one person, several machines: your agent → your front door** |
| 3 | [`mesh-security-audit/cloud`](../mesh-security-audit/cloud/) | the enterprise direction: an always-on resource-pool parent |

**Verified end-to-end** against a real Cloudflare named tunnel on a real domain
(`gw.vibecoding.icu`, 2026-07-06): install → enroll → standing read → pending write →
owner approve → write lands → revoke → next call fails closed.

---

## How it works (one paragraph)

The gateway keeps binding **loopback only**. An edge process (cloudflared here — but see
[Bring your own edge](#bring-your-own-edge)) dials **out** and maps
`https://gw.<your-domain>` → `http://127.0.0.1:7901`; no inbound port opens anywhere.
The one gateway-side switch is **`PLEXUS_PUBLIC_HOSTNAME`** (FEAT public-hostname): the
Host/Origin guard accepts the published hostname (and its `https://` origin, so the
`/admin` console works remotely too), and the hostname becomes the **canonical advertised
base** — `.well-known`, the auth advertisement, and the one-command install all hand the
remote agent URLs it can actually reach. Everything else (default-deny, PAT identity,
pends, audit, revoke) is the stock trust model doing its job over a longer wire.

## Prereqs

`bun`, `curl`, `jq`, `cloudflared` (`brew install cloudflared`) on the home machine; a
domain on your Cloudflare account for the default mode. Everything lands under
`~/PlexusDemo/home-gateway` (override: `DEMO_ROOT`) on port `7901`
(`PLEXUS_HOME_GATEWAY_PORT`) — your personal `~/.plexus:7077` is never touched.

## The default setup — a named tunnel on your own domain

One-time prep (a browser auth, then one script):

```bash
cd examples/home-gateway
cloudflared tunnel login          # browser: pick the zone (your domain)
./setup-tunnel.sh gw.<your-domain>   # creates the tunnel, routes the DNS, writes the config
```

Then, each time:

```bash
./up.sh --hostname gw.<your-domain>
#   → boots the gateway (public hostname wired), starts the connector,
#     and VERIFIES https://gw.<your-domain>/.well-known/plexus through the real edge.

./connect-agent.sh                # admin act: connect 'office-cc' with a STANDING read set
#   → prints the ONE-COMMAND install for the office machine
```

**On the office machine**, paste the printed command (it carries a single-use
`plx_enroll_…` code — the only secret that ever travels, dead after one redemption):

```bash
curl -fsSL https://gw.<your-domain>/integration/office-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

That materializes the per-agent plugin, pins the gateway to the public URL, and redeems
the code for a durable per-agent PAT (stored `0600`). If `claude` is present it also
registers the plugin so the capabilities feel native in Claude Code; without it you still
get the full launcher. Then:

```bash
plexus-office-cc list                                  # discover: callable-now vs needs-approval
plexus-office-cc workspace.read Welcome.md             # standing read — just works
plexus-office-cc workspace.write --input '{"path":"office-note.md","content":"hi from the office"}'
#   → PENDS. The launcher tells you where to approve; the call is NOT made.
```

**Approve from anywhere**: open `https://gw.<your-domain>/admin` (connection-key gated —
the key is at `$DEMO_ROOT/home/connection-key` and never leaves your side), Approvals →
approve with a trust-window. Pick a real window (`1h`/`1d`) if you want the re-run to just
work; a `once` approval authorizes exactly one already-pending call and deliberately never
short-circuits the next request. Re-run the write — the file lands in the home workspace.

The kill switch:

```bash
./revoke-agent.sh office-cc
# office side, next call:
#   plexus: handshake failed (invalid or revoked agent PAT …)   ← fails closed
```

Audit everything at `/admin` → Activity (or `GET /admin/api/audit`): handshake, grants,
pends, invokes (including denials), revoke — the whole story, per agent.

Teardown: `./down.sh` (state kept for inspection; `--purge` wipes).

## The zero-account test-drive — quick tunnel

```bash
./up.sh --quick     # trycloudflare.com, random hostname, no CF account
```

Same story on a throwaway hostname. **Network reality check:** many networks — notably in
mainland China, plus some corporate resolvers — filter `trycloudflare.com` at the DNS
layer (even queries addressed to `8.8.8.8` come back NXDOMAIN when port 53 is
intercepted). `up.sh` preflights this and tells you explicitly to use the named mode
instead of leaving you staring at timeouts. The named tunnel on your own domain is
unaffected — which is exactly why it is the default.

## Bring your own edge

`PLEXUS_PUBLIC_HOSTNAME` is **edge-neutral** — the gateway only needs to know what
hostname it was published under. Anything that maps `https://<hostname>` to
`http://127.0.0.1:7901` works:

- **frp** on a VPS you own (the de-facto standard for many developers in China),
- **Tailscale Funnel** (`tailscale funnel 7901`),
- a plain **reverse proxy** (Caddy/nginx) on any box with a public address.

Run your edge however you like, then `PLEXUS_PUBLIC_HOSTNAME=<hostname> ./up.sh
--hostname <hostname>` (with no local connector config, up.sh assumes your edge is
already routing).

## What publishing actually exposes (read this once)

- `/.well-known/plexus` becomes **public metadata**: capability ids + labels (summaries —
  not schemas, not skills, not data). That is the designed pre-session tier; if even
  window-shopping is too much, put Cloudflare Access in front of the hostname (service
  token for the agent, email OTP for `/admin`) — the gateway composes fine behind it.
- **Authority never travels with reachability.** Reaching the gateway buys an agent
  nothing: enrollment needs a code you minted, calls need grants you approved, `execute`
  never rides a standing grant, and the connection-key is admin-only and never appears on
  any wire the agent sees.
- The `/admin` console over the public hostname is connection-key gated and https-origin
  checked; the key itself lives only in `$DEMO_ROOT/home/connection-key` on the home
  machine (read it there; never mail it to yourself in plaintext).
- Quick-tunnel hostnames rotate per run, so a leaked old URL points at nothing. Your named
  hostname is stable — treat it like any other service you run: keep the gateway updated,
  revoke agents you stop using.

## Files

| file | role |
|---|---|
| `setup-tunnel.sh` | one-time: create the named tunnel, route the DNS, write the connector config |
| `up.sh` | boot gateway + connector (`--hostname` default mode; `--quick` test-drive with DNS preflight) |
| `connect-agent.sh` | admin act: standing read set + the one-command install (write deliberately NOT granted) |
| `revoke-agent.sh` | revoke one agent completely; the next call fails closed |
| `down.sh` | stop both processes; `--purge` wipes state |
