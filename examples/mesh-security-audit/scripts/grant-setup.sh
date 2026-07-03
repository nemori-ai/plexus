#!/usr/bin/env bash
#
# grant-setup.sh — authorize the mesh-security-audit cloud agent against the PRIMARY.
#
# Run this against the PRIMARY gateway (connection-key gated). It does the operator side
# of "join ≠ access": mounted proxy caps are hidden until deliberately exposed, and the
# agent gets NOTHING until connected + granted. Three acts:
#
#   1. EXPOSE   the mounted proxy `sysinfo.*` caps (default-hidden after mesh join) so the
#              parent will advertise them to the agent.
#   2. CONNECT  the agent (mint a one-time enrollment code → the agent redeems it for its
#              OWN durable PAT) AND grant the STANDING read cap-set:
#                 sysinfo.*      (read    → stands, frictionless)
#                 codex.run      (execute → the SYSTEM forces it to never stand; PENDS
#                                  each call — it surfaces under `skipped`, the pedagogy)
#              The vault WRITE is DELIBERATELY NOT pre-granted: a mutating write must PEND
#              for the owner on EVERY call (the admin connect path would otherwise make it
#              standing, since an admin is a human approver — that would skip the story's
#              HITL beat + fail E2E step 5). So it is left out of the standing set and pends
#              at invoke time. Read stands; execute + write pend — exactly the three beats.
#   3. PRINT    the one-time code + enroll URL for the agent (never the connection-key).
#
# Address-agnostic: it discovers the LIVE capability ids from the parent and matches each
# leg by id SUFFIX, so it works whether caps are LOCAL bare ids (local topology) or
# mesh-mounted `local/<workload>/…` (cloud topology).
#
# Env (defaults are the REAL end-user values; the local verification run overrides them):
#   PLEXUS_BASE_URL        parent base url            (default http://127.0.0.1:7077)
#   PLEXUS_HOME            home holding connection-key(default ~/.plexus)
#   PLEXUS_CONNECTION_KEY  override the key directly  (else read $PLEXUS_HOME/connection-key)
#   PLEXUS_AUDIT_AGENT_ID  the agent id to connect    (default mesh-security-audit)
set -uo pipefail

BASE_URL="${PLEXUS_BASE_URL:-http://127.0.0.1:7077}"
PLEXUS_HOME="${PLEXUS_HOME:-$HOME/.plexus}"
AGENT_ID="${PLEXUS_AUDIT_AGENT_ID:-mesh-security-audit}"

die() { printf '\n[grant-setup] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"; }
need curl; need jq

# ── connection-key (admin/management credential — NEVER given to the agent) ──────
KEY="${PLEXUS_CONNECTION_KEY:-}"
if [ -z "${KEY}" ]; then
  [ -f "${PLEXUS_HOME}/connection-key" ] || die "no connection-key at ${PLEXUS_HOME}/connection-key (set PLEXUS_CONNECTION_KEY or PLEXUS_HOME)"
  KEY="$(tr -d '\n' < "${PLEXUS_HOME}/connection-key")"
fi

admin_get()  { curl -fsS "${BASE_URL}$1" -H "X-Plexus-Connection-Key: ${KEY}"; }
admin_post() { curl -fsS -X POST "${BASE_URL}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${KEY}" -d "$2"; }

echo "[grant-setup] parent: ${BASE_URL}   agent: ${AGENT_ID}"

# ── discover the live capability ids (address-agnostic) ─────────────────────────
# GET /admin/api/exposure lists every live capability id + its exposure state.
EXPOSURE_JSON="$(admin_get "/admin/api/exposure")" || die "cannot reach the parent admin API at ${BASE_URL} (is the primary up? key correct?)"
ALL_IDS="$(printf '%s' "${EXPOSURE_JSON}" | jq -r '.capabilities[].id')"

# Return ONE live id ending with a given dotted suffix (bare OR mesh-mounted).
# PREFER A MESH-MOUNTED id (one carrying a `tenant/workload/` address prefix, i.e.
# containing a "/") over a bare LOCAL id. This disambiguates the ONE local↔remote
# collision the local topology creates: on macOS the primary loads its OWN portable
# `sysinfo` source (bare `sysinfo.*`) AND mounts the Linux proxy's as `local/linux/sysinfo.*`.
# The story ALWAYS wants the REMOTE (Linux proxy) sysinfo so it executes — and audits — on
# the proxy, never the Mac. For codex/workspace there is no such collision (only the bare
# local id exists in this topology), so the bare fallback still selects them correctly. In
# the cloud topology every cap is mesh-mounted, so "prefer namespaced" is a no-op there.
match_suffix() {
  local suffix="$1"
  # Pass 1: a mesh-mounted (namespaced, contains "/") id ending with the suffix.
  printf '%s\n' "${ALL_IDS}" | awk -v s="${suffix}" '
    index($0,"/")>0 && index($0, "/"s)==(length($0)-length(s)) && index($0,"/"s)>0 { print; exit }
  ' | head -n1 | grep . && return 0
  # Pass 2: any match — exact bare id, or a dotted-suffix bare id (no namespace).
  printf '%s\n' "${ALL_IDS}" | awk -v s="${suffix}" '
    $0==s { print; exit }
    index($0, "."s)==(length($0)-length(s)) && index($0,"."s)>0 { print; exit }
  ' | head -n1
}

SYS_RES="$(match_suffix sysinfo.resources.read)"
SYS_PROC="$(match_suffix sysinfo.processes.list)"
SYS_LOG="$(match_suffix sysinfo.log.read)"
CODEX="$(match_suffix codex.run)"
# vault write: prefer a real Obsidian REST write, else the hermetic workspace write.
VAULT="$(match_suffix obsidian-rest.vault.write)"
[ -z "${VAULT}" ] && VAULT="$(match_suffix vault.write)"
[ -z "${VAULT}" ] && VAULT="$(match_suffix workspace.write)"

# ── 1. EXPOSE the mounted proxy sysinfo caps (mounted caps default hidden) ───────
echo "[grant-setup] --- EXPOSE mounted proxy sysinfo caps ---"
SYS_EXPOSED=0
for cid in "${SYS_RES}" "${SYS_PROC}" "${SYS_LOG}"; do
  [ -z "${cid}" ] && continue
  enc="$(jq -rn --arg s "${cid}" '$s|@uri')"
  if admin_post "/admin/api/exposure/${enc}" '{"enabled":true}' | jq -e '.ok==true' >/dev/null 2>&1; then
    echo "[grant-setup]   exposed: ${cid}"
    SYS_EXPOSED=$((SYS_EXPOSED+1))
  else
    echo "[grant-setup]   WARN could not expose ${cid}"
  fi
done
if [ "${SYS_EXPOSED}" -eq 0 ]; then
  echo "[grant-setup]   (no sysinfo.* caps live yet — the Linux proxy is not attached."
  echo "[grant-setup]    The mesh scan leg is DEFERRED to the full E2E; codex+vault still work.)"
fi

# ── 2. CONNECT + grant the STANDING cap-set (only the ids that actually exist) ───
# STANDING set = the read caps + codex.run (which the system will force to `skipped`,
# never standing). The vault WRITE (${VAULT}) is INTENTIONALLY excluded so it PENDS at
# invoke — a mutating write is never made frictionless in this story.
echo "[grant-setup] --- CONNECT the agent + grant the STANDING cap-set ---"
CAPS_JSON="$(
  jq -nc '[ $ARGS.positional[] | select(. != "") ]' --args \
    "${SYS_RES}" "${SYS_PROC}" "${SYS_LOG}" "${CODEX}"
)"
echo "[grant-setup]   requesting standing caps: ${CAPS_JSON}"
[ -n "${VAULT}" ] && echo "[grant-setup]   vault write '${VAULT}' left UN-granted → it PENDS on every call (mutating write, HITL)."
[ "${CAPS_JSON}" = "[]" ] && die "no matching capabilities live on the parent — is the gateway configured with codex/workspace (and the sysinfo proxy)?"

CONNECT_BODY="$(jq -nc --arg a "${AGENT_ID}" --argjson caps "${CAPS_JSON}" \
  '{agentId:$a, agentType:"mesh-security-audit", capabilities:$caps}')"
RESP="$(admin_post "/admin/api/agents/connect" "${CONNECT_BODY}")" || die "agents/connect failed"

CODE="$(printf '%s' "${RESP}" | jq -r '.code // empty')"
ENROLL_URL="$(printf '%s' "${RESP}" | jq -r '.enrollUrl // empty')"
[ -z "${CODE}" ] && die "no enrollment code in response: ${RESP}"

echo "[grant-setup]   granted (standing): $(printf '%s' "${RESP}" | jq -c '[.granted[].capabilityId]')"
echo "[grant-setup]   skipped (pend-each-call — execute/write never stand): $(printf '%s' "${RESP}" | jq -c '.skipped')"

# ── 3. PRINT the one-time code + enroll URL (the ONLY secret the agent receives) ─
cat <<EOF

============================================================================
  AGENT ENROLLMENT — hand THIS to the agent (never the connection-key)
============================================================================
  one-time code : ${CODE}
  enroll URL    : ${ENROLL_URL}
  base URL      : ${BASE_URL}

  Run the agent (first run redeems the code → durable PAT stored in agent/.env):

    PLEXUS_BASE_URL=${BASE_URL} \\
    PLEXUS_ENROLL_CODE=${CODE} \\
      python examples/mesh-security-audit/agent/driver.py --run

  codex.run (execute) and the vault write (write) PEND on each call — approve them
  in the Plexus UI (or GET/POST /admin/api/pending) when the driver blocks.
============================================================================
EOF
