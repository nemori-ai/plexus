#!/usr/bin/env bash
#
# start.sh — the CLOUD parent Machine's entrypoint (baked into Dockerfile.edge).
#
# Runs TWO things in one container:
#   1. cloudflared — the Cloudflare edge connector. Dials OUT to Cloudflare (no inbound
#      ports on Fly), and — per your tunnel's ingress rules (dashboard-managed, keyed by
#      TUNNEL_TOKEN; see cloudflared.md) — forwards:
#          wss://mesh.<domain>    → http://127.0.0.1:8080   (mesh tunnel, ws upgrade)
#          https://plexus.<domain> → http://127.0.0.1:7077  (agent-facing HTTP)
#      Wrapped in a restart loop so a dropped tunnel self-heals WITHOUT taking the
#      gateway down.
#   2. the STOCK Plexus gateway (packages/runtime/src/index.ts) as the FOREGROUND process,
#      so Fly tracks ITS health and it owns the volume-backed /state.
#
# TUNNEL_TOKEN is set as a Fly secret (deploy-parent.sh / `fly secrets set`). All Plexus
# env (PLEXUS_*) comes from fly.toml [env]. Nothing here is Plexus-specific config — it is
# purely the process supervisor.
set -uo pipefail

if [ -n "${TUNNEL_TOKEN:-}" ]; then
  echo "[edge] starting cloudflared connector (ingress managed by your CF tunnel)…" >&2
  (
    while true; do
      cloudflared tunnel --no-autoupdate run --token "${TUNNEL_TOKEN}" || true
      echo "[edge] cloudflared exited — restarting in 3s (gateway stays up)…" >&2
      sleep 3
    done
  ) &
else
  echo "[edge] WARNING: TUNNEL_TOKEN is unset — booting the gateway WITHOUT the Cloudflare" >&2
  echo "[edge]          edge connector. Children will not be able to reach this parent until" >&2
  echo "[edge]          you \`fly secrets set TUNNEL_TOKEN=…\` and redeploy. See cloudflared.md." >&2
fi

# The stock gateway. /app is the repo root inside the stock image (deps installed at build).
cd /app || { echo "[edge] FATAL: /app not found (is this the plexus-gateway base image?)" >&2; exit 1; }
echo "[edge] starting the stock Plexus gateway (primary; PLEXUS_HOME=${PLEXUS_HOME:-/state})…" >&2
exec bun run packages/runtime/src/index.ts
