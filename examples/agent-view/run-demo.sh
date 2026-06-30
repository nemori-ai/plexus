#!/usr/bin/env bash
#
# run-demo.sh — one command to boot the Plexus Agent View.
#
# It starts (defensively — each piece is optional and degrades with a clear
# message):
#   1. the Plexus gateway        (bun, repo root, :7077)         [for LIVE mode]
#   2. the Python demo backend   (examples/agent-view/backend)   [for LIVE mode]
#   3. the web dev server        (examples/agent-view/web, :5180)
#   4. opens the browser
#
# The web app always runs — even with NEITHER gateway nor backend — because its
# default DEMO mode replays a local mock session (zero setup). Gateway + backend
# are only needed to use the in-app LIVE toggle (real deepagent + CC/Codex).
#
# Usage:
#   ./run-demo.sh            # web only (demo/mock mode) + try to start the stack
#   ./run-demo.sh --web-only # never start gateway/backend
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WEB_DIR="$HERE/web"
BACKEND_DIR="$HERE/backend"

WEB_PORT="${AGENT_VIEW_PORT:-5180}"
GATEWAY_PORT="${PLEXUS_PORT:-7077}"
BACKEND_PORT="${AGENT_VIEW_BACKEND_PORT:-8800}"
WEB_ONLY=0
[[ "${1:-}" == "--web-only" ]] && WEB_ONLY=1

PIDS=()
cleanup() {
  echo ""
  echo "[demo] shutting down…"
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
  done
}
trap cleanup EXIT INT TERM

say()  { echo "[demo] $*"; }
warn() { echo "[demo] ⚠ $*" >&2; }

# ── 1. gateway (optional) ─────────────────────────────────────────────────────
if [[ "$WEB_ONLY" -eq 0 ]]; then
  if command -v bun >/dev/null 2>&1 && [[ -f "$ROOT/package.json" ]]; then
    say "starting Plexus gateway on :$GATEWAY_PORT (bun run start)…"
    ( cd "$ROOT" && PORT="$GATEWAY_PORT" bun run start ) &
    PIDS+=("$!")
  else
    warn "gateway skipped — 'bun' not found or repo root package.json missing."
    warn "  → the app still runs in DEMO mode; LIVE mode needs the gateway."
  fi
fi

# ── 2. python backend (optional; owned by build lane B1) ──────────────────────
if [[ "$WEB_ONLY" -eq 0 ]]; then
  if [[ -d "$BACKEND_DIR" ]]; then
    PY=""
    command -v python3 >/dev/null 2>&1 && PY=python3
    [[ -z "$PY" ]] && command -v python >/dev/null 2>&1 && PY=python
    if [[ -n "$PY" ]]; then
      say "starting Python demo backend on :$BACKEND_PORT…"
      # The backend exposes POST /api/chat (SSE) + GET /api/health. Entry point
      # convention: backend/server.py runnable as a module or a uvicorn app.
      if [[ -f "$BACKEND_DIR/server.py" ]]; then
        ( cd "$BACKEND_DIR" && PORT="$BACKEND_PORT" "$PY" server.py ) &
        PIDS+=("$!")
      else
        warn "backend present but no server.py entry point found — skipping."
      fi
    else
      warn "backend skipped — no python3/python on PATH."
    fi
  else
    warn "backend not found at $BACKEND_DIR (build lane B1 may not be wired yet)."
    warn "  → DEMO mode (mock replay) works without it."
  fi
fi

# ── 3. web dev server (required) ──────────────────────────────────────────────
if [[ ! -d "$WEB_DIR" ]]; then
  echo "[demo] ✗ web app not found at $WEB_DIR" >&2
  exit 1
fi
if [[ ! -d "$WEB_DIR/node_modules" ]]; then
  say "installing web dependencies (first run)…"
  ( cd "$WEB_DIR" && npm install ) || { echo "[demo] ✗ npm install failed" >&2; exit 1; }
fi

say "starting web dev server on :$WEB_PORT…"
( cd "$WEB_DIR" && AGENT_VIEW_BACKEND="http://127.0.0.1:$BACKEND_PORT" npm run dev -- --port "$WEB_PORT" ) &
PIDS+=("$!")

# ── 4. open browser ───────────────────────────────────────────────────────────
URL="http://localhost:$WEB_PORT"
say "waiting for the web server…"
for _ in $(seq 1 40); do
  if curl -sf "$URL" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
say "open: $URL  (DEMO mode works standalone; switch to LIVE for the real stack)"
if command -v open >/dev/null 2>&1; then open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
fi

say "press Ctrl-C to stop."
wait
