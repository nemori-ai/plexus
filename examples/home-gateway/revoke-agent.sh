#!/usr/bin/env bash
#
# revoke-agent.sh — the owner's kill switch, run on the HOME machine: revoke ONE
# agent completely (PAT dies, live sessions die, standing grants die), then PROVE
# the next call fails closed by probing the public surface the way the agent would.
#
# Usage: ./revoke-agent.sh [agentId]      (default: office-cc)
set -euo pipefail

DEMO_ROOT="${DEMO_ROOT:-$HOME/PlexusDemo/home-gateway}"
PORT="${PLEXUS_HOME_GATEWAY_PORT:-7901}"
BASE="http://127.0.0.1:$PORT"
AGENT_ID="${1:-office-cc}"

die() { echo "[revoke] ERROR: $*" >&2; exit 1; }
command -v jq >/dev/null || die "jq is required"
[ -f "$DEMO_ROOT/home/connection-key" ] || die "no connection-key under $DEMO_ROOT/home — run ./up.sh first"
KEY="$(cat "$DEMO_ROOT/home/connection-key")"

echo "[revoke] revoking agent '$AGENT_ID' (PAT + sessions + standing grants, this agent ONLY)…"
curl -sf -X POST "$BASE/admin/api/agents/revoke" \
  -H "X-Plexus-Connection-Key: $KEY" -H 'content-type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\"}" | jq .

cat << SUMMARY

[revoke] ✅ done. On the office machine, the very next call fails closed:

  plexus-$AGENT_ID list      # → its PAT no longer verifies (401); nothing else is touched

Other agents (if any) are unaffected — that is the per-agent blast radius.
SUMMARY
