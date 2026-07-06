#!/usr/bin/env bash
#
# down.sh — stop the home gateway + the tunnel. State is KEPT (workspace, audit,
# grants under $DEMO_ROOT) so you can inspect the story afterwards; pass --purge
# to wipe everything.
set -euo pipefail

DEMO_ROOT="${DEMO_ROOT:-$HOME/PlexusDemo/home-gateway}"

for name in gateway cloudflared; do
  pf="$DEMO_ROOT/$name.pid"
  if [ -f "$pf" ]; then
    pid="$(cat "$pf")"
    if kill "$pid" 2>/dev/null; then
      echo "[down] stopped $name (pid $pid)"
    else
      echo "[down] $name (pid $pid) was not running"
    fi
    rm -f "$pf"
  else
    echo "[down] no $name.pid — nothing to stop"
  fi
done

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DEMO_ROOT"
  echo "[down] purged $DEMO_ROOT (workspace, audit, grants — all gone)"
else
  echo "[down] state kept under $DEMO_ROOT (audit: home/audit/, workspace, grants). --purge to wipe."
fi
