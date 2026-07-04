#!/usr/bin/env bash
#
# up.sh — bring up the LOCAL hero topology of the mesh-security-audit flagship.
#
# TWO nodes, ONE machine:
#   • Mac = PRIMARY, run NATIVELY (stock gateway, default primary mode). Exposes the
#     LOCAL sources codex.run (dir-jailed to the analysis dir) + workspace.* (the vault
#     folder, which doubles as an Obsidian vault). Binds the mesh tunnel on 0.0.0.0 so a
#     Docker container can dial in.
#   • Docker-Linux = PROXY (the "remote linux"). Stock image from docker/Dockerfile, run
#     PLEXUS_MODE=proxy / PLEXUS_WORKLOAD=linux, dialing the Mac primary at
#     ws://host.docker.internal:<mesh-ws-port> with a minted one-time join token + the
#     pinned primary pubkey. Exposes the net-new sysinfo.* source over the seeded log.
#
# What it does, end to end:
#   1. ensure the analysis + vault dirs (+ isolated primary PLEXUS_HOME) exist,
#   2. start the Mac primary natively (background; wait for its ready line / well-known),
#   3. mint a mesh join token for workload `linux` and read the primary pubkey,
#   4. build + run the Docker linux proxy, dialing in with that token,
#   5. wait until the primary shows the linux proxy enrolled + its sysinfo caps mounted
#      as local/linux/sysinfo.{processes.list,resources.read,log.read},
#   6. print a success summary + where the two audit dirs live.
#
# Everything is env-overridable (see DEFAULTS). Re-runnable: a prior primary/container
# is torn down first. Tear down with ./down.sh.
#
# Usage:  ./up.sh            (or: bash up.sh)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# ── DEFAULTS (all overridable via env) ─────────────────────────────────────────
# Everything lives under DEMO_ROOT (~/PlexusDemo by default) so a single `rm -rf` cleans
# up, and NON-DEFAULT ports keep this off ~/.plexus:7077 (a concurrent personal gateway
# may be running on this box). PLEXUS_PRIMARY_HOME is ISOLATED under DEMO_ROOT so the demo
# never clobbers a personal gateway's home.
: "${DEMO_ROOT:=${HOME}/PlexusDemo}"
: "${PLEXUS_PRIMARY_HOME:=${DEMO_ROOT}/primary-home}"   # isolated gateway home (connection-key/audit/mesh-identity)
: "${PRIMARY_PORT:=7801}"          # agent-facing HTTP (loopback)
: "${MESH_WS_PORT:=8801}"          # mesh tunnel ws listener (bound on 0.0.0.0)
: "${ANALYSIS_DIR:=${DEMO_ROOT}/analysis}"   # codex jail (PLEXUS_CODEX_AUTHORIZED_DIR)
: "${VAULT_DIR:=${DEMO_ROOT}/vault}"         # workspace root == Obsidian vault folder
: "${WORKLOAD:=linux}"

CLI="${REPO_ROOT}/packages/cli/src/bin/plexus"
ENTRY="${REPO_ROOT}/packages/runtime/src/index.ts"
COMPOSE_FILE="${SCRIPT_DIR}/compose.linux.yml"
ENV_FILE="${SCRIPT_DIR}/mesh.env"
PID_FILE="${PLEXUS_PRIMARY_HOME}/primary.pid"
PRIMARY_LOG="${PLEXUS_PRIMARY_HOME}/primary.log"
PRIMARY_BASE="http://127.0.0.1:${PRIMARY_PORT}"

# ── narration helpers ──────────────────────────────────────────────────────────
BOLD=$'\e[1m'; DIM=$'\e[2m'; CYAN=$'\e[36m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
bar()    { printf '%s\n' "${CYAN}────────────────────────────────────────────────────────────────────────${RESET}"; }
header() { printf '\n'; bar; printf '%s%sSTEP %s%s  %s%s%s\n' "${BOLD}" "${CYAN}" "$1" "${RESET}" "${BOLD}" "$2" "${RESET}"; bar; }
say()    { printf '  %s\n' "$1"; }
ok()     { printf '  %s✓%s %s\n' "${GREEN}" "${RESET}" "$1"; }
detail() { printf '    %s%-34s%s %s\n' "${DIM}" "$1" "${RESET}" "$2"; }
note()   { printf '  %s»%s %s\n' "${YELLOW}" "${RESET}" "$1"; }
die()    { printf '\n%s%sBRING-UP FAILED%s: %s\n' "${BOLD}" "${RED}" "${RESET}" "$1" >&2; exit 1; }
need()   { command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"; }

# admin GET against the native primary (loopback Host guard + connection-key).
admin_get() { curl -s "${PRIMARY_BASE}$1" -H "host: 127.0.0.1:${PRIMARY_PORT}" -H "X-Plexus-Connection-Key: ${CONNECTION_KEY}"; }

wait_until() { # <predicate> <max-deciseconds>
  local pred="$1" max="${2:-300}" i=0
  while [ "$i" -lt "${max}" ]; do
    if eval "${pred}" >/dev/null 2>&1; then return 0; fi
    sleep 0.2; i=$((i + 1))
  done
  return 1
}

need bun; need docker; need jq; need curl
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is required"

printf '%s╔══════════════════════════════════════════════════════════════════════╗%s\n' "${BOLD}" "${RESET}"
printf '%s║  Plexus mesh-security-audit — LOCAL hero topology                     ║%s\n' "${BOLD}" "${RESET}"
printf '%s║  Mac PRIMARY (native: codex + workspace) + Docker-Linux PROXY (sysinfo)║%s\n' "${BOLD}" "${RESET}"
printf '%s╚══════════════════════════════════════════════════════════════════════╝%s\n' "${BOLD}" "${RESET}"

# ────────────────────────────────────────────────────────────────────────────────
header 0 "Ensure dirs + tear down any prior run (idempotent)"
# ────────────────────────────────────────────────────────────────────────────────
mkdir -p "${PLEXUS_PRIMARY_HOME}" "${ANALYSIS_DIR}" "${VAULT_DIR}"
ok "analysis dir (codex jail): ${ANALYSIS_DIR}"
ok "vault dir (workspace == Obsidian vault): ${VAULT_DIR}"
ok "primary PLEXUS_HOME (isolated): ${PLEXUS_PRIMARY_HOME}"
# Kill a stale primary from a prior up.sh.
if [ -f "${PID_FILE}" ]; then
  OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then kill "${OLD_PID}" 2>/dev/null || true; sleep 0.5; fi
  rm -f "${PID_FILE}"
fi
# Tear down a stale proxy container.
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" down -v >/dev/null 2>&1 || true
: > "${ENV_FILE}"  # empty env-file so `compose config` stays valid before minting
# CLEAN-SLATE the mesh enrollment registry (re-runnability): `down -v` above wiped the
# proxy container's state volume, so the proxy that re-attaches will present a BRAND-NEW
# Ed25519 identity. But the primary's PLEXUS_HOME persists across runs, and its
# enrollments.json still holds the PRIOR proxy's `linux` record as `active` — pinned to a
# now-dead key. Invariant F (anti-hijack) then refuses the fresh proxy's join with
# `duplicate_workload`, and the mesh silently never mounts. Since a fresh proxy ALWAYS has
# a fresh key here, the stale record is never useful — drop it so re-enrollment is clean.
# (The primary's OWN mesh identity lives in mesh/identity/, untouched → its pinned pubkey
# stays stable. Minted tokens are re-minted below.)
rm -f "${PLEXUS_PRIMARY_HOME}/mesh/enrollments.json" 2>/dev/null || true

# ────────────────────────────────────────────────────────────────────────────────
header 1 "Start the Mac PRIMARY natively (stock gateway, default primary mode)"
# ────────────────────────────────────────────────────────────────────────────────
say "Tunnel bound on 0.0.0.0:${MESH_WS_PORT} (plain ws) so the container can dial in."
detail "agent HTTP (loopback)" "${PRIMARY_BASE}"
detail "mesh tunnel (ws)"      "ws://0.0.0.0:${MESH_WS_PORT}  →  container dials host.docker.internal:${MESH_WS_PORT}"
detail "codex jail dir"        "${ANALYSIS_DIR}"
detail "workspace / vault dir" "${VAULT_DIR}"

env -i \
  HOME="${HOME}" PATH="${PATH}" \
  PLEXUS_HOME="${PLEXUS_PRIMARY_HOME}" \
  PLEXUS_INSTANCE="audit-primary" \
  PLEXUS_PORT="${PRIMARY_PORT}" \
  PLEXUS_MESH_TUNNEL_HOST="0.0.0.0" \
  PLEXUS_MESH_WS_PORT="${MESH_WS_PORT}" \
  PLEXUS_WORKSPACE_DIR="${VAULT_DIR}" \
  PLEXUS_CODEX_AUTHORIZED_DIR="${ANALYSIS_DIR}" \
  bun run "${ENTRY}" > "${PRIMARY_LOG}" 2>&1 &
PRIMARY_PID=$!
echo "${PRIMARY_PID}" > "${PID_FILE}"
detail "primary pid" "${PRIMARY_PID}  (log: ${PRIMARY_LOG})"

wait_until 'curl -s -o /dev/null -w "%{http_code}" "${PRIMARY_BASE}/.well-known/plexus" | grep -q 200' 600 \
  || { tail -30 "${PRIMARY_LOG}" >&2; die "primary did not become reachable on ${PRIMARY_BASE}"; }
kill -0 "${PRIMARY_PID}" 2>/dev/null || { tail -30 "${PRIMARY_LOG}" >&2; die "primary process exited during boot"; }
ok "PRIMARY is up — its own agent surface answers on ${PRIMARY_BASE}."
grep -m1 'PLEXUS_READY' "${PRIMARY_LOG}" 2>/dev/null | sed 's/^/      /' || true

CONNECTION_KEY="$(cat "${PLEXUS_PRIMARY_HOME}/connection-key" 2>/dev/null | tr -d '\r\n')"
[ -n "${CONNECTION_KEY}" ] || die "primary did not write a connection-key under ${PLEXUS_PRIMARY_HOME}"
detail "connection-key (trust boundary)" "${CONNECTION_KEY:0:12}…"

say "The primary's OWN local sources (codex + workspace) are discoverable:"
admin_get /.well-known/plexus | jq -r '.capabilities[]?.id' 2>/dev/null \
  | grep -Ei '^(codex|workspace|obsidian)' | sed 's/^/      • /' || true

# ────────────────────────────────────────────────────────────────────────────────
header 2 "Mint a ONE-TIME join token for workload '${WORKLOAD}'"
# ────────────────────────────────────────────────────────────────────────────────
MINT="$(PLEXUS_HOME="${PLEXUS_PRIMARY_HOME}" bun run "${CLI}" mesh mint \
          --url "${PRIMARY_BASE}" --workload "${WORKLOAD}" \
          --host host.docker.internal --scheme ws --json 2>/dev/null)"
JOIN_TOKEN="$(printf '%s' "${MINT}" | jq -r '.token // empty')"
PRIMARY_PUBKEY_PEM="$(printf '%s' "${MINT}" | jq -r '.primaryPubKey // empty')"
ADV_WS_PORT="$(printf '%s' "${MINT}" | jq -r '.endpoints[]? | select(.scheme=="ws") | .port')"
[ -n "${JOIN_TOKEN}" ]         || die "mint returned no token: ${MINT}"
[ -n "${PRIMARY_PUBKEY_PEM}" ] || die "mint returned no primaryPubKey: ${MINT}"
# The mint returns the pubkey as a multi-line SPKI PEM. An --env-file value cannot span
# lines, so collapse it to the RAW single-line base64 Ed25519 key (strip the PEM
# envelope → SPKI-DER → drop the 12-byte SPKI header → base64 the 32-byte key). The
# proxy's pin (`samePublicKey`) treats the two forms as equal (PEM ⇔ raw-base64).
PRIMARY_PUBKEY="$(printf '%s' "${PRIMARY_PUBKEY_PEM}" | grep -v 'PUBLIC KEY' | tr -d '\n ' | base64 -d 2>/dev/null | tail -c 32 | base64 | tr -d '\n')"
[ -n "${PRIMARY_PUBKEY}" ] || die "failed to derive raw pubkey from PEM: ${PRIMARY_PUBKEY_PEM}"
[ -n "${ADV_WS_PORT}" ]    || die "primary advertised no ws tunnel endpoint (tunnel not bound?): ${MINT}"
[ "${ADV_WS_PORT}" = "${MESH_WS_PORT}" ] \
  || note "primary advertised ws port ${ADV_WS_PORT} (expected ${MESH_WS_PORT}); using advertised."
MESH_WS_PORT="${ADV_WS_PORT}"
ok "Minted a single-use join token; pinned the primary pubkey (no bare-TOFU)."
detail "workload"        "${WORKLOAD}"
detail "upstream (dial)" "${BOLD}${GREEN}ws://host.docker.internal:${MESH_WS_PORT}${RESET}"
detail "primaryPubKey (pinned)" "${PRIMARY_PUBKEY}"

# The --env-file the compose proxy substitutes from.
cat > "${ENV_FILE}" <<EOF
PLEXUS_UPSTREAM_PUBKEY=${PRIMARY_PUBKEY}
LINUX_JOIN_TOKEN=${JOIN_TOKEN}
MESH_WS_PORT=${MESH_WS_PORT}
EOF

# ────────────────────────────────────────────────────────────────────────────────
header 3 "Build + run the Docker LINUX PROXY (dials the Mac primary)"
# ────────────────────────────────────────────────────────────────────────────────
# Build the image EXPLICITLY (not via `compose --build`) so we can control the builder.
# BuildKit resolves the base image's metadata from the registry on every build; on a
# throttled/offline box that pull STALLS at "load metadata for ubuntu:22.04". The classic
# builder (DOCKER_BUILDKIT=0) uses a locally-cached base image WITHOUT that round-trip.
# Default = BuildKit; set PLEXUS_BUILDKIT=0 to force the classic builder (offline-friendly).
#
# REUSE-FIRST: the build needs network (bun download in Dockerfile). If a
# plexus-gateway:latest image is ALREADY present, reuse it and SKIP the build entirely —
# an offline/throttled box otherwise fails at the bun download even on the classic builder.
# Force a fresh rebuild with PLEXUS_FORCE_BUILD=1 (e.g. after changing runtime source).
if [ "${PLEXUS_FORCE_BUILD:-0}" != "1" ] && docker image inspect plexus-gateway:latest >/dev/null 2>&1; then
  ok "Reusing the existing plexus-gateway:latest image (skip build — set PLEXUS_FORCE_BUILD=1 to rebuild)."
else
  say "Building the STOCK gateway image (docker/Dockerfile) — first build can be slow…"
  if [ "${PLEXUS_BUILDKIT:-1}" = "0" ]; then
    note "PLEXUS_BUILDKIT=0 — classic builder (uses cached ubuntu:22.04, no registry metadata pull)."
    DOCKER_BUILDKIT=0 docker build -f "${REPO_ROOT}/docker/Dockerfile" -t plexus-gateway:latest "${REPO_ROOT}" \
      || die "docker build (classic) failed"
  else
    docker build -f "${REPO_ROOT}/docker/Dockerfile" -t plexus-gateway:latest "${REPO_ROOT}" \
      || die "docker build failed (if it stalls on 'load metadata for ubuntu:22.04' on a throttled/offline box, re-run with PLEXUS_BUILDKIT=0 ./up.sh)"
  fi
  ok "Stock gateway image built (plexus-gateway:latest, from the current working tree)."
fi
# Consume the just-built image (no --build → no second registry round-trip).
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --no-build \
  || die "docker compose up (linux proxy) failed"
ok "Linux proxy container launched, dialing OUT to the primary over the host bridge."

# ────────────────────────────────────────────────────────────────────────────────
header 4 "Wait for the proxy to enroll + its sysinfo caps to mount on the primary"
# ────────────────────────────────────────────────────────────────────────────────
say "Polling the primary's admin exposure catalog for local/${WORKLOAD}/sysinfo.* …"
if ! wait_until 'admin_get /admin/api/exposure | jq -e "any(.capabilities[]?.id; startswith(\"local/'"${WORKLOAD}"'/sysinfo.\"))"' 600; then
  printf '%s\n' "${DIM}---- linux proxy logs (tail) ----${RESET}" >&2
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" logs --no-color --tail 40 linux >&2 || true
  die "primary never mounted local/${WORKLOAD}/sysinfo.* (enroll / dial failed?)"
fi
MOUNTED="$(admin_get /admin/api/exposure | jq -r '.capabilities[]?.id | select(startswith("local/'"${WORKLOAD}"'/sysinfo."))' | sort)"
ok "Linux proxy ENROLLED — its sysinfo catalog auto-mounted under local/${WORKLOAD}/:"
printf '%s\n' "${MOUNTED}" | sed 's/^/      • /'

# ────────────────────────────────────────────────────────────────────────────────
header 5 "READY — the LOCAL hero topology is up"
# ────────────────────────────────────────────────────────────────────────────────
ok "${BOLD}${GREEN}Mesh is live: Mac primary + Docker-Linux proxy, one machine.${RESET}"
say ""
detail "primary agent surface"  "${PRIMARY_BASE}   (connection-key: ${PLEXUS_PRIMARY_HOME}/connection-key)"
detail "primary audit dir"      "${PLEXUS_PRIMARY_HOME}/audit/   (codex / workspace / grants land HERE)"
detail "linux proxy audit"      "docker volume plexus-audit-local_linux-state → /state/audit/   (sysinfo lands HERE)"
detail "seeded security log"    "${SCRIPT_DIR}/seed/var-log/auth.log  →  container /var/log/plexus-demo/auth.log"
detail "codex jail dir"         "${ANALYSIS_DIR}"
detail "vault dir"              "${VAULT_DIR}"
say ""
say "Mounted remote caps the agent can reach THROUGH the primary:"
printf '%s\n' "${MOUNTED}" | sed 's/^/      • /'
say ""
note "Next: an operator EXPOSES + GRANTS these caps and connects the agent (scripts/grant-setup.sh)."
note "Tear down with:  ./down.sh"
printf '\n%s%sTOPOLOGY UP.%s\n\n' "${BOLD}" "${GREEN}" "${RESET}"
