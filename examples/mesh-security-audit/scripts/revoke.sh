#!/usr/bin/env bash
#
# revoke.sh — the R in the lifecycle: revoke the agent, then PROVE the next call fails closed.
#
# `POST /admin/api/agents/revoke` is the kill-switch: it tombstones the agent's enrollment/PAT,
# invalidates its live sessions + revokes their tokens, and removes its standing grants — ALL
# of THAT agent's access dies immediately, nothing else touched. This script:
#
#   1. REVOKE   the agent (connection-key gated).
#   2. PROVE    the agent's very next capability call fails closed — the stored PAT no longer
#              handshakes / the invoke returns token_revoked. (Runs driver.py --probe.)
#   3. SHOW     the revoke event in the PARENT's audit.
#
# Env (defaults are the REAL end-user values; the local verification run overrides them):
#   PLEXUS_BASE_URL        parent base url             (default http://127.0.0.1:7077)
#   PLEXUS_HOME            home holding connection-key (default ~/.plexus)
#   PLEXUS_CONNECTION_KEY  override the key directly
#   PLEXUS_AUDIT_AGENT_ID  the agent id to revoke      (default mesh-security-audit)
set -uo pipefail

BASE_URL="${PLEXUS_BASE_URL:-http://127.0.0.1:7077}"
PLEXUS_HOME="${PLEXUS_HOME:-$HOME/.plexus}"
AGENT_ID="${PLEXUS_AUDIT_AGENT_ID:-mesh-security-audit}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER="$(cd "${SCRIPT_DIR}/../agent" && pwd)/driver.py"

die() { printf '\n[revoke] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "need $1 on PATH"; }
need curl; need jq

KEY="${PLEXUS_CONNECTION_KEY:-}"
if [ -z "${KEY}" ]; then
  [ -f "${PLEXUS_HOME}/connection-key" ] || die "no connection-key at ${PLEXUS_HOME}/connection-key"
  KEY="$(tr -d '\n' < "${PLEXUS_HOME}/connection-key")"
fi
admin_get()  { curl -fsS "${BASE_URL}$1" -H "X-Plexus-Connection-Key: ${KEY}"; }
admin_post() { curl -fsS -X POST "${BASE_URL}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${KEY}" -d "$2"; }

# ── 1. REVOKE ───────────────────────────────────────────────────────────────────
echo "[revoke] --- REVOKE agent '${AGENT_ID}' on ${BASE_URL} ---"
BODY="$(jq -nc --arg a "${AGENT_ID}" '{agentId:$a, reason:"security-audit demo: revoke the agent"}')"
RESP="$(admin_post "/admin/api/agents/revoke" "${BODY}")" || die "revoke request failed"
echo "[revoke]   response: ${RESP}"
printf '%s' "${RESP}" | jq -e '.ok==true' >/dev/null 2>&1 \
  && echo "[revoke]   ✓ agent revoked (enrollment/PAT tombstoned, sessions + tokens killed, grants removed)" \
  || echo "[revoke]   ⚠ revoke returned ok:false — the agent may already be gone"

# ── 2. PROVE the next call fails closed ─────────────────────────────────────────
echo "[revoke] --- PROVE the agent's next call fails closed ---"
if command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi
PLEXUS_BASE_URL="${BASE_URL}" PLEXUS_AUDIT_AGENT_ID="${AGENT_ID}" "${PY}" "${DRIVER}" --probe
PROBE_RC=$?
if [ "${PROBE_RC}" -eq 0 ]; then
  echo "[revoke]   ✓ fail-closed confirmed (the revoked PAT cannot handshake/invoke)."
else
  echo "[revoke]   ⚠ the probe call SUCCEEDED — revoke did not take effect (investigate)."
fi

# ── 3. SHOW the revoke event in the parent audit ────────────────────────────────
echo "[revoke] --- revoke event in the PARENT audit ---"
REV_EVENTS="$(admin_get "/admin/api/audit?limit=100" \
  | jq -c --arg a "${AGENT_ID}" \
      '.events[] | select((.type=="grant.revoke" or .type=="revoke" or .type=="token_revoked" or (.detail.agentRevoke==true)) and ((.agentId // "")==$a or .agentId==null)) | {at, type, agentId, reason: (.reason // .detail.reason // null), grantsRemoved: (.detail.grantsRemoved // null)}' \
  2>/dev/null)"
if [ -n "${REV_EVENTS}" ]; then printf '%s\n' "${REV_EVENTS}" | sed 's/^/    /'; else echo "    (no revoke event surfaced via the audit API)"; fi

exit "${PROBE_RC}"
