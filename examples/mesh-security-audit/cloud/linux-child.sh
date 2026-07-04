#!/usr/bin/env bash
#
# linux-child.sh — attach the Docker Linux child (proxy) to the CLOUD parent.
#
# ┌───────────────────────────────────────────────────────────────────────────────────┐
# │ YOU run this on ANY Docker host (a VM, a laptop, a CI box). It runs the STOCK        │
# │ gateway image as a mesh PROXY, dialing OUT to wss://mesh.<your-domain> (the          │
# │ Cloudflare edge). It exposes the net-new sysinfo.* source over a seeded security     │
# │ log. Because it dials the PUBLIC edge, it can run anywhere — it does NOT need to be   │
# │ co-located with the parent (that is the whole point of the cloud topology).          │
# └───────────────────────────────────────────────────────────────────────────────────┘
#
# Get the join env FIRST from the parent's mint:
#     MESH_HOSTNAME=mesh.<your-domain> ./mint-join.sh linux > linux.join.env
# then run:  LINUX_JOIN_ENV=linux.join.env ./linux-child.sh
# (or pass the join vars in the environment). Join tokens are SINGLE-USE.
#
# Env:
#   LINUX_JOIN_ENV        path to a KEY=VALUE join env file from mint-join.sh (recommended)
#   PLEXUS_UPSTREAM_URL   wss://mesh.<domain>          (else from LINUX_JOIN_ENV)
#   PLEXUS_UPSTREAM_PUBKEY pinned raw Ed25519 pubkey   (else from LINUX_JOIN_ENV)
#   PLEXUS_JOIN_TOKEN     one-time join token          (else from LINUX_JOIN_ENV)
#   PLEXUS_WORKLOAD       workload name (default: linux)
#   PLEXUS_BUILDKIT       "0" ⇒ classic builder (offline-friendly base image; see ../local/up.sh)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/compose.linux.yml"
ENV_FILE="${SCRIPT_DIR}/mesh.env"

die() { printf '\n[linux-child] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required tool not found on PATH: $1"; }
need docker
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is required"

# Optionally source a join env file produced by mint-join.sh.
if [ -n "${LINUX_JOIN_ENV:-}" ]; then
  [ -f "${LINUX_JOIN_ENV}" ] || die "LINUX_JOIN_ENV=${LINUX_JOIN_ENV} not found"
  set -a; . "${LINUX_JOIN_ENV}"; set +a
fi

WORKLOAD="${PLEXUS_WORKLOAD:-linux}"
[ -n "${PLEXUS_UPSTREAM_URL:-}" ]    || die "PLEXUS_UPSTREAM_URL unset — run ./mint-join.sh linux first"
[ -n "${PLEXUS_UPSTREAM_PUBKEY:-}" ] || die "PLEXUS_UPSTREAM_PUBKEY unset — run ./mint-join.sh linux first"
[ -n "${PLEXUS_JOIN_TOKEN:-}" ]      || die "PLEXUS_JOIN_TOKEN unset — run ./mint-join.sh linux first"

# Write the --env-file the compose proxy substitutes from.
cat > "${ENV_FILE}" <<EOF
PLEXUS_WORKLOAD=${WORKLOAD}
PLEXUS_UPSTREAM_URL=${PLEXUS_UPSTREAM_URL}
PLEXUS_UPSTREAM_PUBKEY=${PLEXUS_UPSTREAM_PUBKEY}
PLEXUS_JOIN_TOKEN=${PLEXUS_JOIN_TOKEN}
EOF

echo "[linux-child] dialing ${PLEXUS_UPSTREAM_URL}  (workload=${WORKLOAD})"

# Build the STOCK image explicitly (control the builder — a throttled box stalls on the
# ubuntu base metadata pull under BuildKit; PLEXUS_BUILDKIT=0 uses the cached base).
if [ "${PLEXUS_BUILDKIT:-1}" = "0" ]; then
  DOCKER_BUILDKIT=0 docker build -f "${REPO_ROOT}/docker/Dockerfile" -t plexus-gateway:latest "${REPO_ROOT}" \
    || die "docker build (classic) failed"
else
  docker build -f "${REPO_ROOT}/docker/Dockerfile" -t plexus-gateway:latest "${REPO_ROOT}" \
    || die "docker build failed (if it stalls on 'load metadata for ubuntu:22.04', re-run with PLEXUS_BUILDKIT=0)"
fi

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --no-build \
  || die "docker compose up (linux proxy) failed"

echo "[linux-child] ✓ Linux proxy launched, dialing OUT to the cloud parent through the CF edge."
echo "[linux-child]   its sysinfo.* caps auto-mount on the parent as local/${WORKLOAD}/sysinfo.*"
echo "[linux-child]   local audit (sysinfo invokes it executes): docker volume plexus-audit-cloud-linux_linux-state → /state/audit/"
echo "[linux-child]   logs : docker compose -f ${COMPOSE_FILE} logs -f linux"
echo "[linux-child]   down : docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} down -v"
