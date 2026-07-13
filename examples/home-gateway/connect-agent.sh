#!/usr/bin/env bash
#
# connect-agent.sh — the ADMIN act, run on the HOME machine: connect the office
# agent and print the one-command install to paste on the OFFICE machine.
#
# What it authorizes — and, deliberately, how (ADR-023: the connect selection IS the
# agent's world; anything outside it is hard-denied, it never pends):
#   workspace.list + workspace.read  → in the subset, STANDING (7d): reads are frictionless.
#   workspace.write                  → in the subset, per-use (the safe default for a
#                                      side-effecting capability): each write PENDS.
# That asymmetry IS the story: reads stand, the mutating move waits for a human — and it
# is what connect does out of the box; standing write/execute is an explicit owner opt-in.
#
# Usage: ./connect-agent.sh [agentId]      (default: office-cc)
set -euo pipefail

DEMO_ROOT="${DEMO_ROOT:-$HOME/PlexusDemo/home-gateway}"
PORT="${PLEXUS_HOME_GATEWAY_PORT:-7901}"
BASE="http://127.0.0.1:$PORT"
AGENT_ID="${1:-office-cc}"

die() { echo "[connect] ERROR: $*" >&2; exit 1; }
command -v jq >/dev/null || die "jq is required"
[ -f "$DEMO_ROOT/home/connection-key" ] || die "no connection-key under $DEMO_ROOT/home — run ./up.sh first"
KEY="$(cat "$DEMO_ROOT/home/connection-key")"

echo "[connect] connecting agent '$AGENT_ID' — subset {list, read, write}, reads standing (7d)…"
CONNECT="$(curl -sf -X POST "$BASE/admin/api/agents/connect" \
  -H "X-Plexus-Connection-Key: $KEY" -H 'content-type: application/json' \
  -d "{\"agentId\":\"$AGENT_ID\",\"agentType\":\"claude-code\",\"capabilities\":[\"workspace.list\",\"workspace.read\",\"workspace.write\"],\"trustWindow\":{\"kind\":\"7d\"}}")" \
  || die "POST /admin/api/agents/connect failed — is the gateway up?"
echo "$CONNECT" | jq '{agentId, granted: [.granted[].capabilityId], skipped}'
echo "[connect] workspace.write is per-use out of the box (in the subset, no standing grant — writes pend)."

# The integration endpoint compiles the per-agent plugin and returns the copy-able
# install command carrying a FRESH single-use enrollment code (mgmt-key gated here;
# the install.sh it points at is public and secret-free).
INTEGRATION="$(curl -sf "$BASE/integration/$AGENT_ID" -H "X-Plexus-Connection-Key: $KEY")" \
  || die "GET /integration/$AGENT_ID failed"
INSTALL_CMD="$(echo "$INTEGRATION" | jq -r '.installCommand')"
CODE_EXPIRES="$(echo "$INTEGRATION" | jq -r '.codeExpiresAt // "n/a"')"

cat << SUMMARY

[connect] ✅ '$AGENT_ID' is connected. Paste this ON THE OFFICE MACHINE
(the single-use enrollment code inside expires at $CODE_EXPIRES):

  $INSTALL_CMD

Then, still on the office machine, hand the connected Claude Code its first task:

  plexus-$AGENT_ID list                       # discover: callable-now vs needs-approval
  plexus-$AGENT_ID workspace.read Welcome.md  # standing read — no prompt
  plexus-$AGENT_ID workspace.write --input '{"path":"office-note.md","content":"written from the office"}' \
      --purpose "leave a note for the owner"  # write → PENDS on the home gateway (the
                                              # call waits; approve it and it completes)

Approve the pending write from anywhere: https://<public-hostname>/admin → Approvals
(connection-key gated). Revoke everything later with ./revoke-agent.sh $AGENT_ID.
SUMMARY
