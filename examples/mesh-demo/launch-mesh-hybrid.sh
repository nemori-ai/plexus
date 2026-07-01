#!/usr/bin/env bash
#
# launch-mesh-hybrid.sh — the REAL network-complexity topology:
#   • a NATIVE MAC PRIMARY (this host) exposing its OWN caps (workspace + apple-calendar),
#     tunnel bound on 0.0.0.0 (routable from containers), dual ws+wss, self-signed cert
#     whose SAN covers host.docker.internal,
#   • TWO DOCKERIZED LINUX PROXIES (plexus-gateway:latest) dialing OUT of their containers,
#     ACROSS the docker→host boundary, into the mac's tunnel via host.docker.internal:
#       – proxy-a  wss://host.docker.internal:8443  (enc-ON, trusts the cert via NODE_EXTRA_CA_CERTS)
#       – proxy-b  ws://host.docker.internal:8080   (enc-OFF)
#   • all aggregated into ONE multi-source collection on the primary.
#
# The proxies are genuinely in Linux containers reaching a process on the mac — the real
# cross-host reachability the localhost demo fakes. Stays UP for you to browse the admin
# console; Ctrl-C tears down the primary AND removes the two proxy containers.
#
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"; cd "${REPO_ROOT}"
GW="examples/mesh-demo/gateway.ts"; CLI="packages/cli/src/bin/plexus"
IMAGE="plexus-gateway:latest"
CA="plexus-hybrid-proxy-a"; CB="plexus-hybrid-proxy-b"   # container names

# ── stable state dir so the connection-key persists across relaunches ─────────────
STATE_ROOT="/tmp/plexus-hybrid"
PRIMARY_HOME="${STATE_ROOT}/primary-home"
PRIMARY_WS_DIR="${STATE_ROOT}/mac-ws"
PROXY_A_DATA="${STATE_ROOT}/proxy-a-data"
PROXY_B_DATA="${STATE_ROOT}/proxy-b-data"
CERT_DIR="${STATE_ROOT}/certs"; TLS_CERT="${CERT_DIR}/primary-cert.pem"; TLS_KEY="${CERT_DIR}/primary-key.pem"
PRIMARY_LOG="${STATE_ROOT}/primary.log"
mkdir -p "${PRIMARY_HOME}" "${PRIMARY_WS_DIR}" "${PROXY_A_DATA}" "${PROXY_B_DATA}" "${CERT_DIR}"
PRIMARY_PID=""

PRIMARY_PORT=7077
TUNNEL_WS_PORT=8080
TUNNEL_WSS_PORT=8443
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'; }
port_free() { node -e 'const n=require("net").createServer();n.listen(Number(process.argv[1]),"0.0.0.0",()=>{n.close(()=>process.exit(0))}).on("error",()=>process.exit(1))' "$1" 2>/dev/null; }
port_free "${PRIMARY_PORT}"    || PRIMARY_PORT="$(free_port)"
port_free "${TUNNEL_WS_PORT}"  || TUNNEL_WS_PORT=18080
port_free "${TUNNEL_WSS_PORT}" || TUNNEL_WSS_PORT=18443
BASE="http://127.0.0.1:${PRIMARY_PORT}"

cleanup() {
  echo; echo "[hybrid] tearing down…"
  docker rm -f "${CA}" "${CB}" >/dev/null 2>&1
  [ -n "${PRIMARY_PID}" ] && kill "${PRIMARY_PID}" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM
wait_log() { local p="$1" f="$2" s="${3:-40}" i=0; while [ "$i" -lt "$((s*10))" ]; do grep -Eq "$p" "$f" 2>/dev/null && return 0; sleep 0.1; i=$((i+1)); done; return 1; }
ck() { cat "${PRIMARY_HOME}/connection-key" 2>/dev/null; }
adminget()  { curl -s "${BASE}$1" -H "X-Plexus-Connection-Key: $(ck)"; }
adminpost() { curl -s -X POST "${BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: $(ck)" -d "$2"; }

command -v docker >/dev/null 2>&1 || { echo "[hybrid] docker not found"; exit 1; }
docker image inspect "${IMAGE}" >/dev/null 2>&1 || { echo "[hybrid] image ${IMAGE} missing — build it first"; exit 1; }
docker rm -f "${CA}" "${CB}" >/dev/null 2>&1   # idempotent: clear stale containers

# ── cert with SAN host.docker.internal (proxy-a's wss verifies the dialed hostname) ──
openssl req -x509 -newkey rsa:2048 -nodes -keyout "${TLS_KEY}" -out "${TLS_CERT}" -days 365 \
  -subj "/CN=host.docker.internal" \
  -addext "subjectAltName=DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
openssl x509 -in "${TLS_CERT}" -noout -text 2>/dev/null | grep -q "DNS:host.docker.internal" \
  || { echo "[hybrid] cert missing SAN DNS:host.docker.internal"; exit 1; }
printf 'Hello from the MAC PRIMARY (its own workspace cap, running natively on macOS).\n' > "${PRIMARY_WS_DIR}/mac-note.txt"
printf 'Hello from PROXY-A — Linux container, workspace over wss (encryption ON).\n' > "${PROXY_A_DATA}/from-proxy-a.txt"
printf 'Hello from PROXY-B — Linux container, workspace over ws (encryption OFF).\n' > "${PROXY_B_DATA}/from-proxy-b.txt"

echo "[hybrid] booting NATIVE MAC PRIMARY on ${BASE} (tunnel on 0.0.0.0:${TUNNEL_WS_PORT}/${TUNNEL_WSS_PORT})…"
PLEXUS_HOME="${PRIMARY_HOME}" PLEXUS_PORT="${PRIMARY_PORT}" PLEXUS_INSTANCE="hybrid-mac-primary" \
  PLEXUS_WORKLOAD="mac-laptop" PLEXUS_DEMO_PRIMARY_SOURCES="workspace,apple-calendar" \
  PLEXUS_FAKE_APPLE="1" PLEXUS_WORKSPACE_DIR="${PRIMARY_WS_DIR}" \
  PLEXUS_MESH_TUNNEL_HOST="0.0.0.0" PLEXUS_MESH_WS_PORT="${TUNNEL_WS_PORT}" PLEXUS_MESH_WSS_PORT="${TUNNEL_WSS_PORT}" \
  PLEXUS_MESH_TLS_CERT="${TLS_CERT}" PLEXUS_MESH_TLS_KEY="${TLS_KEY}" \
  bun run "${GW}" >"${PRIMARY_LOG}" 2>&1 &
PRIMARY_PID=$!
wait_log "MESH_DEMO_READY role=primary" "${PRIMARY_LOG}" 40 || { sed 's/^/  [primary] /' "${PRIMARY_LOG}"; exit 1; }
echo "[hybrid] primary up. connection-key=$(ck)"

# ── prove a container can actually REACH the mac's tunnel before booting proxies ──
echo "[hybrid] probing container → host reachability (host.docker.internal:${TUNNEL_WS_PORT})…"
PROBE="$(docker run --rm --add-host=host.docker.internal:host-gateway "${IMAGE}" \
  bash -lc "curl -s -o /dev/null -w '%{http_code}' http://host.docker.internal:${TUNNEL_WS_PORT}/ 2>/dev/null" 2>/dev/null)"
if [ "${PROBE:-000}" = "000" ]; then
  echo "[hybrid] ✗ a container could NOT reach host.docker.internal:${TUNNEL_WS_PORT} (got 000)."
  echo "          The mac tunnel is bound 0.0.0.0 but the docker→host route failed."
  exit 1
fi
echo "[hybrid] ✓ container reached the mac tunnel (HTTP ${PROBE} — a non-000 code proves TCP reachability)."

# ── mint two one-time join tokens ────────────────────────────────────────────────
MINT_A="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh mint --url "${BASE}" --json 2>/dev/null)"
MINT_B="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh mint --url "${BASE}" --json 2>/dev/null)"
TOKEN_A="$(printf '%s' "${MINT_A}" | jq -r '.token')"; TOKEN_B="$(printf '%s' "${MINT_B}" | jq -r '.token')"
PUBKEY="$(printf '%s' "${MINT_A}" | jq -r '.primaryPubKey')"
[ -n "${TOKEN_A}" ] && [ -n "${TOKEN_B}" ] && [ -n "${PUBKEY}" ] || { echo "[hybrid] mint failed: A=${MINT_A}"; exit 1; }

echo "[hybrid] booting PROXY-A container (wss/enc-ON) → wss://host.docker.internal:${TUNNEL_WSS_PORT}…"
docker run -d --name "${CA}" --add-host=host.docker.internal:host-gateway \
  -e PLEXUS_MODE=proxy -e PLEXUS_INSTANCE=hybrid-proxy-a -e PLEXUS_WORKLOAD=proxy-a -e PLEXUS_PORT=7077 \
  -e PLEXUS_WORKSPACE_DIR=/data/proxy-a \
  -e PLEXUS_UPSTREAM_URL="wss://host.docker.internal:${TUNNEL_WSS_PORT}" \
  -e PLEXUS_UPSTREAM_PUBKEY="${PUBKEY}" -e PLEXUS_JOIN_TOKEN="${TOKEN_A}" \
  -e NODE_EXTRA_CA_CERTS=/certs/primary-cert.pem \
  -v "${CERT_DIR}:/certs:ro" -v "${PROXY_A_DATA}:/data/proxy-a" \
  "${IMAGE}" >/dev/null || { echo "[hybrid] proxy-a run failed"; exit 1; }

echo "[hybrid] booting PROXY-B container (ws/enc-OFF) → ws://host.docker.internal:${TUNNEL_WS_PORT}…"
docker run -d --name "${CB}" --add-host=host.docker.internal:host-gateway \
  -e PLEXUS_MODE=proxy -e PLEXUS_INSTANCE=hybrid-proxy-b -e PLEXUS_WORKLOAD=proxy-b -e PLEXUS_PORT=7077 \
  -e PLEXUS_WORKSPACE_DIR=/data/proxy-b \
  -e PLEXUS_UPSTREAM_URL="ws://host.docker.internal:${TUNNEL_WS_PORT}" \
  -e PLEXUS_UPSTREAM_PUBKEY="${PUBKEY}" -e PLEXUS_JOIN_TOKEN="${TOKEN_B}" \
  -v "${PROXY_B_DATA}:/data/proxy-b" \
  "${IMAGE}" >/dev/null || { echo "[hybrid] proxy-b run failed"; exit 1; }

echo "[hybrid] waiting for both containers to enroll + auto-mount their catalogs…"
ok_a=0; ok_b=0
for i in $(seq 1 80); do
  ids="$(adminget /admin/api/exposure 2>/dev/null | jq -r '(.capabilities[]?.id // .[]?.id // empty)' 2>/dev/null)"
  printf '%s' "$ids" | grep -q '^local/proxy-a/' && ok_a=1
  printf '%s' "$ids" | grep -q '^local/proxy-b/' && ok_b=1
  [ "$ok_a" = 1 ] && [ "$ok_b" = 1 ] && break
  sleep 0.75
done
if [ "$ok_a" != 1 ] || [ "$ok_b" != 1 ]; then
  echo "[hybrid] ✗ enrollment incomplete (proxy-a=${ok_a} proxy-b=${ok_b}). Container logs:"
  echo "---- proxy-a ----"; docker logs --tail 30 "${CA}" 2>&1 | sed 's/^/  /'
  echo "---- proxy-b ----"; docker logs --tail 30 "${CB}" 2>&1 | sed 's/^/  /'
  exit 1
fi

echo "[hybrid] enabling exposure on every mounted proxy capability…"
adminget /admin/api/exposure 2>/dev/null | jq -r '(.capabilities[]?.id // .[]?.id // empty)' 2>/dev/null \
  | grep '^local/proxy-' | while read -r addr; do
      enc="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$addr")"
      adminpost "/admin/api/exposure/${enc}" '{"enabled":true}' >/dev/null
    done

CK="$(ck)"
echo
echo "════════════════════════════════════════════════════════════════════════════"
echo "  PLEXUS HYBRID MESH — LIVE  (native mac primary + 2 dockerized linux proxies)"
echo "════════════════════════════════════════════════════════════════════════════"
echo "  ADMIN CONSOLE:   ${BASE}/admin"
echo "  CONNECTION KEY:  ${CK}"
echo
echo "  primary : NATIVE on macOS (PID ${PRIMARY_PID}), tunnel 0.0.0.0:${TUNNEL_WS_PORT}(ws)/${TUNNEL_WSS_PORT}(wss)"
echo "  proxy-a : docker container '${CA}'  → wss://host.docker.internal:${TUNNEL_WSS_PORT} (enc-ON)"
echo "  proxy-b : docker container '${CB}'  → ws://host.docker.internal:${TUNNEL_WS_PORT}  (enc-OFF)"
echo "  $(docker ps --filter name=plexus-hybrid --format '{{.Names}}: {{.Status}}' | tr '\n' '|')"
echo "  aggregated .well-known (mac primary + 2 linux containers = ONE collection):"
curl -s "${BASE}/.well-known/plexus" 2>/dev/null | jq -r '.capabilities[]?.id // .entries[]?.id // empty' 2>/dev/null | sed 's/^/    • /' | head -40
echo "════════════════════════════════════════════════════════════════════════════"
echo "  LIVE_READY"
echo "  (Ctrl-C / kill this shell to stop the primary AND remove both proxy containers.)"
wait
