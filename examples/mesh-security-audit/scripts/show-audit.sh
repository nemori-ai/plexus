#!/usr/bin/env bash
#
# show-audit.sh — dump + LABEL the per-host audit split (the story's payoff).
#
# Every gateway writes its OWN append-only audit for the invokes IT executes. That locality
# is the whole point: in the LOCAL topology the Mac IS the primary, so it logs codex.run +
# the vault write (+ the grant/handshake/revoke lifecycle), while the Linux PROXY logs the
# sysinfo reads — and NEITHER logs the other's. This script makes that split obvious.
#
#   PRIMARY  audit  — read from $PLEXUS_HOME/audit/*.jsonl (local files)
#   LINUX    proxy  — read via $PLEXUS_LINUX_AUDIT_CMD (default: docker compose exec on the
#                     local/ linux proxy). Best-effort; DEFERRED to the full E2E if absent.
#
# Env:
#   PLEXUS_HOME            primary home holding audit/   (default ~/.plexus)
#   PLEXUS_AUDIT_AGENT_ID  filter to this agent's events (default mesh-security-audit; "" = all)
#   PLEXUS_LINUX_AUDIT_CMD command that prints the linux proxy's audit JSONL to stdout
#                          (default: docker compose -f <example>/local/compose.linux.yml
#                           exec -T linux cat '/state/audit/*.jsonl' — the container's
#                           PLEXUS_HOME is /state, see compose.linux.yml)
set -uo pipefail

PLEXUS_HOME="${PLEXUS_HOME:-$HOME/.plexus}"
AGENT_ID="${PLEXUS_AUDIT_AGENT_ID-mesh-security-audit}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# The linux proxy container runs with PLEXUS_HOME=/state (compose.linux.yml), so its
# append-only audit lives at /state/audit/*.jsonl (NOT /root/.plexus — HOME is overridden).
DEFAULT_LINUX_CMD="docker compose -f ${EXAMPLE_DIR}/local/compose.linux.yml exec -T linux sh -c 'cat /state/audit/*.jsonl 2>/dev/null'"
LINUX_AUDIT_CMD="${PLEXUS_LINUX_AUDIT_CMD:-${DEFAULT_LINUX_CMD}}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[show-audit] need $1 on PATH" >&2; exit 1; }; }
need jq

# jq filter: keep only this agent's events (or all if AGENT_ID is empty), pretty one-line each.
# Used for the PRIMARY, where the leaf agent (mesh-security-audit) is threaded onto every event.
agent_filter() {
  if [ -n "${AGENT_ID}" ]; then jq -c "select((.agentId // \"\") == \"${AGENT_ID}\" or .type==\"exposure.set\")"
  else cat; fi
}
# PROXY-side filter. A FORWARDED invoke is attributed on the proxy to the TUNNEL principal
# (e.g. `mesh:primary`) — across the tunnel the PARENT is the immediate caller; the leaf
# agent is threaded on the PARENT by correlation, not re-sent to the child. So on the proxy
# we keep the leaf agent's own events AND any `mesh:*` tunnel identity (else the proxy's real
# sysinfo rows — attributed to mesh:primary — get filtered out and the split renders EMPTY).
proxy_agent_filter() {
  if [ -n "${AGENT_ID}" ]; then
    jq -c "select((.agentId // \"\") == \"${AGENT_ID}\" or ((.agentId // \"\")|startswith(\"mesh:\")) or .type==\"exposure.set\")"
  else cat; fi
}
show_invokes() {   # $1 = jsonl stream on stdin label filter
  jq -c 'select(.type=="invoke") | {at, capabilityId, verbs, outcome, detail: (.detail.op // .detail.mechanism // null)}' 2>/dev/null
}
show_lifecycle() {
  jq -c 'select(.type=="handshake" or (.type|startswith("grant")) or .type=="revoke" or .type=="token_revoked" or .type=="token.issue" or .type=="exposure.set") | {at, type, agentId, capabilityId, detail: (.detail.event // .detail.reason // .detail.agentPurpose // .detail.enabled // .reason // null)}' 2>/dev/null
}

hr() { printf '%s\n' "============================================================================"; }

# ── PRIMARY (the Mac, in the local topology) ────────────────────────────────────
hr; echo "  PRIMARY audit  —  ${PLEXUS_HOME}/audit"
echo "  (local topology: the Mac IS the primary → codex.run + vault write + lifecycle)"; hr
PRIMARY_STREAM="$(cat "${PLEXUS_HOME}"/audit/*.jsonl 2>/dev/null | agent_filter)"
if [ -z "${PRIMARY_STREAM}" ]; then
  echo "  (no primary audit events for agent='${AGENT_ID}' — has the run happened?)"
else
  echo "  -- INVOKES executed HERE (codex.run + the vault write; plus mesh-FORWARD rows for"
  echo "     local/<workload>/sysinfo.* — the parent mirrors each forward for the audit trail) --"
  printf '%s\n' "${PRIMARY_STREAM}" | show_invokes | sed 's/^/    /' || true
  echo "  -- GRANT / HANDSHAKE / REVOKE lifecycle --"
  printf '%s\n' "${PRIMARY_STREAM}" | show_lifecycle | sed 's/^/    /' || true
  # Distinguish a mesh FORWARD (namespaced `local/<workload>/sysinfo.*` — the read executed
  # on the PROXY; the parent only mirrors it) from a BARE `sysinfo.*` (a read that actually
  # executed LOCALLY on the primary — only happens in a standalone, no-proxy run).
  FWD_SYS="$(printf '%s\n' "${PRIMARY_STREAM}" | jq -c 'select(.type=="invoke" and (.capabilityId|test("sysinfo")) and (.capabilityId|test("/")))' 2>/dev/null)"
  BARE_SYS="$(printf '%s\n' "${PRIMARY_STREAM}" | jq -c 'select(.type=="invoke" and (.capabilityId|test("sysinfo")) and (.capabilityId|test("/")|not))' 2>/dev/null)"
  if [ -n "${FWD_SYS}" ]; then
    echo "  ✓ locality: the primary's sysinfo rows are mesh FORWARDS (namespaced local/<workload>/sysinfo.*)"
    echo "    — the parent mirrors the forward for the trail; the READ itself executed on the Linux proxy."
  fi
  if [ -z "${BARE_SYS}" ]; then
    echo "  ✓ locality: NO bare (locally-executed) sysinfo invoke on the primary."
  else
    echo "  NOTE: BARE sysinfo invoke(s) on the primary — EXPECTED only in a standalone (no-proxy) run"
    echo "        where sysinfo is a LOCAL cap; in the mesh topology these live on the Linux proxy:"
    printf '%s\n' "${BARE_SYS}" | show_invokes | sed 's/^/    /'
  fi
fi

# ── LINUX PROXY (the Docker "remote linux") ─────────────────────────────────────
hr; echo "  LINUX PROXY audit  —  via: ${LINUX_AUDIT_CMD}"
echo "  (the remote Linux box → sysinfo.resources/processes/log reads ONLY;"
echo "   forwarded invokes are attributed to the tunnel principal, e.g. mesh:primary)"; hr
LINUX_STREAM="$(eval "${LINUX_AUDIT_CMD}" 2>/dev/null | proxy_agent_filter)"
if [ -z "${LINUX_STREAM}" ]; then
  echo "  (no linux proxy audit reachable — the proxy is not up, or its audit path differs."
  echo "   DEFERRED to the full E2E. Override with PLEXUS_LINUX_AUDIT_CMD to point at it.)"
else
  echo "  -- INVOKES executed HERE (expect sysinfo.*; NO codex/vault) --"
  printf '%s\n' "${LINUX_STREAM}" | show_invokes | sed 's/^/    /' || true
  NONSYS="$(printf '%s\n' "${LINUX_STREAM}" | jq -c 'select(.type=="invoke" and (.capabilityId|test("sysinfo")|not))' 2>/dev/null)"
  if [ -z "${NONSYS}" ]; then
    echo "  ✓ locality: ONLY sysinfo invokes on the Linux proxy (no codex/vault leaked here)."
  else
    echo "  ⚠ unexpected non-sysinfo invoke on the proxy:"; printf '%s\n' "${NONSYS}" | show_invokes | sed 's/^/    /'
  fi
fi
hr
echo "  PER-HOST AUDIT LOCALITY: each gateway logs only what IT executed. That split —"
echo "  sysinfo on the Linux proxy, codex+vault on the primary — is the mesh story's payoff."
hr
