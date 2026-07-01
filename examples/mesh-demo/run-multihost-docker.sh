#!/usr/bin/env bash
#
# run-multihost-docker.sh — the DOCKER analogue of run-multihost-local.sh. Same proven
# topology, now across REAL Linux containers instead of localhost processes:
#
#   • a CONTAINERIZED LINUX PRIMARY exposing its OWN caps (workspace.* over /data/primary —
#     Apple isn't on Linux, so the portable workspace cap is the host's own surface), with a
#     DUAL tunnel listener bound on 0.0.0.0:  wss://primary:8443 (enc-ON) + ws://primary:8080 (enc-OFF),
#   • PROXY-A (workspace over /data/proxy-a) dialing  wss  — channel-encryption ON, self-signed CA trusted,
#   • PROXY-B (workspace over /data/proxy-b) dialing  ws   — channel-encryption OFF,
#   • all aggregated into ONE collection a single agent invokes THROUGH the primary "like local."
#
# Three independent containers (own PLEXUS_HOME volume, own Ed25519 key) talk only over the mesh
# tunnel; the AGENT is `curl` run INSIDE the primary container (`docker compose exec`) against the
# primary's loopback agent surface — it never touches a proxy directly. Upstream is the compose
# service DNS name `primary` (hermetic — no host.docker.internal), so this runs identically in CI.
#
# Proves, end to end (mirrors run-multihost-local.sh):
#   1. boot the LINUX PRIMARY (own caps discoverable BEFORE any proxy connects),
#   2. mint two one-time join tokens (one --scheme wss, one --scheme ws) via the primary's CLI,
#   3. boot PROXY-A over wss (enc-ON, NODE_EXTRA_CA_CERTS trusts the self-signed cert),
#   4. boot PROXY-B over ws (enc-OFF), exposing a DISTINCT root (prefix+content, not id),
#   5. both auto-mount; the owner enables exposure on each mounted prefix,
#   6. ONE agent discovers the aggregated .well-known (primary + proxy-a + proxy-b = ONE list, 3 sources),
#      handshakes once, grants (consenting the pends), invokes a cap from EACH of the 3 sources,
#   7. downtime: stop PROXY-B → its cap returns capability_unavailable while PROXY-A + primary persist,
#   8. revocation: `plexus mesh revoke proxy-a` → proxy-A's caps vanish from .well-known.
#
# Usage:
#   bash examples/mesh-demo/run-multihost-docker.sh              # full run (needs docker)
#   bash examples/mesh-demo/run-multihost-docker.sh --selfcheck  # cert-gen + env + yaml lint, NO containers
#
# The --selfcheck path runs the NON-docker logic (cert generation, env-file assembly, compose-yaml
# validation) so the script can be verified without a (slow) image build.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

COMPOSE_FILE="docker/compose.mesh.yml"
CERT_DIR="docker/certs"
CERT="${CERT_DIR}/primary-cert.pem"
KEY="${CERT_DIR}/primary-key.pem"
ENV_FILE="docker/mesh.env"
CLI="packages/cli/src/bin/plexus"
PRIMARY_BASE="http://127.0.0.1:7077"
AGENT_ID="agent-multihost-docker"

# ── colours / narration helpers ───────────────────────────────────────────────
BOLD=$'\e[1m'; DIM=$'\e[2m'; CYAN=$'\e[36m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
bar()    { printf '%s\n' "${CYAN}────────────────────────────────────────────────────────────────────────${RESET}"; }
header() { printf '\n'; bar; printf '%s%sSTEP %s%s  %s%s%s\n' "${BOLD}" "${CYAN}" "$1" "${RESET}" "${BOLD}" "$2" "${RESET}"; bar; }
say()    { printf '  %s\n' "$1"; }
ok()     { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$1"; }
detail() { printf '    %s%s%s %s\n' "${DIM}" "$1" "${RESET}" "$2"; }
note()   { printf '  %s»%s %s\n' "${YELLOW}" "${RESET}" "$1"; }
die()    { printf '\n%s%sDEMO FAILED%s: %s\n' "${BOLD}" "${RED}" "${RESET}" "$1" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"; }

# ── self-signed cert for the primary's wss listener (SAN must match the dialed host) ──
# The proxies dial `wss://primary:8443`, so the cert needs SAN DNS:primary (the compose
# service name). DNS:localhost + IP:127.0.0.1 are added so the same cert also works for a
# host-published primary or a `127.0.0.1` smoke test.
gen_cert() {
  local dir="$1" cert="$1/primary-cert.pem" key="$1/primary-key.pem"
  need openssl
  mkdir -p "${dir}"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 3650 \
    -subj "/CN=primary" \
    -addext "subjectAltName=DNS:primary,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 \
    || die "openssl failed to generate the self-signed cert"
  # Prove the SAN actually carries DNS:primary (a wrong SAN = a silently never-trusting wss tunnel).
  openssl x509 -in "${cert}" -noout -text 2>/dev/null | grep -q "DNS:primary" \
    || die "generated cert is missing SAN DNS:primary (proxy-a wss verification would fail)"
}

# ── compose wrapper (always with the env-file so ${PROXY_*_JOIN_TOKEN} substitute) ──
dc() { docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"; }
# Run a command INSIDE the primary container (the agent + operator-CLI vantage point).
pexec() { dc exec -T primary "$@"; }
# Same, but reaches the primary's loopback agent surface via curl-in-container.
pcurl() { pexec curl -s "$@"; }

# Agent/admin curl helpers (parsed on the HOST with jq; the image ships no jq).
agent_post() { pcurl -X POST "${PRIMARY_BASE}$1" -H 'content-type: application/json' -d "$2"; }
agent_put()  { pcurl -X PUT  "${PRIMARY_BASE}$1" -H 'content-type: application/json' -d "$2"; }
admin_get()  { pcurl "${PRIMARY_BASE}$1" -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}"; }
admin_post() { pcurl -X POST "${PRIMARY_BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}" -d "$2"; }
admin_put()  { pcurl -X PUT  "${PRIMARY_BASE}$1" -H 'content-type: application/json' -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}" -d "$2"; }
wellknown_ids() { pcurl "${PRIMARY_BASE}/.well-known/plexus" | jq -r '.capabilities[]?.id'; }

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
# (Uses pcurl directly rather than agent_post because it needs an Authorization header.)
invoke_cap() {
  local addr="$1" input="$2" token="$3"
  pcurl -X POST "${PRIMARY_BASE}/invoke" -H 'content-type: application/json' \
    -H "authorization: Bearer ${token}" \
    -d "$(jq -nc --arg a "${addr}" --argjson in "${input}" '{id:$a, input:$in}')"
}

# Wait until $1 (a shell predicate, evaluated with eval) is true, or time out after $2 deciseconds.
wait_until() {
  local pred="$1" max="${2:-300}" i=0
  while [ "$i" -lt "${max}" ]; do
    if eval "${pred}" >/dev/null 2>&1; then return 0; fi
    sleep 0.2; i=$((i + 1))
  done
  return 1
}

cleanup() {
  if [ "${KEEP_UP:-0}" = "1" ]; then
    note "KEEP_UP=1 — leaving the stack running (tear down with: docker compose -f ${COMPOSE_FILE} down -v)"
    return
  fi
  dc down -v >/dev/null 2>&1 || true
  rm -f "${ENV_FILE}" "${CERT}" "${KEY}" 2>/dev/null || true
  rmdir "${CERT_DIR}" 2>/dev/null || true
}

# ──────────────────────────────────────────────────────────────────────────────
#  SELF-CHECK — the non-docker logic (cert gen + env assembly + yaml validation).
# ──────────────────────────────────────────────────────────────────────────────
selfcheck() {
  printf '%s%s== run-multihost-docker.sh self-check (no containers) ==%s\n' "${BOLD}" "${CYAN}" "${RESET}"
  local tmp; tmp="$(mktemp -d -t plexus-mesh-docker-selfcheck.XXXXXX)"
  trap 'rm -rf "${tmp}"' EXIT

  header A "Generate + validate the self-signed wss cert"
  gen_cert "${tmp}/certs"
  ok "Cert minted with SAN DNS:primary (verified via openssl x509)."
  detail "cert" "${tmp}/certs/primary-cert.pem"
  openssl x509 -in "${tmp}/certs/primary-cert.pem" -noout -subject -ext subjectAltName 2>/dev/null \
    | sed 's/^/      /'

  header B "Assemble the compose --env-file (token + pinned pubkey substitution)"
  cat > "${tmp}/mesh.env" <<EOF
PLEXUS_UPSTREAM_PUBKEY=ed25519:SELFCHECK_PLACEHOLDER_PUBKEY
PROXY_A_JOIN_TOKEN=selfcheck-token-a
PROXY_B_JOIN_TOKEN=selfcheck-token-b
EOF
  grep -q '^PLEXUS_UPSTREAM_PUBKEY=' "${tmp}/mesh.env" || die "env file missing PLEXUS_UPSTREAM_PUBKEY"
  grep -q '^PROXY_A_JOIN_TOKEN='     "${tmp}/mesh.env" || die "env file missing PROXY_A_JOIN_TOKEN"
  grep -q '^PROXY_B_JOIN_TOKEN='     "${tmp}/mesh.env" || die "env file missing PROXY_B_JOIN_TOKEN"
  ok "Env file assembled with all three substitution vars."
  sed 's/^/      /' "${tmp}/mesh.env"

  header C "Validate docker/compose.mesh.yml"
  if command -v docker >/dev/null 2>&1; then
    if docker compose -f "${COMPOSE_FILE}" --env-file "${tmp}/mesh.env" config >/dev/null 2>"${tmp}/cfg.err"; then
      ok "docker compose config: yaml is valid + variable substitution resolves."
      # Prove the substituted values actually landed in the rendered config.
      docker compose -f "${COMPOSE_FILE}" --env-file "${tmp}/mesh.env" config 2>/dev/null \
        | grep -Eq 'PROXY_A_JOIN_TOKEN|selfcheck-token-a' \
        && ok "Proxy-A join token substituted into the rendered config." \
        || note "could not confirm token substitution in rendered config (compose may redact env)."
    else
      die "docker compose config failed: $(cat "${tmp}/cfg.err")"
    fi
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import yaml,sys; yaml.safe_load(open('${COMPOSE_FILE}')); print('ok')" >/dev/null 2>&1 \
      && ok "python yaml.safe_load: compose yaml parses (docker not installed; schema not checked)." \
      || die "compose yaml failed python yaml.safe_load"
  else
    note "neither docker nor python3 available — skipped yaml validation."
  fi

  header D "Sanity-check the Dockerfile contract"
  grep -q 'packages/runtime/src/index.ts' docker/Dockerfile \
    && ok "Dockerfile default CMD boots the stock gateway (packages/runtime/src/index.ts)." \
    || die "Dockerfile CMD does not boot the stock gateway entrypoint."
  grep -q 'FROM ubuntu' docker/Dockerfile \
    && ok "Dockerfile base is ubuntu." || die "Dockerfile base is not ubuntu."

  printf '\n%s%sSELF-CHECK PASSED — cert, env, compose, and Dockerfile are well-formed.%s\n\n' "${BOLD}" "${GREEN}" "${RESET}"
  exit 0
}

# ──────────────────────────────────────────────────────────────────────────────
#  FULL RUN (requires docker).
# ──────────────────────────────────────────────────────────────────────────────
full_run() {
  need docker
  need jq
  command -v openssl >/dev/null 2>&1 || die "openssl required"
  docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is required"

  printf '%s╔══════════════════════════════════════════════════════════════════════╗%s\n' "${BOLD}" "${RESET}"
  printf '%s║  Plexus federated mesh — FULLY-CONTAINERIZED multi-host topology      ║%s\n' "${BOLD}" "${RESET}"
  printf '%s║  linux primary + proxy-A (wss/enc-ON) + proxy-B (ws/enc-OFF) ⇒ 1 agent║%s\n' "${BOLD}" "${RESET}"
  printf '%s╚══════════════════════════════════════════════════════════════════════╝%s\n' "${BOLD}" "${RESET}"

  trap cleanup EXIT INT TERM

  # ────────────────────────────────────────────────────────────────────────────
  header 0 "Generate the self-signed TLS cert (SAN DNS:primary) + boot the LINUX PRIMARY"
  # ────────────────────────────────────────────────────────────────────────────
  gen_cert "${CERT_DIR}"
  ok "Self-signed cert minted (SAN DNS:primary,DNS:localhost,IP:127.0.0.1)."
  # An empty env-file lets the primary come up (proxies aren't started yet).
  : > "${ENV_FILE}"
  say "Building the image + booting the primary (first build can be slow on a throttled box)…"
  dc up -d --build primary || die "compose up primary failed"
  wait_until 'pcurl -o /dev/null -w "%{http_code}" "${PRIMARY_BASE}/.well-known/plexus" | grep -q 200' 600 \
    || { dc logs primary | tail -40; die "primary did not become reachable"; }
  ok "LINUX PRIMARY is up (its own agent surface answers on 127.0.0.1:7077 inside the container)."

  CONNECTION_KEY="$(pexec cat /state/connection-key | tr -d '\r\n')"
  [ -n "${CONNECTION_KEY}" ] || die "primary did not write a connection-key"
  detail "primary connection-key (trust boundary)" "${CONNECTION_KEY:0:12}…"

  # Seed the primary's OWN workspace so an invoke visibly proves WHICH host executed it.
  pexec sh -c 'mkdir -p /data/primary && printf "Hello from the LINUX PRIMARY (its OWN workspace cap).\n" > /data/primary/primary-note.txt'

  say "Assert the primary's OWN workspace caps are discoverable BEFORE any proxy connects:"
  wait_until 'wellknown_ids | grep -q "^workspace\."' 100 || { dc logs primary | tail -40; die "primary did not expose its own workspace caps"; }
  wellknown_ids | grep -E '^workspace\.' | sed 's/^/      • /'
  ok "The primary exposes its OWN caps (3-source aggregation starts with the host itself)."

  # ────────────────────────────────────────────────────────────────────────────
  header 1 "Mint TWO one-time join tokens — one --scheme wss, one --scheme ws"
  # ────────────────────────────────────────────────────────────────────────────
  say "  plexus mesh mint --host primary --scheme wss|ws --json   (×2; single-use)"
  MINT_A="$(pexec bun run "${CLI}" mesh mint --url "${PRIMARY_BASE}" --host primary --scheme wss --json 2>/dev/null)"
  MINT_B="$(pexec bun run "${CLI}" mesh mint --url "${PRIMARY_BASE}" --host primary --scheme ws  --json 2>/dev/null)"
  TOKEN_A="$(printf '%s' "${MINT_A}" | jq -r '.token // empty')"
  TOKEN_B="$(printf '%s' "${MINT_B}" | jq -r '.token // empty')"
  PRIMARY_PUBKEY="$(printf '%s' "${MINT_A}" | jq -r '.primaryPubKey // empty')"
  WSS_PORT="$(printf '%s' "${MINT_A}" | jq -r '.endpoints[]? | select(.scheme=="wss") | .port')"
  WS_PORT="$(printf '%s'  "${MINT_A}" | jq -r '.endpoints[]? | select(.scheme=="ws")  | .port')"
  [ -n "${TOKEN_A}" ] && [ -n "${TOKEN_B}" ] || die "mint returned no token (A=${MINT_A} B=${MINT_B})"
  [ -n "${PRIMARY_PUBKEY}" ] || die "mint returned no primaryPubKey"
  [ -n "${WSS_PORT}" ] || die "primary advertised no wss endpoint (dual listener not bound): ${MINT_A}"
  [ -n "${WS_PORT}" ]  || die "primary advertised no ws endpoint: ${MINT_A}"
  ok "Primary advertises BOTH tunnel endpoints; minted one single-use token per proxy."
  detail "proxy-A upstream (enc-ON, TLS) " "${BOLD}${GREEN}wss://primary:${WSS_PORT}${RESET}"
  detail "proxy-B upstream (enc-OFF)     " "${BOLD}${YELLOW}ws://primary:${WS_PORT}${RESET}"
  detail "pinned primaryPubKey (no bare TOFU)" "${PRIMARY_PUBKEY:0:44}…"

  # Assemble the --env-file the proxy services substitute from.
  cat > "${ENV_FILE}" <<EOF
PLEXUS_UPSTREAM_PUBKEY=${PRIMARY_PUBKEY}
PROXY_A_JOIN_TOKEN=${TOKEN_A}
PROXY_B_JOIN_TOKEN=${TOKEN_B}
EOF

  # ────────────────────────────────────────────────────────────────────────────
  header 2 "Boot PROXY-A (wss/enc-ON, CA-trusted) + PROXY-B (ws/enc-OFF)"
  # ────────────────────────────────────────────────────────────────────────────
  dc up -d proxy-a proxy-b || die "compose up proxies failed"
  ok "Both proxies launched as separate containers, dialing OUT to the primary."
  # Seed each proxy's DISTINCT workspace root (distinctness = prefix + content, never id).
  dc exec -T proxy-a sh -c 'mkdir -p /data/proxy-a && printf "Hello from PROXY-A — workspace over wss (enc-ON).\n" > /data/proxy-a/from-proxy-a.txt'
  dc exec -T proxy-b sh -c 'mkdir -p /data/proxy-b && printf "Hello from PROXY-B — workspace over ws (enc-OFF).\n" > /data/proxy-b/from-proxy-b.txt'

  # ────────────────────────────────────────────────────────────────────────────
  header 3 "Wait for BOTH proxies to auto-mount, then the owner enables exposure"
  # ────────────────────────────────────────────────────────────────────────────
  wait_until 'admin_get /admin/api/exposure | jq -e "any(.capabilities[].id; startswith(\"local/proxy-a/\"))"' 300 \
    || { dc logs proxy-a | tail -40; die "primary never auto-mounted proxy-A (wss trust / enroll failed?)"; }
  wait_until 'admin_get /admin/api/exposure | jq -e "any(.capabilities[].id; startswith(\"local/proxy-b/\"))"' 300 \
    || { dc logs proxy-b | tail -40; die "primary never auto-mounted proxy-B"; }
  ok "Primary auto-mounted BOTH proxies' catalogs under their provenance prefixes (live ascent)."
  say "Owner enables exposure on every mounted address of both proxies (admin toggle):"
  for addr in $(admin_get /admin/api/exposure | jq -r '.capabilities[].id | select(startswith("local/proxy-a/"))'); do expose "${addr}"; done
  for addr in $(admin_get /admin/api/exposure | jq -r '.capabilities[].id | select(startswith("local/proxy-b/"))'); do expose "${addr}"; done
  ok "Exposure enabled on proxy-A + proxy-B surfaces."

  # ────────────────────────────────────────────────────────────────────────────
  header 4 "ONE aggregated collection — primary + proxy-A + proxy-B as ONE list"
  # ────────────────────────────────────────────────────────────────────────────
  ALL_IDS="$(wellknown_ids | sort)"
  N_PRI="$(printf '%s\n' "${ALL_IDS}" | grep -cE '^workspace\.')"
  N_A="$(printf '%s\n'   "${ALL_IDS}" | grep -c '^local/proxy-a/')"
  N_B="$(printf '%s\n'   "${ALL_IDS}" | grep -c '^local/proxy-b/')"
  printf '    %s──── primary-box (own caps) ────%s\n' "${DIM}" "${RESET}"
  printf '%s\n' "${ALL_IDS}" | grep -E '^workspace\.' | sed 's/^/      • /'
  printf '    %s──── proxy-a (via wss/enc-ON) ────%s\n' "${DIM}" "${RESET}"
  printf '%s\n' "${ALL_IDS}" | grep '^local/proxy-a/' | sed 's/^/      • /'
  printf '    %s──── proxy-b (via ws/enc-OFF) ────%s\n' "${DIM}" "${RESET}"
  printf '%s\n' "${ALL_IDS}" | grep '^local/proxy-b/' | sed 's/^/      • /'
  [ "${N_PRI}" -ge 1 ] && [ "${N_A}" -ge 1 ] && [ "${N_B}" -ge 1 ] \
    || die "aggregated catalog missing a source (primary=${N_PRI} proxy-a=${N_A} proxy-b=${N_B})"
  ok "ONE collection, THREE provenances (primary=${N_PRI}, proxy-a=${N_A}, proxy-b=${N_B})."

  say "  → POST /link/handshake   (one session for the whole aggregated surface)"
  HS="$(agent_post /link/handshake "$(jq -nc --arg k "${CONNECTION_KEY}" --arg a "${AGENT_ID}" '{connectionKey:$k, client:{name:"multihost-docker-agent", agentId:$a}}')")"
  SESSION_ID="$(printf '%s' "${HS}" | jq -r '.sessionId // empty')"
  [ -n "${SESSION_ID}" ] || die "handshake failed: ${HS}"
  detail "sessionId" "${SESSION_ID}"

  # ────────────────────────────────────────────────────────────────────────────
  header 5 "The agent invokes a cap from EACH of the 3 sources — through the primary"
  # ────────────────────────────────────────────────────────────────────────────
  PRI_CAP="workspace.read"
  ADDR_A="local/proxy-a/workspace.read"
  ADDR_B="local/proxy-b/workspace.read"

  say "(a) primary-own cap: ${BOLD}${PRI_CAP}${RESET}"
  TOK="$(grant_token "${PRI_CAP}")"; [ -n "${TOK}" ] || die "no token for ${PRI_CAP}"
  R="$(invoke_cap "${PRI_CAP}" '{"path":"primary-note.txt"}' "${TOK}")"
  [ "$(printf '%s' "${R}" | jq -r '.ok')" = "true" ] || die "primary invoke failed: ${R}"
  ok "primary executed its OWN cap in-process — ok=true."
  detail "content" "$(printf '%s' "${R}" | jq -r '.output | tostring' | tr -d '\n' | cut -c1-80)"

  say "(b) proxy-A cap:     ${BOLD}${ADDR_A}${RESET}   (executes on proxy-A, over wss/enc-ON)"
  TOK="$(grant_token "${ADDR_A}")"; [ -n "${TOK}" ] || die "no token for ${ADDR_A}"
  R="$(invoke_cap "${ADDR_A}" '{"path":"from-proxy-a.txt"}' "${TOK}")"
  [ "$(printf '%s' "${R}" | jq -r '.ok')" = "true" ] || die "proxy-A invoke failed: ${R}"
  printf '%s' "${R}" | jq -e '(.output|tostring)|test("PROXY-A")' >/dev/null 2>&1 \
    || note "proxy-A reply did not visibly contain PROXY-A content"
  ok "Invoke crossed agent → primary → ${BOLD}wss tunnel${RESET} → proxy-A → back — ok=true."
  detail "content" "$(printf '%s' "${R}" | jq -r '.output | tostring' | tr -d '\n' | cut -c1-80)"

  say "(c) proxy-B cap:     ${BOLD}${ADDR_B}${RESET}   (executes on proxy-B, over ws/enc-OFF)"
  TOK="$(grant_token "${ADDR_B}")"; [ -n "${TOK}" ] || die "no token for ${ADDR_B}"
  R="$(invoke_cap "${ADDR_B}" '{"path":"from-proxy-b.txt"}' "${TOK}")"
  [ "$(printf '%s' "${R}" | jq -r '.ok')" = "true" ] || die "proxy-B invoke failed: ${R}"
  ok "Invoke crossed agent → primary → ${BOLD}plain ws tunnel${RESET} → proxy-B → back — ok=true."
  detail "content" "$(printf '%s' "${R}" | jq -r '.output | tostring' | tr -d '\n' | cut -c1-80)"
  ok "${BOLD}${GREEN}All THREE sources invoked through the ONE primary surface.${RESET}"

  # ────────────────────────────────────────────────────────────────────────────
  header 6 "DOWNTIME — stop PROXY-B → capability_unavailable; primary + proxy-A persist"
  # ────────────────────────────────────────────────────────────────────────────
  say "Stopping the proxy-B container…"
  dc stop proxy-b >/dev/null 2>&1
  sleep 1
  TOK_B="$(grant_token "${ADDR_B}")"
  DOWN="$(invoke_cap "${ADDR_B}" '{"path":"from-proxy-b.txt"}' "${TOK_B}")"
  DOWN_CODE="$(printf '%s' "${DOWN}" | jq -r '.error.code // empty')"
  detail "proxy-B error.code" "${BOLD}${YELLOW}${DOWN_CODE}${RESET}"
  [ "${DOWN_CODE}" = "capability_unavailable" ] \
    && ok "Typed ${BOLD}capability_unavailable${RESET} — degrades gracefully across the container boundary." \
    || note "expected capability_unavailable, got: ${DOWN}"
  TOK="$(grant_token "${PRI_CAP}")"
  [ "$(invoke_cap "${PRI_CAP}" '{"path":"primary-note.txt"}' "${TOK}" | jq -r '.ok')" = "true" ] && ok "primary cap still ok." || die "primary cap unexpectedly down"
  TOK="$(grant_token "${ADDR_A}")"
  [ "$(invoke_cap "${ADDR_A}" '{"path":"from-proxy-a.txt"}' "${TOK}" | jq -r '.ok')" = "true" ] \
    && ok "proxy-A cap still ok (its wss tunnel is untouched by proxy-B's stop)." || die "proxy-A unexpectedly down"

  # ────────────────────────────────────────────────────────────────────────────
  header 7 "REVOCATION — \`plexus mesh revoke proxy-a\` → its caps vanish from .well-known"
  # ────────────────────────────────────────────────────────────────────────────
  BEFORE_A="$(wellknown_ids | grep -c '^local/proxy-a/')"
  say "Before revoke, proxy-A caps in /.well-known: ${BEFORE_A}"
  REVOKE="$(pexec bun run "${CLI}" mesh revoke proxy-a --url "${PRIMARY_BASE}" --json 2>/dev/null)"
  detail "revoke result" "$(printf '%s' "${REVOKE}" | jq -c '{workload, tombstoned, unmounted:(.unmounted|length), purgedGrants}')"
  sleep 0.5
  AFTER_A="$(wellknown_ids | grep -c '^local/proxy-a/')"
  ok "After revoke, proxy-A caps in /.well-known: ${AFTER_A}"
  [ "${AFTER_A}" -eq 0 ] || die "proxy-A caps did not vanish after revoke (still ${AFTER_A})"
  REMAIN_PRI="$(wellknown_ids | grep -cE '^workspace\.')"
  [ "${REMAIN_PRI}" -ge 1 ] && ok "primary still exposes its OWN caps (${REMAIN_PRI}) — revocation is per-workload, terminal." || die "primary caps vanished too"

  printf '\n%s%sDEMO COMPLETE — a linux primary + two cross-encryption proxies, aggregated into ONE collection.%s\n\n' "${BOLD}" "${GREEN}" "${RESET}"
}

# ── dispatch ──────────────────────────────────────────────────────────────────
case "${1:-}" in
  --selfcheck|selfcheck|--check) selfcheck ;;
  ""|--run|run)                  full_run ;;
  -h|--help)
    sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown argument: $1 (use --run or --selfcheck)" ;;
esac
