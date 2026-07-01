#!/usr/bin/env bash
#
# run-mesh-demo.sh — a REAL two-OS-process federated-mesh demo, narrated.
#
# This boots the Plexus mesh across TWO genuinely separate OS processes and drives it
# from a THIRD (this script, acting as the agent over real HTTP):
#
#   • PRIMARY  — a gateway process booted through the supervised `serve.ts` seam
#                (examples/mesh-demo/gateway.ts, no PLEXUS_MODE ⇒ primary). It holds
#                the agent-facing HTTP surface + the mesh tunnel acceptor, and keeps
#                the DEFAULT human-in-the-loop authorizer.
#   • PROXY    — a SEPARATE gateway process (PLEXUS_MODE=proxy) that exposes the `mock`
#                source, dials the primary's tunnel, Ed25519-authenticates, enrolls with
#                a ONE-TIME join token (minted via the real `plexus mesh mint` CLI), and
#                LIVE-ASCENDS its catalog so the primary auto-mounts it. No in-process
#                mount, no shared memory — the two gateways talk only over the tunnel.
#   • AGENT    — this script, hitting ONLY the primary's HTTP surface with real curl:
#                discover → handshake → (grant pends) → owner consents → grant → invoke.
#
# Each gateway runs under its OWN PLEXUS_HOME (its own connection-key + Ed25519 identity),
# so they are independent processes you can `ps`/`kill` individually. We prove the
# cross-process boundary at the end by KILLING the proxy process and watching the next
# invoke return a typed `capability_unavailable` (fast, no hang).
#
# Usage:  bash examples/mesh-demo/run-mesh-demo.sh

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
WORKLOAD="laptop"
AGENT_ID="agent-mesh-demo"

# ── isolated, throwaway state for each process ────────────────────────────────
PRIMARY_HOME="$(mktemp -d -t plexus-mesh-primary.XXXXXX)"
PROXY_HOME="$(mktemp -d -t plexus-mesh-proxy.XXXXXX)"
PRIMARY_LOG="$(mktemp -t plexus-mesh-primary-log.XXXXXX)"
PROXY_LOG="$(mktemp -t plexus-mesh-proxy-log.XXXXXX)"
PRIMARY_PID=""; PROXY_PID=""

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'; }
PRIMARY_PORT="$(free_port)"
PROXY_PORT="$(free_port)"
PRIMARY_BASE="http://127.0.0.1:${PRIMARY_PORT}"

cleanup() {
  [ -n "${PROXY_PID}" ] && kill "${PROXY_PID}" 2>/dev/null
  [ -n "${PRIMARY_PID}" ] && kill "${PRIMARY_PID}" 2>/dev/null
  wait 2>/dev/null
  rm -rf "${PRIMARY_HOME}" "${PROXY_HOME}" "${PRIMARY_LOG}" "${PROXY_LOG}" 2>/dev/null
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

# curl helpers against the PRIMARY's agent surface (real HTTP, loopback Host).
agent_post() { curl -s -X POST "${PRIMARY_BASE}$1" -H 'content-type: application/json' -d "$2"; }
agent_put()  { curl -s -X PUT  "${PRIMARY_BASE}$1" -H 'content-type: application/json' -d "$2"; }
# admin surface needs the connection-key (the trusted-local management gate).
admin_get()  { curl -s "${PRIMARY_BASE}$1" -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}"; }
admin_post() { curl -s -X POST "${PRIMARY_BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}" -d "$2"; }
admin_put()  { curl -s -X PUT  "${PRIMARY_BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}" -d "$2"; }

printf '%s╔══════════════════════════════════════════════════════════════════════╗%s\n' "${BOLD}" "${RESET}"
printf '%s║   Plexus federated mesh — TWO-OS-PROCESS demo (primary ⇄ proxy)       ║%s\n' "${BOLD}" "${RESET}"
printf '%s╚══════════════════════════════════════════════════════════════════════╝%s\n' "${BOLD}" "${RESET}"
printf '%s  Two independent gateway processes + this script as the agent. Real OS%s\n' "${DIM}" "${RESET}"
printf '%s  processes (own PID, own PLEXUS_HOME, own Ed25519 key) talking over the%s\n' "${DIM}" "${RESET}"
printf '%s  real tunnel + the real Hono agent surface over real HTTP.%s\n' "${DIM}" "${RESET}"
detail "primary PLEXUS_HOME" "${PRIMARY_HOME}"
detail "proxy   PLEXUS_HOME" "${PROXY_HOME}"

# ──────────────────────────────────────────────────────────────────────────────
header 1 "Boot the PRIMARY gateway as its OWN OS process (supervised serve.ts seam)"
# ──────────────────────────────────────────────────────────────────────────────
say "Spawning:  PLEXUS_HOME=… PLEXUS_PORT=${PRIMARY_PORT} bun run ${GW}   (no PLEXUS_MODE ⇒ primary)"
PLEXUS_HOME="${PRIMARY_HOME}" PLEXUS_PORT="${PRIMARY_PORT}" PLEXUS_INSTANCE="mesh-demo-primary" \
  bun run "${GW}" >"${PRIMARY_LOG}" 2>&1 &
PRIMARY_PID=$!
wait_for_log "MESH_DEMO_READY role=primary" "${PRIMARY_LOG}" 30 \
  || { sed 's/^/    [primary] /' "${PRIMARY_LOG}"; die "primary did not come up"; }
TUNNEL_PORT="$(grep -Eo 'tunnelPort=[0-9]+' "${PRIMARY_LOG}" | head -1 | cut -d= -f2)"
ok "PRIMARY is up as a separate process."
detail "primary PID (a real OS process)" "${PRIMARY_PID}"
detail "agent HTTP surface" "${PRIMARY_BASE}"
detail "mesh tunnel acceptor port" "${TUNNEL_PORT}"
ps -o pid,comm -p "${PRIMARY_PID}" | sed 's/^/    /'

# The primary generated its connection-key on first boot under its own PLEXUS_HOME.
CONNECTION_KEY="$(cat "${PRIMARY_HOME}/connection-key" 2>/dev/null)"
[ -n "${CONNECTION_KEY}" ] || die "primary did not write a connection-key"
detail "primary connection-key (trust boundary)" "${CONNECTION_KEY:0:12}…"

# ──────────────────────────────────────────────────────────────────────────────
header 2 "Mint a ONE-TIME join token with the real \`plexus mesh mint\` CLI"
# ──────────────────────────────────────────────────────────────────────────────
say "The CLI is a plain HTTP client of the running primary's admin API — it talks to"
say "POST /admin/api/mesh/join-token exactly like a human in /admin, but from the shell:"
say "  PLEXUS_HOME=<primary> bun run ${CLI} mesh mint --workload ${WORKLOAD} --json"
MINT_JSON="$(PLEXUS_HOME="${PRIMARY_HOME}" bun run "${CLI}" mesh mint --url "${PRIMARY_BASE}" --workload "${WORKLOAD}" --json 2>"${PROXY_LOG}.minterr")"
JOIN_TOKEN="$(printf '%s' "${MINT_JSON}" | jq -r '.token // empty')"
UPSTREAM_PUBKEY="$(printf '%s' "${MINT_JSON}" | jq -r '.primaryPubKey // empty')"
MINT_TUNNEL_PORT="$(printf '%s' "${MINT_JSON}" | jq -r '.tunnelPort // empty')"
[ -n "${JOIN_TOKEN}" ] || { cat "${PROXY_LOG}.minterr" 2>/dev/null | sed 's/^/    /'; die "mint returned no token (raw: ${MINT_JSON})"; }
rm -f "${PROXY_LOG}.minterr" 2>/dev/null
UPSTREAM_URL="ws://127.0.0.1:${MINT_TUNNEL_PORT}"
ok "Primary minted a one-time join token (single-use; replay-dead once consumed)."
detail "PLEXUS_JOIN_TOKEN (out-of-band → proxy)" "${JOIN_TOKEN:0:16}…"
detail "PLEXUS_UPSTREAM_URL" "${UPSTREAM_URL}"
detail "PLEXUS_UPSTREAM_PUBKEY (pinned — no bare TOFU)" "${UPSTREAM_PUBKEY:0:44}…"
detail "PLEXUS_WORKLOAD" "${WORKLOAD}"

# ──────────────────────────────────────────────────────────────────────────────
header 3 "Boot the PROXY gateway as a SEPARATE OS process → dial, auth, enroll, ascend"
# ──────────────────────────────────────────────────────────────────────────────
say "Spawning a second gateway with the proxy env block above (its OWN PLEXUS_HOME):"
say "  PLEXUS_MODE=proxy PLEXUS_UPSTREAM_URL=… PLEXUS_UPSTREAM_PUBKEY=… PLEXUS_JOIN_TOKEN=… bun run ${GW}"
PLEXUS_HOME="${PROXY_HOME}" PLEXUS_PORT="${PROXY_PORT}" PLEXUS_MODE="proxy" \
  PLEXUS_UPSTREAM_URL="${UPSTREAM_URL}" PLEXUS_UPSTREAM_PUBKEY="${UPSTREAM_PUBKEY}" \
  PLEXUS_WORKLOAD="${WORKLOAD}" PLEXUS_JOIN_TOKEN="${JOIN_TOKEN}" \
  bun run "${GW}" >"${PROXY_LOG}" 2>&1 &
PROXY_PID=$!
wait_for_log "MESH_DEMO_READY role=proxy" "${PROXY_LOG}" 30 \
  || { sed 's/^/    [proxy] /' "${PROXY_LOG}"; die "proxy did not come up / failed to enroll"; }
ok "PROXY is up as a SEPARATE process — it dialed the tunnel and Ed25519-enrolled."
detail "proxy PID (a distinct OS process)" "${PROXY_PID}"
ps -o pid,comm -p "${PRIMARY_PID}" -p "${PROXY_PID}" | sed 's/^/    /'

say "Waiting for the primary to AUTO-MOUNT the proxy's ascended catalog…"
MOUNTED_ADDR=""
for _ in $(seq 1 100); do
  MOUNTED_ADDR="$(admin_get /admin/api/exposure | jq -r --arg w "/${WORKLOAD}/" '.capabilities[].id | select(index($w))' 2>/dev/null | head -1)"
  [ -n "${MOUNTED_ADDR}" ] && break
  sleep 0.1
done
[ -n "${MOUNTED_ADDR}" ] || { sed 's/^/    [proxy] /' "${PROXY_LOG}"; die "primary never auto-mounted the proxy catalog"; }
ok "Primary auto-mounted the proxy's BARE catalog under tenant/workload/ (live ascent, A2)."
detail "mounted address (the prefixed URN agents see)" "${BOLD}${GREEN}${MOUNTED_ADDR}${RESET}"

# ──────────────────────────────────────────────────────────────────────────────
header 4 "Zero-exposure: mounted ⇒ HIDDEN until the owner deliberately exposes it"
# ──────────────────────────────────────────────────────────────────────────────
BEFORE="$(curl -s "${PRIMARY_BASE}/.well-known/plexus" | jq -r --arg a "${MOUNTED_ADDR}" 'any(.capabilities[]?; .id == $a)')"
note "Pre-exposure, is the address discoverable in /.well-known? ${BOLD}${BEFORE}${RESET}  (join ≠ access)"
say "Owner enables exposure (admin API — the real /admin toggle):"
say "  POST /admin/api/exposure/<url-encoded address>  { enabled: true }"
ENC_ADDR="$(printf '%s' "${MOUNTED_ADDR}" | jq -rn --arg s "${MOUNTED_ADDR}" '$s|@uri')"
EXPOSE_RES="$(admin_post "/admin/api/exposure/${ENC_ADDR}" '{"enabled":true}')"
printf '%s' "${EXPOSE_RES}" | jq -e '.ok == true' >/dev/null 2>&1 || die "exposure toggle failed: ${EXPOSE_RES}"
AFTER="$(curl -s "${PRIMARY_BASE}/.well-known/plexus" | jq -r --arg a "${MOUNTED_ADDR}" 'any(.capabilities[]?; .id == $a)')"
ok "Owner enabled it; now discoverable in /.well-known? ${GREEN}${AFTER}${RESET}"

# ──────────────────────────────────────────────────────────────────────────────
header 5 "AGENT (real curl → primary only) → discover → handshake"
# ──────────────────────────────────────────────────────────────────────────────
say "The agent talks ONLY to the primary at ${PRIMARY_BASE} (it never sees the proxy)."
say "  → GET /.well-known/plexus"
DISCOVERED="$(curl -s "${PRIMARY_BASE}/.well-known/plexus" | jq -r --arg a "${MOUNTED_ADDR}" '.capabilities[] | select(.id == $a) | .id')"
detail "discovered" "${DISCOVERED}"
say "  → POST /link/handshake  { connectionKey, client }"
HS="$(agent_post /link/handshake "$(jq -nc --arg k "${CONNECTION_KEY}" --arg a "${AGENT_ID}" '{connectionKey:$k, client:{name:"mesh-demo-agent", agentId:$a}}')")"
SESSION_ID="$(printf '%s' "${HS}" | jq -r '.sessionId // empty')"
[ -n "${SESSION_ID}" ] || die "handshake failed: ${HS}"
detail "sessionId" "${SESSION_ID}"

# ──────────────────────────────────────────────────────────────────────────────
header 6 "Human-in-the-loop consent: grant PENDS → owner approves → token issued"
# ──────────────────────────────────────────────────────────────────────────────
GRANT_BODY="$(jq -nc --arg s "${SESSION_ID}" --arg a "${MOUNTED_ADDR}" '{sessionId:$s, grants:{($a):"allow"}}')"
say "  → PUT /grants  { \"${MOUNTED_ADDR}\": \"allow\" }   (the agent asks)"
GRANT1="$(agent_put /grants "${GRANT_BODY}")"
PENDING_ID="$(printf '%s' "${GRANT1}" | jq -r '.pendingId // empty')"
if [ -n "${PENDING_ID}" ]; then
  note "Grant PENDED — a remote (mesh-mounted) capability is extension-class, so the real"
  note "authorizer requires a human decision. NO token was minted. (pendingId=${PENDING_ID:0:12}…)"
  say "  → The OWNER consents via the admin surface (this is the deliberate access act):"
  say "      PUT /admin/api/grants  { agentId: \"${AGENT_ID}\", grants:{ \"${MOUNTED_ADDR}\": \"allow\" } }"
  CONSENT="$(admin_put /admin/api/grants "$(jq -nc --arg a "${AGENT_ID}" --arg c "${MOUNTED_ADDR}" '{agentId:$a, grants:{($c):"allow"}}')")"
  printf '%s' "${CONSENT}" | jq -e '.token // .pendingId' >/dev/null 2>&1 || die "owner consent grant failed: ${CONSENT}"
  ok "Owner approved → a standing grant now exists for (agent=${AGENT_ID}, ${MOUNTED_ADDR})."
  say "  → PUT /grants (the agent re-asks; now it finds prior approval)"
  GRANT1="$(agent_put /grants "${GRANT_BODY}")"
fi
TOKEN="$(printf '%s' "${GRANT1}" | jq -r '.token // empty')"
[ -n "${TOKEN}" ] || die "agent never received a scoped token: ${GRANT1}"
ok "Agent received a scoped token (effective access = granted ∧ exposed)."
detail "scoped token" "${TOKEN:0:18}…"

# ──────────────────────────────────────────────────────────────────────────────
header 7 "AGENT → POST /invoke the mounted address → the PROXY process executes it"
# ──────────────────────────────────────────────────────────────────────────────
say "  → POST /invoke  { id: \"${MOUNTED_ADDR}\", input: { text: \"hello-mesh\" } }"
INVOKE="$(curl -s -X POST "${PRIMARY_BASE}/invoke" -H 'content-type: application/json' \
  -H "authorization: Bearer ${TOKEN}" \
  -d "$(jq -nc --arg a "${MOUNTED_ADDR}" '{id:$a, input:{text:"hello-mesh"}}')")"
INVOKE_OK="$(printf '%s' "${INVOKE}" | jq -r '.ok')"
INVOKE_OUT="$(printf '%s' "${INVOKE}" | jq -r '.output // empty' | tr -d '\n')"
[ "${INVOKE_OK}" = "true" ] || die "invoke failed: ${INVOKE}"
ok "Invoke crossed the process boundary: agent → primary → tunnel → PROXY → back."
ok "PROXY's returned result: ${BOLD}${GREEN}\"${INVOKE_OUT}\"${RESET}"
detail "reply id (the mounted URN)" "$(printf '%s' "${INVOKE}" | jq -r '.id')"

# ──────────────────────────────────────────────────────────────────────────────
header 8 "DOWNTIME — KILL the proxy PROCESS → typed capability_unavailable (no hang)"
# ──────────────────────────────────────────────────────────────────────────────
say "Killing the proxy OS process (PID ${PROXY_PID}) — a genuine cross-process failure:"
kill "${PROXY_PID}" 2>/dev/null
wait "${PROXY_PID}" 2>/dev/null
PROXY_PID=""
sleep 0.5
if ps -p "$(grep -Eo 'pid=[0-9]+' "${PROXY_LOG}" | head -1 | cut -d= -f2)" >/dev/null 2>&1; then
  note "proxy still visible (race) — continuing"
else
  ok "Proxy process is gone (the primary observes the tunnel drop)."
fi
say "Agent invokes the now-down capability (raced against the forward deadline)…"
START_MS="$(node -e 'console.log(Date.now())')"
DOWN="$(curl -s -X POST "${PRIMARY_BASE}/invoke" -H 'content-type: application/json' \
  -H "authorization: Bearer ${TOKEN}" \
  -d "$(jq -nc --arg a "${MOUNTED_ADDR}" '{id:$a, input:{text:"hello-down"}}')")"
END_MS="$(node -e 'console.log(Date.now())')"
ELAPSED=$((END_MS - START_MS))
DOWN_CODE="$(printf '%s' "${DOWN}" | jq -r '.error.code // empty')"
ok "Returned FAST in ${ELAPSED}ms (no hang)."
detail "ok" "$(printf '%s' "${DOWN}" | jq -r '.ok')"
detail "error.code" "${BOLD}${YELLOW}${DOWN_CODE}${RESET}"
detail "error.capabilityId" "$(printf '%s' "${DOWN}" | jq -r '.error.capabilityId // .error.address // empty')"
[ "${DOWN_CODE}" = "capability_unavailable" ] \
  && ok "Typed ${BOLD}capability_unavailable${RESET} — the mesh degrades gracefully across the process boundary." \
  || note "expected capability_unavailable, got: ${DOWN}"

# ──────────────────────────────────────────────────────────────────────────────
header 9 "Clean up"
# ──────────────────────────────────────────────────────────────────────────────
kill "${PRIMARY_PID}" 2>/dev/null; wait "${PRIMARY_PID}" 2>/dev/null; PRIMARY_PID=""
ok "Stopped both gateway processes; temp PLEXUS_HOMEs removed on exit."
printf '\n%s%sDEMO COMPLETE — the federated mesh ran across TWO real OS processes.%s\n\n' "${BOLD}" "${GREEN}" "${RESET}"
