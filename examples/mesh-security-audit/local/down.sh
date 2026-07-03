#!/usr/bin/env bash
#
# down.sh — tear down the LOCAL hero topology brought up by up.sh:
#   1. stop + remove the Docker linux proxy container (and its state volume),
#   2. stop the native Mac primary (via the pidfile up.sh wrote),
#   3. clean up the transient mesh.env.
#
# The demo data dirs (analysis / vault) and the primary's PLEXUS_HOME (incl. its
# audit/ trail) are KEPT by default so you can inspect the per-host audit after a run.
# Pass --purge to also delete the primary PLEXUS_HOME (audit included).
#
# Env defaults MUST match up.sh (both read the same overridable vars).
#
# Usage:  ./down.sh            (or: bash down.sh [--purge])

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${DEMO_ROOT:=${HOME}/PlexusDemo}"
: "${PLEXUS_PRIMARY_HOME:=${DEMO_ROOT}/primary-home}"   # MUST match up.sh's default
COMPOSE_FILE="${SCRIPT_DIR}/compose.linux.yml"
ENV_FILE="${SCRIPT_DIR}/mesh.env"
PID_FILE="${PLEXUS_PRIMARY_HOME}/primary.pid"

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

GREEN=$'\e[32m'; YELLOW=$'\e[33m'; DIM=$'\e[2m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ok()   { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$1"; }
note() { printf '  %s»%s %s\n' "${YELLOW}" "${RESET}" "$1"; }

printf '%sTearing down the LOCAL mesh-security-audit topology…%s\n' "${BOLD}" "${RESET}"

# 1. Docker linux proxy (down -v removes its named state volume too).
[ -f "${ENV_FILE}" ] || : > "${ENV_FILE}"
if docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" down -v >/dev/null 2>&1; then
  ok "Docker linux proxy stopped + removed (state volume dropped)."
else
  note "docker compose down reported nothing to stop (already down)."
fi

# 2. Native Mac primary.
STOPPED=0
if [ -f "${PID_FILE}" ]; then
  PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "${PID}" 2>/dev/null || { STOPPED=1; break; }; sleep 0.3; done
    kill -0 "${PID}" 2>/dev/null && kill -9 "${PID}" 2>/dev/null || true
    ok "Native Mac primary stopped (pid ${PID})."
  else
    note "No live primary for pid in ${PID_FILE}."
  fi
  rm -f "${PID_FILE}"
else
  note "No primary pidfile (${PID_FILE}) — nothing to stop."
fi

# 3. Transient env-file.
rm -f "${ENV_FILE}"
ok "Removed transient mesh.env."

if [ "${PURGE}" = "1" ]; then
  rm -rf "${PLEXUS_PRIMARY_HOME}"
  ok "Purged primary PLEXUS_HOME (${PLEXUS_PRIMARY_HOME}) — audit trail included."
else
  note "Kept primary PLEXUS_HOME for inspection: ${PLEXUS_PRIMARY_HOME}/audit/ (pass --purge to delete)."
fi

printf '%s%sTEARDOWN COMPLETE.%s\n' "${BOLD}" "${GREEN}" "${RESET}"
