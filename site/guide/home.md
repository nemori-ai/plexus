---
title: Level 2 · Reach it from anywhere
description: Publish your home Plexus gateway under one hostname so your agent on another machine can discover, enroll, and call your capabilities over a tunnel — reads stand, writes pend for you, one revoke fails closed.
---

# Level 2 · Reach it from anywhere

**Who this is for:** your resources live at **home** (notes, files, tools on your Mac); your
agent lives **elsewhere** — Claude Code on the office machine, a laptop on hotel wifi. This
setup publishes your home gateway under one hostname so that remote agent can **discover →
enroll → call** your capabilities from anywhere, while every mutating move still pends for
*you* and one revoke kills the agent everywhere.

No mesh, no cloud compute, no new trust story: the home machine **is** the gateway (the
[Level 1](/guide/local) one), and the tunnel is just reachability. It runs end-to-end from
[`examples/home-gateway`](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway),
verified against a real Cloudflare named tunnel on a real domain.

## Fastest: let your agent do it

Copy the prompt, paste it into Claude Code or Codex on your **home machine** — it reads the
`home-gateway` recipe, publishes the gateway under your hostname, and prints the one-command
install for your other machine, pausing for your decisions and approvals.

<GetStartedSelector :scenario="'remote'" />

---

## By hand — what the agent does for you

The rest of this page is the same setup, step by step.

## How it works (one paragraph)

The gateway keeps binding **loopback only**. An edge process (`cloudflared` here — but any
edge works) dials **out** and maps `https://gw.<your-domain>` → `http://127.0.0.1:7901`; no
inbound port opens anywhere. The one gateway-side switch is **`PLEXUS_PUBLIC_HOSTNAME`**
(FEAT public-hostname): the Host/Origin guard accepts the published hostname (and its
`https://` origin, so the `/admin` console works remotely too), and the hostname becomes the
**canonical advertised base** — `.well-known`, the auth advertisement, and the one-command
install all hand the remote agent URLs it can actually reach. Everything else (default-deny,
PAT identity, pends, audit, revoke) is the [Level 1](/guide/local) trust model over a longer
wire.

## Prerequisites

`bun`, `curl`, `jq`, `cloudflared` (`brew install cloudflared`) on the home machine; a domain
on your Cloudflare account for the default (named-tunnel) mode. Everything lands under
`~/PlexusDemo/home-gateway` on port `7901`, so your personal `~/.plexus:7077` is never touched.

## The default setup — a named tunnel on your own domain

One-time prep (a browser auth, then one script), from `examples/home-gateway/`:

```sh
cloudflared tunnel login             # browser: pick the zone (your domain)
./setup-tunnel.sh gw.<your-domain>   # creates the tunnel, routes the DNS, writes the config
```

Then, each time:

```sh
./up.sh --hostname gw.<your-domain>
#   → boots the gateway (public hostname wired), starts the connector, and VERIFIES
#     https://gw.<your-domain>/.well-known/plexus through the real edge.

./connect-agent.sh                   # admin act: connect 'office-cc' with a STANDING read set
#   → prints the ONE-COMMAND install for the office machine
```

**On the office machine**, paste the printed command — it carries a single-use `plx_enroll_…`
code (the only secret that ever travels, dead after one redemption):

```sh
curl -fsSL https://gw.<your-domain>/integration/office-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

That materializes the per-agent plugin, pins the gateway to the public URL, and redeems the
code for a durable per-agent PAT. Then:

```sh
plexus-office-cc list                                  # discover: callable-now vs needs-approval
plexus-office-cc workspace.read Welcome.md             # standing read — just works
plexus-office-cc workspace.write --input '{"path":"office-note.md","content":"hi from the office"}'
#   → PENDS. The launcher waits; approve it and the call goes through.
```

**Approve from anywhere:** open `https://gw.<your-domain>/admin` (connection-key gated — the
key never leaves your side), Approvals → approve with a trust-window. The write lands in the
home workspace. Then the kill switch: `./revoke-agent.sh office-cc` — the office side's very
next call fails closed. Audit the whole story at `/admin` → Activity.

## The zero-account test-drive — quick tunnel

```sh
./up.sh --quick     # trycloudflare.com, random hostname, no CF account
```

Same story on a throwaway hostname. **Network reality check:** many networks — notably in
mainland China, plus some corporate resolvers — filter `trycloudflare.com` at the DNS layer;
`up.sh` preflights this and points you at the named mode instead of leaving you on a timeout.
The named tunnel on your own domain is unaffected — which is why it's the default.

## Bring your own edge

`PLEXUS_PUBLIC_HOSTNAME` is **edge-neutral** — the gateway only needs to know what hostname it
was published under. Anything that maps `https://<hostname>` to `http://127.0.0.1:7901` works:
**frp** on a VPS, **Tailscale Funnel** (`tailscale funnel 7901`), or a plain **reverse proxy**
(Caddy/nginx). Run your edge, then `PLEXUS_PUBLIC_HOSTNAME=<hostname> ./up.sh --hostname <hostname>`.

## What publishing actually exposes (read this once)

- `/.well-known/plexus` becomes **public metadata**: capability ids + labels (summaries — not
  schemas, not data). That's the designed pre-session tier; if even window-shopping is too
  much, put **Cloudflare Access** in front of the hostname (service token for the agent, email
  OTP for `/admin`) — the gateway composes cleanly behind it.
- **Authority never travels with reachability.** Reaching the gateway buys an agent nothing:
  enrollment needs a code you minted, calls need grants you approved, `execute` never rides a
  standing grant, and the connection-key is admin-only and appears on no agent-reachable route.
- The `/admin` console over the public hostname stays connection-key gated and https-origin
  checked; the key lives only in `$DEMO_ROOT/home/connection-key` on the home machine.

## Next steps

- **[Level 3 · A resource pool for a fleet →](/guide/fleet)** — when the resources belong to a
  team, not a person.
- **[The security model](/architecture/security-model)** — the trust boundary, and what
  publishing does and doesn't expose (the authoritative treatment).
