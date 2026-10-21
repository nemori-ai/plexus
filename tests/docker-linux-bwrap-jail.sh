#!/usr/bin/env bash
# ============================================================================
# Plexus — the exec-source kernel jail under a REAL Linux kernel (bwrap).
#
#   bash tests/docker-linux-bwrap-jail.sh
#
# Builds the stock gateway image (docker/Dockerfile ships bubblewrap) and runs the
# real-kernel matrix, tests/exec-jail-kernel.test.ts, inside it. bwrap needs to create
# user + mount namespaces and mount a fresh /proc, which Docker's default seccomp,
# AppArmor and masked-paths profiles forbid, so the container runs with those
# confinements lifted (the jail under test is bwrap's own). On the macOS dev box the
# same test runs under sandbox-exec; this is the Linux half.
#
# PLEXUS_BWRAP_IMAGE_REUSE=1 skips the build and mounts the checkout's tests and
# runtime sources into an image built earlier (no network needed).
#
# Exit 0 = the matrix passed under bwrap. Nonzero = a real gap on Linux (or no Docker).
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="plexus-gateway:bwrap-jail"
cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not usable here" >&2
  exit 2
fi

MOUNTS=()
if [[ "${PLEXUS_BWRAP_IMAGE_REUSE:-}" == "1" ]]; then
  echo "==> reusing $IMAGE with the checkout mounted ..."
  MOUNTS=(-v "$REPO_ROOT/tests:/app/tests:ro" -v "$REPO_ROOT/packages/runtime/src:/app/packages/runtime/src:ro")
else
  echo "==> building $IMAGE from docker/Dockerfile ..."
  docker build -f docker/Dockerfile -t "$IMAGE" . >/dev/null
fi

echo "==> running tests/exec-jail-kernel.test.ts under bwrap ..."
docker run --rm \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
  ${MOUNTS[@]+"${MOUNTS[@]}"} \
  "$IMAGE" bash -lc 'bwrap --version && bun test tests/exec-jail-kernel.test.ts tests/p3-5-linux-confinement.test.ts'
