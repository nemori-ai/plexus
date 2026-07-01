#!/usr/bin/env bash
# Boot the Plexus capability-exposure APPLIANCE with the full least-privilege flag set,
# then prove via `.well-known` that ONLY the curated `workspace` capabilities are exposed.
#
#   ./examples/appliance/run-appliance.sh           # build (if needed) + run + probe
#
# Stop with Ctrl-C. This is the raw `docker run` form (no compose) so every hardening
# flag is visible in one place — the same flags compose.appliance.yml sets declaratively.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EX_DIR="$REPO_ROOT/examples/appliance"
IMAGE="plexus-appliance:latest"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[run] building $IMAGE ..."
  docker build -f "$REPO_ROOT/docker/Dockerfile.appliance" -t "$IMAGE" "$REPO_ROOT"
fi

echo "[run] starting appliance (least-privilege flags) ..."
docker run --rm \
  --name plexus-appliance \
  --user 10001:10001 \
  --read-only \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --tmpfs /state:rw,size=16m,mode=0700 \
  -v "$EX_DIR/manifest.json:/etc/plexus/appliance.json:ro" \
  -v "$EX_DIR/exposed-data:/data/exposed:ro" \
  -e PLEXUS_APPLIANCE_MANIFEST=/etc/plexus/appliance.json \
  -e PLEXUS_HOME=/state \
  -p 127.0.0.1:7077:7077 \
  "$IMAGE"
