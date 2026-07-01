#!/usr/bin/env bash
#
# run-multihost-local.sh — a REAL multi-host federated-mesh TOPOLOGY on localhost (NO docker),
# narrated. It proves the whole user goal in ONE run:
#
#   • a MAC PRIMARY exposing its OWN caps (workspace + apple-calendar), PLUS
#   • TWO proxy processes exposing DIFFERENT caps,
#       – PROXY-A over wss  (channel-encryption ON,  self-signed TLS, dialed wss://127.0.0.1:<wss>)
#       – PROXY-B over ws   (channel-encryption OFF, plain          , dialed ws://127.0.0.1:<ws>)
#   • all aggregated into ONE collection a single agent invokes THROUGH the primary "like local."
#
# THREE genuinely independent OS processes (own PID, own PLEXUS_HOME, own Ed25519 key) talk only
# over the real mesh tunnel; this script is the FOURTH process — the AGENT — hitting ONLY the
# primary's HTTP surface with real curl. Everything is loopback; nothing is mocked on the wire.
#
# Topology proven, end to end:
#   1. boot the MAC PRIMARY (own caps scanned + discoverable BEFORE any proxy connects),
#   2. mint two one-time join tokens (one targeting the wss endpoint, one the ws endpoint),
#   3. boot PROXY-A (workspace over /tmp/proxy-a-data) dialing wss  — enc-ON,  trusting the self-signed CA,
#   4. boot PROXY-B (mock source)                       dialing ws   — enc-OFF,
#   5. both auto-mount; the owner enables exposure on each mounted prefix,
#   6. ONE agent discovers the aggregated .well-known (mac-own + proxy-a + proxy-b = ONE list, 3 sources),
#      handshakes once, grants (consenting the pends), and invokes a cap from EACH of the 3 sources,
#   7. downtime: kill PROXY-B → its cap returns capability_unavailable while PROXY-A + mac persist,
#   8. revocation: `plexus mesh revoke proxy-a` → proxy-A's caps vanish from .well-known.
#
# Usage:  bash examples/mesh-demo/run-multihost-local.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# ── colours / narration helpers ───────────────────────────────────────────────
BOLD=$'\e[1m'; DIM=$'\e[2m'; CYAN=$'\e[36m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
bar() { printf '%s\n' "${CYAN}────────────────────────────────────────────────────────────────────────${RESET}"; }
header() { printf '\n'; bar; printf '%s%sSTEP %s%s  %s%s%s\n' "${BOLD}" "${CYAN}" "$1" "${RESET}" "${BOLD}" "$2" "${RESET}"; bar; }
say()    { printf '  %s\n' "$1"; }
ok()     { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$1"; }
detail() { printf '    %s%s%s %s\n' "${DIM}" "$1" "${RESET}" "$2"; }
note()   { printf '  %s»%s %s\n' "${YELLOW}" "${RESET}" "$1"; }
die()    { printf '\n%s%sDEMO FAILED%s: %s\n' "${BOLD}" "${RED}" "${RESET}" "$1" >&2; exit 1; }

GW="examples/mesh-demo/gateway.ts"
CLI="packages/cli/src/bin/plexus"
AGENT_ID="agent-multihost-demo"

# ── isolated, throwaway state per process ─────────────────────────────────────
PRIMARY_HOME="$(mktemp -d -t plexus-mh-primary.XXXXXX)"
PROXY_A_HOME="$(mktemp -d -t plexus-mh-proxya.XXXXXX)"
PROXY_B_HOME="$(mktemp -d -t plexus-mh-proxyb.XXXXXX)"
PRIMARY_WS_DIR="$(mktemp -d -t plexus-mh-mac-ws.XXXXXX)"      # the mac's OWN workspace root
PROXY_A_DIR="/tmp/proxy-a-data"                               # proxy-A's DISTINCT workspace root
TLS_DIR="$(mktemp -d -t plexus-mh-tls.XXXXXX)"
TLS_CERT="${TLS_DIR}/primary-cert.pem"
TLS_KEY="${TLS_DIR}/primary-key.pem"
PRIMARY_LOG="$(mktemp -t plexus-mh-primary-log.XXXXXX)"
PROXY_A_LOG="$(mktemp -t plexus-mh-proxya-log.XXXXXX)"
PROXY_B_LOG="$(mktemp -t plexus-mh-proxyb-log.XXXXXX)"
PRIMARY_PID=""; PROXY_A_PID=""; PROXY_B_PID=""

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'; }
PRIMARY_PORT="$(free_port)"
TUNNEL_WS_PORT="$(free_port)"
TUNNEL_WSS_PORT="$(free_port)"
PROXY_A_PORT="$(free_port)"
PROXY_B_PORT="$(free_port)"
PRIMARY_BASE="http://127.0.0.1:${PRIMARY_PORT}"

cleanup() {
  [ -n "${PROXY_A_PID}" ] && kill "${PROXY_A_PID}" 2>/dev/null
  [ -n "${PROXY_B_PID}" ] && kill "${PROXY_B_PID}" 2>/dev/null
  [ -n "${PRIMARY_PID}" ] && kill "${PRIMARY_PID}" 2>/dev/null
  wait 2>/dev/null
  rm -rf "${PRIMARY_HOME}" "${PROXY_A_HOME}" "${PROXY_B_HOME}" "${PRIMARY_WS_DIR}" "${PROXY_A_DIR}" \
         "${TLS_DIR}" "${PRIMARY_LOG}" "${PROXY_A_LOG}" "${PROXY_B_LOG}" 2>/dev/null
}
trap cleanup EXIT INT TERM

# Wait until $1 (a regex) appears in file $2, or time out after $3 seconds.
wait_for_log() {
  local pat="$1" file="$2" secs="${3:-25}" i=0
  while [ "$i" -lt "$((secs * 10))" ]; do
    grep -Eq "$pat" "$file" 2>/dev/null && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

# curl helpers against the PRIMARY's surfaces (real HTTP, loopback Host).
agent_post() { curl -s -X POST "${PRIMARY_BASE}$1" -H 'content-type: application/json' -d "$2"; }
agent_put()  { curl -s -X PUT  "${PRIMARY_BASE}$1" -H 'content-type: application/json' -d "$2"; }
admin_get()  { curl -s "${PRIMARY_BASE}$1" -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}"; }
admin_post() { curl -s -X POST "${PRIMARY_BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}" -d "$2"; }
admin_put()  { curl -s -X PUT  "${PRIMARY_BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}" -d "$2"; }
wellknown_ids() { curl -s "${PRIMARY_BASE}/.well-known/plexus" | jq -r '.capabilities[]?.id'; }

# Enable top-level exposure on one mounted address (the owner's deliberate access act).
expose() {
  local addr="$1" enc res
  enc="$(printf '%s' "${addr}" | jq -rn --arg s "${addr}" '$s|@uri')"
  res="$(admin_post "/admin/api/exposure/${enc}" '{"enabled":true}')"
  printf '%s' "${res}" | jq -e '.ok == true' >/dev/null 2>&1 || die "exposure toggle failed for ${addr}: ${res}"
}

# Grant an address for the agent's session, consenting any pend via the admin surface; echo a token.
grant_token() {
  local addr="$1" body grant pend
  body="$(jq -nc --arg s "${SESSION_ID}" --arg a "${addr}" '{sessionId:$s, grants:{($a):"allow"}}')"
  grant="$(agent_put /grants "${body}")"
  pend="$(printf '%s' "${grant}" | jq -r '.pendingId // empty')"
  if [ -n "${pend}" ]; then
    admin_put /admin/api/grants \
      "$(jq -nc --arg a "${AGENT_ID}" --arg c "${addr}" '{agentId:$a, grants:{($c):"allow"}}')" >/dev/null
    grant="$(agent_put /grants "${body}")"
  fi
  printf '%s' "${grant}" | jq -r '.token // empty'
}

# Invoke an address through the primary with a scoped token; echoes the raw JSON reply.
invoke_cap() {
  local addr="$1" input="$2" token="$3"
  curl -s -X POST "${PRIMARY_BASE}/invoke" -H 'content-type: application/json' \
    -H "authorization: Bearer ${token}" \
    -d "$(jq -nc --arg a "${addr}" --argjson in "${input}" '{id:$a, input:$in}')"
}

printf '%s╔══════════════════════════════════════════════════════════════════════╗%s\n' "${BOLD}" "${RESET}"
printf '%s║  Plexus federated mesh — MULTI-HOST localhost topology (no docker)    ║%s\n' "${BOLD}" "${RESET}"
printf '%s║  mac primary + proxy-A (wss/enc-ON) + proxy-B (ws/enc-OFF) ⇒ 1 agent  ║%s\n' "${BOLD}" "${RESET}"
printf '%s╚══════════════════════════════════════════════════════════════════════╝%s\n' "${BOLD}" "${RESET}"
detail "mac PLEXUS_HOME"      "${PRIMARY_HOME}"
detail "proxy-A PLEXUS_HOME"  "${PROXY_A_HOME}"
detail "proxy-B PLEXUS_HOME"  "${PROXY_B_HOME}"
detail "mac workspace root"   "${PRIMARY_WS_DIR}"
detail "proxy-A workspace"    "${PROXY_A_DIR}"

# ──────────────────────────────────────────────────────────────────────────────
header 0 "Generate a self-signed TLS cert for the primary's wss tunnel listener"
# ──────────────────────────────────────────────────────────────────────────────
openssl req -x509 -newkey rsa:2048 -nodes -keyout "${TLS_KEY}" -out "${TLS_CERT}" -days 1 \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" >/dev/null 2>&1 \
  || die "openssl failed to generate the self-signed cert"
ok "Self-signed cert minted (CN=127.0.0.1, SAN IP:127.0.0.1) — confidentiality under the Ed25519 identity layer."
detail "cert" "${TLS_CERT}"
detail "key " "${TLS_KEY}"

# Seed each workspace with DISTINCT content so an invoke visibly proves WHICH host executed it.
printf 'Hello from the MAC PRIMARY (its OWN workspace cap).\n' > "${PRIMARY_WS_DIR}/mac-note.txt"
mkdir -p "${PROXY_A_DIR}"
printf 'Hello from PROXY-A — workspace served over wss (channel-encryption ON).\n' > "${PROXY_A_DIR}/from-proxy-a.txt"

# ──────────────────────────────────────────────────────────────────────────────
header 1 "Boot the MAC PRIMARY exposing its OWN caps (workspace + apple-calendar)"
# ──────────────────────────────────────────────────────────────────────────────
say "Spawning the primary with a DUAL tunnel listener (ws + wss) bound on 127.0.0.1:"
say "  PLEXUS_DEMO_PRIMARY_SOURCES=workspace,apple-calendar  PLEXUS_FAKE_APPLE=1  (deterministic)"
say "  PLEXUS_MESH_WS_PORT=${TUNNEL_WS_PORT}  PLEXUS_MESH_WSS_PORT=${TUNNEL_WSS_PORT}  + the self-signed cert/key"
PLEXUS_HOME="${PRIMARY_HOME}" PLEXUS_PORT="${PRIMARY_PORT}" PLEXUS_INSTANCE="mh-mac-primary" \
  PLEXUS_WORKLOAD="mac-laptop" \
  PLEXUS_DEMO_PRIMARY_SOURCES="workspace,apple-calendar" \
  PLEXUS_FAKE_APPLE="1" PLEXUS_WORKSPACE_DIR="${PRIMARY_WS_DIR}" \
  PLEXUS_MESH_TUNNEL_HOST="127.0.0.1" \
  PLEXUS_MESH_WS_PORT="${TUNNEL_WS_PORT}" PLEXUS_MESH_WSS_PORT="${TUNNEL_WSS_PORT}" \
  PLEXUS_MESH_TLS_CERT="${TLS_CERT}" PLEXUS_MESH_TLS_KEY="${TLS_KEY}" \
  bun run "${GW}" >"${PRIMARY_LOG}" 2>&1 &
PRIMARY_PID=$!
wait_for_log "MESH_DEMO_READY role=primary" "${PRIMARY_LOG}" 30 \
  || { sed 's/^/    [primary] /' "${PRIMARY_LOG}"; die "mac primary did not come up"; }
ok "MAC PRIMARY is up as a separate OS process."
detail "primary PID"        "${PRIMARY_PID}"
detail "agent HTTP surface" "${PRIMARY_BASE}"
detail "tunnel ws  (enc-OFF)" "ws://127.0.0.1:${TUNNEL_WS_PORT}"
detail "tunnel wss (enc-ON) " "wss://127.0.0.1:${TUNNEL_WSS_PORT}"
ps -o pid,comm -p "${PRIMARY_PID}" | sed 's/^/    /'

CONNECTION_KEY="$(cat "${PRIMARY_HOME}/connection-key" 2>/dev/null)"
[ -n "${CONNECTION_KEY}" ] || die "primary did not write a connection-key"
detail "primary connection-key (trust boundary)" "${CONNECTION_KEY:0:12}…"

say ""
say "Assert the mac's OWN caps are discoverable in /.well-known BEFORE any proxy connects:"
MAC_IDS="$(wellknown_ids | grep -E '^(workspace|apple-calendar)\.' | sort)"
printf '%s' "${MAC_IDS}" | grep -q '^workspace\.' || { sed 's/^/    [primary] /' "${PRIMARY_LOG}"; die "mac primary did not expose its own workspace caps"; }
printf '%s' "${MAC_IDS}" | grep -q '^apple-calendar\.' || die "mac primary did not expose its own apple-calendar caps"
ok "The mac exposes its OWN caps (3-source aggregation starts with the host itself):"
printf '%s\n' "${MAC_IDS}" | sed 's/^/      • /'

# ──────────────────────────────────────────────────────────────────────────────
header 2 "Mint TWO one-time join tokens — one for the wss endpoint, one for the ws"
# ──────────────────────────────────────────────────────────────────────────────
say "  plexus mesh mint --json   (×2; single-use — a fresh token per proxy)"
MINT_A="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh mint --url "${PRIMARY_BASE}" --json 2>/dev/null)"
MINT_B="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh mint --url "${PRIMARY_BASE}" --json 2>/dev/null)"
TOKEN_A="$(printf '%s' "${MINT_A}" | jq -r '.token // empty')"
TOKEN_B="$(printf '%s' "${MINT_B}" | jq -r '.token // empty')"
PRIMARY_PUBKEY="$(printf '%s' "${MINT_A}" | jq -r '.primaryPubKey // empty')"
WSS_PORT="$(printf '%s' "${MINT_A}" | jq -r '.endpoints[]? | select(.scheme=="wss") | .port')"
WS_PORT="$(printf '%s'  "${MINT_A}" | jq -r '.endpoints[]? | select(.scheme=="ws")  | .port')"
[ -n "${TOKEN_A}" ] && [ -n "${TOKEN_B}" ] || die "mint returned no token (A=${MINT_A} B=${MINT_B})"
[ -n "${WSS_PORT}" ] || die "primary advertised no wss endpoint (B7 dual listener not bound): ${MINT_A}"
[ -n "${WS_PORT}" ]  || die "primary advertised no ws endpoint: ${MINT_A}"
UPSTREAM_A="wss://127.0.0.1:${WSS_PORT}"   # proxy-A — enc-ON
UPSTREAM_B="ws://127.0.0.1:${WS_PORT}"     # proxy-B — enc-OFF
ok "Primary advertises BOTH tunnel endpoints; built one upstream per proxy:"
detail "proxy-A upstream (enc-ON, TLS) " "${BOLD}${GREEN}${UPSTREAM_A}${RESET}"
detail "proxy-B upstream (enc-OFF)     " "${BOLD}${YELLOW}${UPSTREAM_B}${RESET}"
detail "pinned primaryPubKey (no bare TOFU)" "${PRIMARY_PUBKEY:0:44}…"

# ──────────────────────────────────────────────────────────────────────────────
header 3 "Boot PROXY-A → dial wss (enc-ON), trusting the self-signed CA; exposes 'workspace'"
# ──────────────────────────────────────────────────────────────────────────────
say "  PLEXUS_MODE=proxy  PLEXUS_DEMO_PROXY_SOURCE=workspace  PLEXUS_WORKSPACE_DIR=${PROXY_A_DIR}"
say "  PLEXUS_UPSTREAM_URL=${UPSTREAM_A}   PLEXUS_MESH_UPSTREAM_TLS_CA=<primary cert>   (per-connection trust)"
PLEXUS_HOME="${PROXY_A_HOME}" PLEXUS_PORT="${PROXY_A_PORT}" PLEXUS_MODE="proxy" \
  PLEXUS_DEMO_PROXY_SOURCE="workspace" PLEXUS_WORKSPACE_DIR="${PROXY_A_DIR}" \
  PLEXUS_UPSTREAM_URL="${UPSTREAM_A}" PLEXUS_UPSTREAM_PUBKEY="${PRIMARY_PUBKEY}" \
  PLEXUS_MESH_UPSTREAM_TLS_CA="${TLS_CERT}" \
  PLEXUS_WORKLOAD="proxy-a" PLEXUS_JOIN_TOKEN="${TOKEN_A}" \
  bun run "${GW}" >"${PROXY_A_LOG}" 2>&1 &
PROXY_A_PID=$!
wait_for_log "MESH_DEMO_READY role=proxy" "${PROXY_A_LOG}" 30 \
  || { sed 's/^/    [proxy-a] /' "${PROXY_A_LOG}"; die "proxy-A did not come up"; }
ok "PROXY-A is up as a SEPARATE process, dialing over ${BOLD}wss (enc-ON)${RESET}."
detail "proxy-A PID" "${PROXY_A_PID}"

# ──────────────────────────────────────────────────────────────────────────────
header 4 "Boot PROXY-B → dial ws (enc-OFF); exposes a DIFFERENT cap surface ('mock')"
# ──────────────────────────────────────────────────────────────────────────────
say "  PLEXUS_MODE=proxy  PLEXUS_DEMO_PROXY_SOURCE=mock   PLEXUS_UPSTREAM_URL=${UPSTREAM_B}  (plain ws)"
PLEXUS_HOME="${PROXY_B_HOME}" PLEXUS_PORT="${PROXY_B_PORT}" PLEXUS_MODE="proxy" \
  PLEXUS_DEMO_PROXY_SOURCE="mock" \
  PLEXUS_UPSTREAM_URL="${UPSTREAM_B}" PLEXUS_UPSTREAM_PUBKEY="${PRIMARY_PUBKEY}" \
  PLEXUS_WORKLOAD="proxy-b" PLEXUS_JOIN_TOKEN="${TOKEN_B}" \
  bun run "${GW}" >"${PROXY_B_LOG}" 2>&1 &
PROXY_B_PID=$!
wait_for_log "MESH_DEMO_READY role=proxy" "${PROXY_B_LOG}" 30 \
  || { sed 's/^/    [proxy-b] /' "${PROXY_B_LOG}"; die "proxy-B did not come up"; }
ok "PROXY-B is up as a SEPARATE process, dialing over ${BOLD}ws (enc-OFF)${RESET}."
detail "proxy-B PID" "${PROXY_B_PID}"
ps -o pid,comm -p "${PRIMARY_PID}" -p "${PROXY_A_PID}" -p "${PROXY_B_PID}" | sed 's/^/    /'

# ──────────────────────────────────────────────────────────────────────────────
header 5 "Wait for BOTH proxies to auto-mount, then the owner enables exposure"
# ──────────────────────────────────────────────────────────────────────────────
ADDR_A="local/proxy-a/workspace.read"     # proxy-A's cap (workspace), addressed by provenance
ADDR_B="local/proxy-b/mock.echo.run"      # proxy-B's cap (mock), genuinely different surface
wait_mount() { # $1 = prefix
  local i=0
  while [ "$i" -lt 150 ]; do
    admin_get /admin/api/exposure | jq -e --arg p "$1" 'any(.capabilities[].id; startswith($p))' >/dev/null 2>&1 && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}
wait_mount "local/proxy-a/" || { sed 's/^/    [proxy-a] /' "${PROXY_A_LOG}"; die "primary never auto-mounted proxy-A (wss trust / enroll failed?)"; }
wait_mount "local/proxy-b/" || { sed 's/^/    [proxy-b] /' "${PROXY_B_LOG}"; die "primary never auto-mounted proxy-B"; }
ok "Primary auto-mounted BOTH proxies' catalogs under their provenance prefixes (live ascent)."
say "Mounted addresses (default HIDDEN — join ≠ access):"
admin_get /admin/api/exposure | jq -r '.capabilities[].id | select(startswith("local/proxy-"))' | sort | sed 's/^/      • /'

say ""
say "Owner enables exposure on every mounted address of both proxies (admin toggle):"
for addr in $(admin_get /admin/api/exposure | jq -r '.capabilities[].id | select(startswith("local/proxy-a/"))'); do expose "${addr}"; done
for addr in $(admin_get /admin/api/exposure | jq -r '.capabilities[].id | select(startswith("local/proxy-b/"))'); do expose "${addr}"; done
ok "Exposure enabled on proxy-A + proxy-B surfaces."

# ──────────────────────────────────────────────────────────────────────────────
header 6 "ONE aggregated collection: the agent discovers mac + proxy-A + proxy-B as ONE list"
# ──────────────────────────────────────────────────────────────────────────────
say "The agent talks ONLY to the primary at ${PRIMARY_BASE} — it never sees a proxy directly."
say "  → GET /.well-known/plexus   (the SINGLE aggregated catalog)"
ALL_IDS="$(wellknown_ids | sort)"
N_MAC="$(printf '%s\n' "${ALL_IDS}" | grep -cE '^(workspace|apple-calendar)\.')"
N_A="$(printf '%s\n'   "${ALL_IDS}" | grep -c '^local/proxy-a/')"
N_B="$(printf '%s\n'   "${ALL_IDS}" | grep -c '^local/proxy-b/')"
printf '    %s──── mac-laptop (own caps) ────%s\n' "${DIM}" "${RESET}"
printf '%s\n' "${ALL_IDS}" | grep -E '^(workspace|apple-calendar)\.' | sed 's/^/      • /'
printf '    %s──── proxy-a (via wss/enc-ON) ────%s\n' "${DIM}" "${RESET}"
printf '%s\n' "${ALL_IDS}" | grep '^local/proxy-a/' | sed 's/^/      • /'
printf '    %s──── proxy-b (via ws/enc-OFF) ────%s\n' "${DIM}" "${RESET}"
printf '%s\n' "${ALL_IDS}" | grep '^local/proxy-b/' | sed 's/^/      • /'
[ "${N_MAC}" -ge 1 ] && [ "${N_A}" -ge 1 ] && [ "${N_B}" -ge 1 ] \
  || die "the aggregated catalog is missing a source (mac=${N_MAC} proxy-a=${N_A} proxy-b=${N_B})"
ok "ONE collection, THREE provenances (mac=${N_MAC}, proxy-a=${N_A}, proxy-b=${N_B} caps) — the agent sees them as local."

say "  → POST /link/handshake   (one session for the whole aggregated surface)"
HS="$(agent_post /link/handshake "$(jq -nc --arg k "${CONNECTION_KEY}" --arg a "${AGENT_ID}" '{connectionKey:$k, client:{name:"multihost-agent", agentId:$a}}')")"
SESSION_ID="$(printf '%s' "${HS}" | jq -r '.sessionId // empty')"
[ -n "${SESSION_ID}" ] || die "handshake failed: ${HS}"
detail "sessionId" "${SESSION_ID}"

# ──────────────────────────────────────────────────────────────────────────────
header 7 "The agent invokes a cap from EACH of the 3 sources — through the primary, like local"
# ──────────────────────────────────────────────────────────────────────────────

# (a) the MAC's OWN cap — apple-calendar (a quintessentially mac-native capability).
MAC_CAP="apple-calendar.calendars.list"
say "(a) mac-own cap:    ${BOLD}${MAC_CAP}${RESET}"
TOK="$(grant_token "${MAC_CAP}")"; [ -n "${TOK}" ] || die "no token for ${MAC_CAP}"
R="$(invoke_cap "${MAC_CAP}" '{}' "${TOK}")"
[ "$(printf '%s' "${R}" | jq -r '.ok')" = "true" ] || die "mac invoke failed: ${R}"
ok "mac executed its OWN cap in-process — ok=true."
detail "output (snippet)" "$(printf '%s' "${R}" | jq -c '.output' | cut -c1-90)"

# (b) PROXY-A's cap — workspace.read, executed CROSS-PROCESS over the wss tunnel.
say "(b) proxy-A cap:    ${BOLD}${ADDR_A}${RESET}   (executes on proxy-A, over wss/enc-ON)"
TOK="$(grant_token "${ADDR_A}")"; [ -n "${TOK}" ] || die "no token for ${ADDR_A}"
R="$(invoke_cap "${ADDR_A}" '{"path":"from-proxy-a.txt"}' "${TOK}")"
[ "$(printf '%s' "${R}" | jq -r '.ok')" = "true" ] || die "proxy-A invoke failed: ${R}"
printf '%s' "${R}" | jq -e '(.output|tostring) | test("PROXY-A")' >/dev/null 2>&1 \
  || note "proxy-A reply did not visibly contain PROXY-A content: $(printf '%s' "${R}" | jq -c '.output')"
ok "Invoke crossed agent → primary → ${BOLD}wss tunnel${RESET} → proxy-A → back — ok=true."
detail "proxy-A file content" "$(printf '%s' "${R}" | jq -r '.output | tostring' | tr -d '\n' | cut -c1-90)"

# (c) PROXY-B's cap — mock.echo.run, executed CROSS-PROCESS over the plain ws tunnel.
say "(c) proxy-B cap:    ${BOLD}${ADDR_B}${RESET}   (executes on proxy-B, over ws/enc-OFF)"
TOK="$(grant_token "${ADDR_B}")"; [ -n "${TOK}" ] || die "no token for ${ADDR_B}"
R="$(invoke_cap "${ADDR_B}" '{"text":"hello-from-the-single-agent"}' "${TOK}")"
[ "$(printf '%s' "${R}" | jq -r '.ok')" = "true" ] || die "proxy-B invoke failed: ${R}"
ok "Invoke crossed agent → primary → ${BOLD}plain ws tunnel${RESET} → proxy-B → back — ok=true."
detail "proxy-B echo output" "$(printf '%s' "${R}" | jq -r '.output | tostring' | tr -d '\n' | cut -c1-90)"

ok "${BOLD}${GREEN}All THREE sources invoked through the ONE primary surface.${RESET}"

# ──────────────────────────────────────────────────────────────────────────────
header 8 "Channel encryption: proxy-A is wss (enc-ON), proxy-B is plain ws (enc-OFF)"
# ──────────────────────────────────────────────────────────────────────────────
note "proxy-A's tunnel: ${BOLD}${GREEN}${UPSTREAM_A}${RESET}  → TLS (channel-encryption ON, self-signed CA trusted per-connection)"
note "proxy-B's tunnel: ${BOLD}${YELLOW}${UPSTREAM_B}${RESET}   → plain ws (channel-encryption OFF)"
say  "Both authenticate identically with Ed25519 (identity ⟂ encryption); wss only adds confidentiality."
grep -Eq "wss\(enc-ON\)"  "${PROXY_A_LOG}" && ok "proxy-A log confirms it dialed wss(enc-ON)."
grep -Eq "ws\(enc-OFF\)"  "${PROXY_B_LOG}" && ok "proxy-B log confirms it dialed ws(enc-OFF)."

# ──────────────────────────────────────────────────────────────────────────────
header 9 "DOWNTIME — kill PROXY-B → its cap goes capability_unavailable; mac + proxy-A persist"
# ──────────────────────────────────────────────────────────────────────────────
say "Killing the proxy-B OS process (PID ${PROXY_B_PID})…"
kill "${PROXY_B_PID}" 2>/dev/null; wait "${PROXY_B_PID}" 2>/dev/null; PROXY_B_PID=""
sleep 0.5
say "Agent invokes proxy-B's now-down cap (bounded by the forward deadline, no hang)…"
TOK_B="$(grant_token "${ADDR_B}")"
START_MS="$(node -e 'console.log(Date.now())')"
DOWN="$(invoke_cap "${ADDR_B}" '{"text":"is-anyone-home"}' "${TOK_B}")"
END_MS="$(node -e 'console.log(Date.now())')"
DOWN_CODE="$(printf '%s' "${DOWN}" | jq -r '.error.code // empty')"
ok "Returned FAST in $((END_MS - START_MS))ms."
detail "proxy-B error.code" "${BOLD}${YELLOW}${DOWN_CODE}${RESET}"
[ "${DOWN_CODE}" = "capability_unavailable" ] \
  && ok "Typed ${BOLD}capability_unavailable${RESET} — degrades gracefully across the process boundary." \
  || note "expected capability_unavailable, got: ${DOWN}"

say "Meanwhile the mac's own cap AND proxy-A still work (independent homes):"
TOK="$(grant_token "${MAC_CAP}")"
[ "$(invoke_cap "${MAC_CAP}" '{}' "${TOK}" | jq -r '.ok')" = "true" ] && ok "mac cap still ok." || die "mac cap unexpectedly down"
TOK="$(grant_token "${ADDR_A}")"
[ "$(invoke_cap "${ADDR_A}" '{"path":"from-proxy-a.txt"}' "${TOK}" | jq -r '.ok')" = "true" ] \
  && ok "proxy-A cap still ok (its wss tunnel is untouched by proxy-B's death)." || die "proxy-A unexpectedly down"

# ──────────────────────────────────────────────────────────────────────────────
header 10 "REVOCATION — \`plexus mesh revoke proxy-a\` → proxy-A's caps vanish from .well-known"
# ──────────────────────────────────────────────────────────────────────────────
BEFORE_A="$(wellknown_ids | grep -c '^local/proxy-a/')"
say "Before revoke, proxy-A caps in /.well-known: ${BEFORE_A}"
say "  plexus mesh revoke proxy-a"
REVOKE="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh revoke proxy-a --url "${PRIMARY_BASE}" --json 2>/dev/null)"
detail "revoke result" "$(printf '%s' "${REVOKE}" | jq -c '{workload, tombstoned, unmounted:(.unmounted|length), purgedGrants}')"
sleep 0.3
AFTER_A="$(wellknown_ids | grep -c '^local/proxy-a/')"
ok "After revoke, proxy-A caps in /.well-known: ${AFTER_A}"
[ "${AFTER_A}" -eq 0 ] || die "proxy-A caps did not vanish after revoke (still ${AFTER_A})"
say "The mac's own caps survive the revoke:"
REMAIN_MAC="$(wellknown_ids | grep -cE '^(workspace|apple-calendar)\.')"
[ "${REMAIN_MAC}" -ge 1 ] && ok "mac still exposes its OWN caps (${REMAIN_MAC}) — revocation is per-workload, terminal." || die "mac caps vanished too"

# ──────────────────────────────────────────────────────────────────────────────
header 11 "Clean up"
# ──────────────────────────────────────────────────────────────────────────────
[ -n "${PROXY_A_PID}" ] && kill "${PROXY_A_PID}" 2>/dev/null; wait "${PROXY_A_PID}" 2>/dev/null; PROXY_A_PID=""
kill "${PRIMARY_PID}" 2>/dev/null; wait "${PRIMARY_PID}" 2>/dev/null; PRIMARY_PID=""
ok "Stopped all three gateway processes; temp homes + workspaces + cert removed on exit."
printf '\n%s%sDEMO COMPLETE — a mac primary + two cross-encryption proxies, aggregated into ONE collection.%s\n\n' "${BOLD}" "${GREEN}" "${RESET}"
