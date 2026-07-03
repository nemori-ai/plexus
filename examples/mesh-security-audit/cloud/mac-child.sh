#!/usr/bin/env bash
#
# mac-child.sh — attach a NATIVE Mac child (proxy) to the CLOUD parent.
#
# ┌───────────────────────────────────────────────────────────────────────────────────┐
# │ YOU run this ON YOUR MAC. It runs the STOCK gateway (packages/runtime/src/index.ts) │
# │ natively as a mesh PROXY, dialing OUT to wss://mesh.<your-domain> (the Cloudflare    │
# │ edge). It exposes THIS Mac's codex.run (dir-jailed) + workspace/vault caps. The Mac  │
# │ is where codex runs — codex is a macOS-native, exec-class source, so it lives here,  │
# │ not on the Linux child.                                                              │
# └───────────────────────────────────────────────────────────────────────────────────┘
#
# The join env (PLEXUS_UPSTREAM_URL / _PUBKEY / _JOIN_TOKEN / _WORKLOAD) comes from the
# parent's mint. Get it FIRST with:
#     MESH_HOSTNAME=mesh.<your-domain> ./mint-join.sh mac > mac.join.env
#     source mac.join.env        # or: MAC_JOIN_ENV=mac.join.env ./mac-child.sh
# then run this script. Join tokens are SINGLE-USE; re-mint if you restart from scratch.
#
# NOTE ON TLS: the child dials the Cloudflare edge over public TLS (wss://mesh.<domain>),
# so — unlike the local self-signed topology — NO NODE_EXTRA_CA_CERTS is needed. The
# Ed25519 mesh mutual-auth (pinned PLEXUS_UPSTREAM_PUBKEY) is the identity boundary; the CF
# cert is just the transport.
#
# Env (join vars are REQUIRED unless MAC_JOIN_ENV points at a file that sets them):
#   PLEXUS_UPSTREAM_URL     wss://mesh.<domain>            (from mint-join.sh)
#   PLEXUS_UPSTREAM_PUBKEY  pinned raw Ed25519 pubkey      (from mint-join.sh)
#   PLEXUS_JOIN_TOKEN       one-time join token            (from mint-join.sh)
#   PLEXUS_WORKLOAD         workload name (default: mac)
#   MAC_JOIN_ENV           optional path to a KEY=VALUE join env file to source first
#   PLEXUS_PRIMARY_… none — this is a proxy; it dials the cloud parent.
#   MAC_CHILD_HOME         isolated PLEXUS_HOME for THIS child  (default: ~/.plexus-mesh-mac)
#   MAC_CHILD_PORT         local loopback admin port            (default: 7078)
#   DEMO_ROOT              demo dirs root                       (default: ~/PlexusDemo)
#   ANALYSIS_DIR           codex jail  (PLEXUS_CODEX_AUTHORIZED_DIR) (default: $DEMO_ROOT/analysis)
#   VAULT_DIR             workspace/vault (PLEXUS_WORKSPACE_DIR)     (default: $DEMO_ROOT/vault)
#   CODEX_REAL            "1" ⇒ real codex spawn (PLEXUS_CODEX_HEADLESS_LAUNCH=1; needs a
#                          logged-in codex + costs model tokens). Default = record-mode.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ENTRY="${REPO_ROOT}/packages/runtime/src/index.ts"

# Optionally source a join env file produced by mint-join.sh.
if [ -n "${MAC_JOIN_ENV:-}" ]; then
  [ -f "${MAC_JOIN_ENV}" ] || { echo "ERROR: MAC_JOIN_ENV=${MAC_JOIN_ENV} not found" >&2; exit 2; }
  set -a; . "${MAC_JOIN_ENV}"; set +a
fi

WORKLOAD="${PLEXUS_WORKLOAD:-mac}"
MAC_CHILD_HOME="${MAC_CHILD_HOME:-$HOME/.plexus-mesh-mac}"
MAC_CHILD_PORT="${MAC_CHILD_PORT:-7078}"
DEMO_ROOT="${DEMO_ROOT:-$HOME/PlexusDemo}"
ANALYSIS_DIR="${ANALYSIS_DIR:-${DEMO_ROOT}/analysis}"
VAULT_DIR="${VAULT_DIR:-${DEMO_ROOT}/vault}"

die() { printf '\n[mac-child] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"; }
need bun

[ -f "${ENTRY}" ] || die "stock gateway entry not found at ${ENTRY} (run from the plexus repo)"
[ -n "${PLEXUS_UPSTREAM_URL:-}" ]    || die "PLEXUS_UPSTREAM_URL unset — run ./mint-join.sh mac first (see header)"
[ -n "${PLEXUS_UPSTREAM_PUBKEY:-}" ] || die "PLEXUS_UPSTREAM_PUBKEY unset — run ./mint-join.sh mac first"
[ -n "${PLEXUS_JOIN_TOKEN:-}" ]      || die "PLEXUS_JOIN_TOKEN unset — run ./mint-join.sh mac first"

case "${PLEXUS_UPSTREAM_URL}" in
  wss://*) : ;;
  *) echo "[mac-child] WARNING: upstream '${PLEXUS_UPSTREAM_URL}' is not wss:// — the CF edge should be wss." >&2 ;;
esac

mkdir -p "${MAC_CHILD_HOME}" "${ANALYSIS_DIR}" "${VAULT_DIR}"

CODEX_HEADLESS=""
[ "${CODEX_REAL:-0}" = "1" ] && CODEX_HEADLESS="1"

echo "[mac-child] attaching Mac proxy → ${PLEXUS_UPSTREAM_URL}"
echo "[mac-child]   workload      : ${WORKLOAD}"
echo "[mac-child]   PLEXUS_HOME   : ${MAC_CHILD_HOME}   (isolated; audit lands in ${MAC_CHILD_HOME}/audit/)"
echo "[mac-child]   codex jail    : ${ANALYSIS_DIR}"
echo "[mac-child]   vault dir     : ${VAULT_DIR}"
echo "[mac-child]   codex spawn   : $([ -n "${CODEX_HEADLESS}" ] && echo 'REAL (headless launch; costs tokens)' || echo 'record-mode (default; no cost)')"
echo "[mac-child]   local admin   : http://127.0.0.1:${MAC_CHILD_PORT}"

# Run the STOCK gateway natively as a proxy. env -i keeps a clean, explicit environment
# (HOME/PATH preserved so bun + codex resolve). Foreground so you see the enroll logs;
# background it (append ' &') or run under launchd/tmux to keep the Mac child persistent.
exec env -i \
  HOME="${HOME}" PATH="${PATH}" \
  PLEXUS_MODE="proxy" \
  PLEXUS_INSTANCE="flagship-mac-child" \
  PLEXUS_WORKLOAD="${WORKLOAD}" \
  PLEXUS_HOME="${MAC_CHILD_HOME}" \
  PLEXUS_PORT="${MAC_CHILD_PORT}" \
  PLEXUS_UPSTREAM_URL="${PLEXUS_UPSTREAM_URL}" \
  PLEXUS_UPSTREAM_PUBKEY="${PLEXUS_UPSTREAM_PUBKEY}" \
  PLEXUS_JOIN_TOKEN="${PLEXUS_JOIN_TOKEN}" \
  PLEXUS_CODEX_AUTHORIZED_DIR="${ANALYSIS_DIR}" \
  ${CODEX_HEADLESS:+PLEXUS_CODEX_HEADLESS_LAUNCH="1"} \
  PLEXUS_WORKSPACE_DIR="${VAULT_DIR}" \
  bun run "${ENTRY}"
