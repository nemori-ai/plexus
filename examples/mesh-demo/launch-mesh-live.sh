#!/usr/bin/env bash
#
# launch-mesh-live.sh — boot the FULL multi-host mesh (mac primary + proxy-A wss/enc-ON +
# proxy-B ws/enc-OFF), mount + EXPOSE everything, then STAY UP so you can browse the
# primary's admin console. Ctrl-C (or killing this shell) tears it all down.
#
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"; cd "${REPO_ROOT}"
GW="examples/mesh-demo/gateway.ts"; CLI="packages/cli/src/bin/plexus"

PRIMARY_HOME="$(mktemp -d -t plexus-live-primary.XXXXXX)"
PROXY_A_HOME="$(mktemp -d -t plexus-live-proxya.XXXXXX)"
PROXY_B_HOME="$(mktemp -d -t plexus-live-proxyb.XXXXXX)"
PRIMARY_WS_DIR="$(mktemp -d -t plexus-live-mac-ws.XXXXXX)"
PROXY_A_DIR="$(mktemp -d -t plexus-live-proxya-ws.XXXXXX)"
TLS_DIR="$(mktemp -d -t plexus-live-tls.XXXXXX)"; TLS_CERT="${TLS_DIR}/cert.pem"; TLS_KEY="${TLS_DIR}/key.pem"
PRIMARY_LOG="$(mktemp -t plexus-live-primary-log.XXXXXX)"
PROXY_A_LOG="$(mktemp -t plexus-live-proxya-log.XXXXXX)"
PROXY_B_LOG="$(mktemp -t plexus-live-proxyb-log.XXXXXX)"
PRIMARY_PID=""; PROXY_A_PID=""; PROXY_B_PID=""

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'; }
PRIMARY_PORT=7077
# fall back to ephemeral if 7077 is taken
node -e 'const n=require("net").createServer();n.listen(7077,"127.0.0.1",()=>{n.close(()=>process.exit(0))}).on("error",()=>process.exit(1))' 2>/dev/null || PRIMARY_PORT="$(free_port)"
TUNNEL_WS_PORT="$(free_port)"; TUNNEL_WSS_PORT="$(free_port)"
PROXY_A_PORT="$(free_port)"; PROXY_B_PORT="$(free_port)"
BASE="http://127.0.0.1:${PRIMARY_PORT}"

cleanup() {
  echo; echo "[live] tearing down…"
  [ -n "${PROXY_A_PID}" ] && kill "${PROXY_A_PID}" 2>/dev/null
  [ -n "${PROXY_B_PID}" ] && kill "${PROXY_B_PID}" 2>/dev/null
  [ -n "${PRIMARY_PID}" ] && kill "${PRIMARY_PID}" 2>/dev/null
  wait 2>/dev/null
  rm -rf "${PRIMARY_HOME}" "${PROXY_A_HOME}" "${PROXY_B_HOME}" "${PRIMARY_WS_DIR}" "${PROXY_A_DIR}" \
         "${TLS_DIR}" "${PRIMARY_LOG}" "${PROXY_A_LOG}" "${PROXY_B_LOG}" 2>/dev/null
}
trap cleanup EXIT INT TERM
wait_log() { local p="$1" f="$2" s="${3:-30}" i=0; while [ "$i" -lt "$((s*10))" ]; do grep -Eq "$p" "$f" 2>/dev/null && return 0; sleep 0.1; i=$((i+1)); done; return 1; }
ck() { cat "${PRIMARY_HOME}/connection-key" 2>/dev/null; }
adminget()  { curl -s "${BASE}$1" -H "X-Plexus-Connection-Key: $(ck)"; }
adminpost() { curl -s -X POST "${BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: $(ck)" -d "$2"; }

openssl req -x509 -newkey rsa:2048 -nodes -keyout "${TLS_KEY}" -out "${TLS_CERT}" -days 1 \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1
printf 'Hello from the MAC PRIMARY (its own workspace cap).\n' > "${PRIMARY_WS_DIR}/mac-note.txt"
printf 'Hello from PROXY-A — workspace over wss (encryption ON).\n' > "${PROXY_A_DIR}/from-proxy-a.txt"

echo "[live] booting MAC PRIMARY on ${BASE} (own caps: workspace + apple-calendar; dual ws+wss tunnel)…"
PLEXUS_HOME="${PRIMARY_HOME}" PLEXUS_PORT="${PRIMARY_PORT}" PLEXUS_INSTANCE="live-mac-primary" \
  PLEXUS_WORKLOAD="mac-laptop" PLEXUS_DEMO_PRIMARY_SOURCES="workspace,apple-calendar" \
  PLEXUS_FAKE_APPLE="1" PLEXUS_WORKSPACE_DIR="${PRIMARY_WS_DIR}" \
  PLEXUS_MESH_TUNNEL_HOST="127.0.0.1" PLEXUS_MESH_WS_PORT="${TUNNEL_WS_PORT}" PLEXUS_MESH_WSS_PORT="${TUNNEL_WSS_PORT}" \
  PLEXUS_MESH_TLS_CERT="${TLS_CERT}" PLEXUS_MESH_TLS_KEY="${TLS_KEY}" \
  bun run "${GW}" >"${PRIMARY_LOG}" 2>&1 &
PRIMARY_PID=$!
wait_log "MESH_DEMO_READY role=primary" "${PRIMARY_LOG}" 40 || { sed 's/^/  [primary] /' "${PRIMARY_LOG}"; exit 1; }

MINT_A="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh mint --url "${BASE}" --json 2>/dev/null)"
MINT_B="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh mint --url "${BASE}" --json 2>/dev/null)"
TOKEN_A="$(printf '%s' "${MINT_A}" | jq -r '.token')"; TOKEN_B="$(printf '%s' "${MINT_B}" | jq -r '.token')"
PUBKEY="$(printf '%s' "${MINT_A}" | jq -r '.primaryPubKey')"
WSS="$(printf '%s' "${MINT_A}" | jq -r '.endpoints[]?|select(.scheme=="wss")|.port')"
WS="$(printf '%s' "${MINT_A}" | jq -r '.endpoints[]?|select(.scheme=="ws")|.port')"

echo "[live] booting PROXY-A (wss/enc-ON, workspace)…"
PLEXUS_HOME="${PROXY_A_HOME}" PLEXUS_PORT="${PROXY_A_PORT}" PLEXUS_MODE="proxy" \
  PLEXUS_DEMO_PROXY_SOURCE="workspace" PLEXUS_WORKSPACE_DIR="${PROXY_A_DIR}" \
  PLEXUS_UPSTREAM_URL="wss://127.0.0.1:${WSS}" PLEXUS_UPSTREAM_PUBKEY="${PUBKEY}" \
  PLEXUS_MESH_UPSTREAM_TLS_CA="${TLS_CERT}" PLEXUS_WORKLOAD="proxy-a" PLEXUS_JOIN_TOKEN="${TOKEN_A}" \
  bun run "${GW}" >"${PROXY_A_LOG}" 2>&1 &
PROXY_A_PID=$!
wait_log "MESH_DEMO_READY role=proxy" "${PROXY_A_LOG}" 40 || { sed 's/^/  [proxy-a] /' "${PROXY_A_LOG}"; exit 1; }

echo "[live] booting PROXY-B (ws/enc-OFF, mock)…"
PLEXUS_HOME="${PROXY_B_HOME}" PLEXUS_PORT="${PROXY_B_PORT}" PLEXUS_MODE="proxy" \
  PLEXUS_DEMO_PROXY_SOURCE="mock" \
  PLEXUS_UPSTREAM_URL="ws://127.0.0.1:${WS}" PLEXUS_UPSTREAM_PUBKEY="${PUBKEY}" \
  PLEXUS_WORKLOAD="proxy-b" PLEXUS_JOIN_TOKEN="${TOKEN_B}" \
  bun run "${GW}" >"${PROXY_B_LOG}" 2>&1 &
PROXY_B_PID=$!
wait_log "MESH_DEMO_READY role=proxy" "${PROXY_B_LOG}" 40 || { sed 's/^/  [proxy-b] /' "${PROXY_B_LOG}"; exit 1; }

echo "[live] waiting for both proxy catalogs to auto-mount…"
for i in $(seq 1 60); do
  MOUNTED="$(adminget /admin/api/exposure 2>/dev/null | jq -r '.capabilities[]?.id // .[]?.id // empty' 2>/dev/null | grep -c '^local/proxy-')"
  [ "${MOUNTED:-0}" -ge 2 ] && break; sleep 0.5
done
echo "[live] enabling exposure on every mounted proxy capability…"
adminget /admin/api/exposure 2>/dev/null | jq -r '(.capabilities[]?.id // .[]?.id // empty)' 2>/dev/null \
  | grep '^local/proxy-' | while read -r addr; do
      enc="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$addr")"
      adminpost "/admin/api/exposure/${enc}" '{"enabled":true}' >/dev/null
    done

CK="$(ck)"
echo
echo "════════════════════════════════════════════════════════════════════════════"
echo "  PLEXUS FEDERATED MESH — LIVE (mac primary + proxy-A wss/enc-ON + proxy-B ws/enc-OFF)"
echo "════════════════════════════════════════════════════════════════════════════"
echo "  ADMIN CONSOLE:   ${BASE}/admin"
echo "  CONNECTION KEY:  ${CK}"
echo "  (the admin SPA is connection-key gated — paste the key when it asks)"
echo
echo "  PIDs: primary=${PRIMARY_PID}  proxy-a=${PROXY_A_PID}  proxy-b=${PROXY_B_PID}"
echo "  tunnel: ws://127.0.0.1:${WS} (enc-OFF)  +  wss://127.0.0.1:${WSS} (enc-ON)"
echo "  aggregated .well-known (mac own + 2 proxies):"
curl -s "${BASE}/.well-known/plexus" 2>/dev/null | jq -r '.capabilities[]?.id // .entries[]?.id // empty' 2>/dev/null | sed 's/^/    • /' | head -40
echo "════════════════════════════════════════════════════════════════════════════"
echo "  LIVE_READY"
echo "  (Ctrl-C / kill this shell to tear the whole mesh down.)"
wait
