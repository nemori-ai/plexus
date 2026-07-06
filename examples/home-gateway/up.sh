#!/usr/bin/env bash
#
# up.sh — boot the HOME gateway + publish it through a tunnel edge.
#
# The gateway-side feature (FEAT public-hostname) is EDGE-NEUTRAL: anything that
# maps https://<hostname> → http://127.0.0.1:7901 works (cloudflared, frp,
# Tailscale Funnel, a VPS reverse proxy). This script ships the cloudflared
# recipes; the published hostname is accepted by the Host/Origin guard and
# becomes the CANONICAL advertised base, so a remote agent reads reachable
# endpoint URLs.
#
#   ./up.sh --hostname gw.example.com          ← THE DEFAULT SETUP (named tunnel,
#       your own Cloudflare domain — stable, works on filtered networks).
#       One-time prep: ./setup-tunnel.sh gw.example.com (after
#       `cloudflared tunnel login`). Alternatives, in precedence order:
#       a dashboard-token tunnel (TUNNEL_TOKEN=… in the env), or ANY external
#       connector you run yourself (frp / funnel / VPS — just point it at :7901).
#
#   ./up.sh --quick
#       Zero-account TEST-DRIVE via a Cloudflare QUICK tunnel (trycloudflare.com).
#       The hostname is RANDOM and dies with the process. Heads-up: many networks
#       (notably in China, plus some corporate DNS filters) BLOCK trycloudflare.com
#       at the DNS layer — a preflight below detects that and tells you to use the
#       named mode instead of leaving you staring at timeouts.
#
# Isolated by design: PLEXUS_HOME + workspace + logs live under DEMO_ROOT
# (default ~/PlexusDemo/home-gateway) on a NON-default port (7901), so this
# never touches a personal gateway on ~/.plexus:7077. Idempotent + re-runnable:
# an already-running pair is torn down first.
set -euo pipefail

DEMO_ROOT="${DEMO_ROOT:-$HOME/PlexusDemo/home-gateway}"
PORT="${PLEXUS_HOME_GATEWAY_PORT:-7901}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGS="$DEMO_ROOT/logs"
# cloudflared's default QUIC transport is UDP — commonly broken behind VPNs /
# fake-IP proxy DNS (dial errors to 198.18.x.x) and some ISPs. http2 rides plain
# outbound TLS/443 and is the reliable default for a home box; override if you
# know your network passes QUIC: CLOUDFLARED_PROTOCOL=quic ./up.sh …
CF_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"

die() { echo "[up] ERROR: $*" >&2; exit 1; }

command -v bun >/dev/null || die "bun is required (https://bun.sh)"
command -v cloudflared >/dev/null || die "cloudflared is required (brew install cloudflared)"
command -v curl >/dev/null || die "curl is required"

MODE="" HOSTNAME_ARG=""
case "${1:-}" in
  --hostname) MODE="named"; HOSTNAME_ARG="${2:-}"; [ -n "$HOSTNAME_ARG" ] || die "--hostname needs a value (e.g. gw.example.com)" ;;
  --quick) MODE="quick" ;;
  *) die "usage: ./up.sh --hostname gw.example.com   (the default setup; see setup-tunnel.sh)
       ./up.sh --quick                    (zero-account test-drive, network permitting)" ;;
esac

mkdir -p "$DEMO_ROOT" "$LOGS" "$DEMO_ROOT/home" "$DEMO_ROOT/workspace" "$DEMO_ROOT/exec-jail"

# Re-runnable: stop a previous pair first (same pidfiles down.sh uses; pids are
# the REAL processes — see the exec launches below).
for pf in "$DEMO_ROOT/gateway.pid" "$DEMO_ROOT/cloudflared.pid"; do
  if [ -f "$pf" ]; then
    kill "$(cat "$pf")" 2>/dev/null || true
    rm -f "$pf"
  fi
done
sleep 1
# Fail EARLY if something else still owns the port — a half-killed previous run
# would otherwise answer the loopback probe and mask a crashed new gateway.
if lsof -ti ":$PORT" >/dev/null 2>&1; then
  die "port $PORT is already in use (lsof -i :$PORT) — stop that process first"
fi

# Seed the workspace so the remote agent has something real to read.
if [ ! -f "$DEMO_ROOT/workspace/Welcome.md" ]; then
  cat > "$DEMO_ROOT/workspace/Welcome.md" << 'NOTE'
# Welcome home

This note lives on the HOME machine, inside the one directory the owner
authorized (`PLEXUS_WORKSPACE_DIR`). A remote agent reading this proves the
read leg; writing a new note here PENDS for the owner — that approval is the
whole point.
NOTE
fi

PUBLIC_HOSTNAME=""
if [ "$MODE" = "quick" ]; then
  # PREFLIGHT: many networks filter trycloudflare.com at the DNS layer (system
  # resolvers — even queries addressed to 8.8.8.8 — return NXDOMAIN while the
  # domain is genuinely live). Detect that up front and route the user to the
  # named mode instead of letting the run die in confusing timeouts.
  if ! nslookup trycloudflare.com >/dev/null 2>&1; then
    if curl -sf -m 10 "https://cloudflare-dns.com/dns-query?name=trycloudflare.com&type=A" \
        -H 'accept: application/dns-json' | grep -q '"Answer"'; then
      die "your network's DNS filters trycloudflare.com (it resolves fine over DoH) — quick tunnels
       won't work here. Use the default named mode on your own domain instead:
         cloudflared tunnel login && ./setup-tunnel.sh gw.<your-domain>
         ./up.sh --hostname gw.<your-domain>"
    fi
    die "cannot resolve trycloudflare.com (is this machine online?)"
  fi
  # trycloudflare provisioning occasionally 500s (error 1101) — launch is cheap,
  # so retry the whole cloudflared process a few times before giving up.
  for attempt in 1 2 3; do
    echo "[up] starting a Cloudflare QUICK tunnel → http://127.0.0.1:$PORT (no account needed; attempt $attempt)…"
    # Truncate the log BEFORE launch so this attempt's poll can't match a prior attempt's
    # stale success/error line (which would break early and kill a healthy fresh tunnel).
    : > "$LOGS/cloudflared.log"
    # exec ⇒ $! is cloudflared ITSELF (not a wrapper subshell), so down.sh's kill is real.
    (exec cloudflared tunnel --no-autoupdate --protocol "$CF_PROTOCOL" --url "http://127.0.0.1:$PORT" > "$LOGS/cloudflared.log" 2>&1) &
    echo $! > "$DEMO_ROOT/cloudflared.pid"
    # The random hostname appears in cloudflared's own output — poll for it.
    for _ in $(seq 1 40); do
      PUBLIC_HOSTNAME="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/cloudflared.log" 2>/dev/null | head -1 | sed 's|https://||')" || true
      [ -n "$PUBLIC_HOSTNAME" ] && break
      grep -q "failed to unmarshal quick Tunnel" "$LOGS/cloudflared.log" 2>/dev/null && break
      sleep 0.5
    done
    [ -n "$PUBLIC_HOSTNAME" ] && break
    kill "$(cat "$DEMO_ROOT/cloudflared.pid")" 2>/dev/null || true
    rm -f "$DEMO_ROOT/cloudflared.pid"
    sleep 2
  done
  [ -n "$PUBLIC_HOSTNAME" ] || die "quick tunnel did not print a trycloudflare.com URL after 3 attempts (see $LOGS/cloudflared.log)"
  echo "[up] quick tunnel is up: https://$PUBLIC_HOSTNAME (random; dies with this process)"
else
  PUBLIC_HOSTNAME="$HOSTNAME_ARG"
  CF_CONFIG="$DEMO_ROOT/cloudflared-config.yml"
  if [ -f "$CF_CONFIG" ]; then
    # The setup-tunnel.sh path (locally-managed named tunnel — the default setup).
    echo "[up] starting the named-tunnel connector (config: $CF_CONFIG)…"
    (exec cloudflared tunnel --no-autoupdate --protocol "$CF_PROTOCOL" --config "$CF_CONFIG" run > "$LOGS/cloudflared.log" 2>&1) &
    echo $! > "$DEMO_ROOT/cloudflared.pid"
  elif [ -n "${TUNNEL_TOKEN:-}" ]; then
    # Dashboard-token tunnel (remotely-managed ingress).
    echo "[up] starting the named-tunnel connector (token from env)…"
    (exec cloudflared tunnel --no-autoupdate --protocol "$CF_PROTOCOL" run --token "$TUNNEL_TOKEN" > "$LOGS/cloudflared.log" 2>&1) &
    echo $! > "$DEMO_ROOT/cloudflared.pid"
  else
    # BYO edge: frp / Tailscale Funnel / a VPS reverse proxy / cloudflared elsewhere.
    echo "[up] no local connector config — assuming YOUR edge routes https://$PUBLIC_HOSTNAME → http://localhost:$PORT"
  fi
fi

echo "[up] starting the home gateway (PLEXUS_HOME=$DEMO_ROOT/home, port $PORT, public hostname $PUBLIC_HOSTNAME)…"
# Direct entrypoint (not the `start` npm-script) + exec ⇒ ONE process, and $! IS
# the gateway, so down.sh's kill genuinely stops it (no orphan on the port).
# ENV HYGIENE: unset tool-home redirects the launching terminal may carry (an IDE/agent
# shell often sets CODEX_HOME to its own runtime dir). The exec sandbox allowlists the
# STANDARD homes (~/.codex, ~/.claude) — an inherited redirect points the sandboxed tool
# at a path the seatbelt rightly denies ("Operation not permitted" on config.toml).
(
  cd "$REPO_ROOT"
  exec env \
    -u CODEX_HOME \
    -u CLAUDE_CONFIG_DIR \
    PLEXUS_HOME="$DEMO_ROOT/home" \
    PLEXUS_PORT="$PORT" \
    PLEXUS_INSTANCE="home-gateway" \
    PLEXUS_PUBLIC_HOSTNAME="$PUBLIC_HOSTNAME" \
    PLEXUS_WORKSPACE_DIR="$DEMO_ROOT/workspace" \
    PLEXUS_CODEX_AUTHORIZED_DIR="$DEMO_ROOT/exec-jail" \
    bun packages/runtime/bin/plexus > "$LOGS/gateway.log" 2>&1
) &
echo $! > "$DEMO_ROOT/gateway.pid"

# Wait for the loopback surface, then PROVE the edge path with the real public URL.
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/.well-known/plexus" && break
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/.well-known/plexus" || die "gateway did not come up (see $LOGS/gateway.log)"

echo "[up] gateway is up on loopback; verifying the PUBLIC edge path…"
EDGE_OK="" EDGE_CURL=(curl -sf)
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "https://$PUBLIC_HOSTNAME/.well-known/plexus"; then EDGE_OK=1; break; fi
  sleep 1
done
if [ -z "$EDGE_OK" ]; then
  # A LOCAL proxy/VPN (fake-IP DNS, TLS interception) can block this machine's view
  # of the edge while the tunnel is fine for everyone else. Cross-check by resolving
  # the real Cloudflare IP over DoH and pinning it — if THAT works, the tunnel is up
  # and only the local network path is lying.
  # `|| true` OUTSIDE the substitution: under `set -euo pipefail` a failing DoH curl (the
  # fully-offline case this fallback exists to diagnose) would otherwise abort the whole
  # script silently before the intended `die` below.
  REAL_IP="$(curl -sf "https://cloudflare-dns.com/dns-query?name=$PUBLIC_HOSTNAME&type=A" \
    -H 'accept: application/dns-json' 2>/dev/null | (command -v jq >/dev/null && jq -r '.Answer[0].data // empty' || true) || true)"
  if [ -n "$REAL_IP" ] && curl -sf --resolve "$PUBLIC_HOSTNAME:443:$REAL_IP" -o /dev/null "https://$PUBLIC_HOSTNAME/.well-known/plexus"; then
    EDGE_OK=1
    EDGE_CURL=(curl -sf --resolve "$PUBLIC_HOSTNAME:443:$REAL_IP")
    echo "[up] WARNING: the edge answers (verified via pinned IP $REAL_IP), but THIS machine's" >&2
    echo "[up]          default network path to it is blocked (local proxy/VPN?). Remote machines" >&2
    echo "[up]          are unaffected; to test from here, bypass the proxy for $PUBLIC_HOSTNAME." >&2
  fi
fi
[ -n "$EDGE_OK" ] || die "https://$PUBLIC_HOSTNAME/.well-known/plexus is not reachable through the edge (see $LOGS/cloudflared.log)"

ADVERTISED="$("${EDGE_CURL[@]}" "https://$PUBLIC_HOSTNAME/.well-known/plexus" | (command -v jq >/dev/null && jq -r '.gateway.baseUrl' || cat))"

cat << SUMMARY

[up] ✅ the home gateway is PUBLISHED.

  public URL      : https://$PUBLIC_HOSTNAME
  advertised base : $ADVERTISED       (remote agents read endpoints from this)
  admin console   : https://$PUBLIC_HOSTNAME/admin   (connection-key gated — works from anywhere)
  connection-key  : $DEMO_ROOT/home/connection-key   (NEVER give this to an agent)
  workspace       : $DEMO_ROOT/workspace
  logs            : $LOGS/{gateway,cloudflared}.log

Next: ./connect-agent.sh  → prints the one-command install for the OFFICE machine.
SUMMARY
