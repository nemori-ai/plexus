#!/usr/bin/env bash
# ============================================================================
# Plexus — canonical endpoint test gate.
#   bash run-tests.sh   →   exits 0 iff typecheck + unit tests pass.
# Runs: bunx tsc --noEmit   (frozen-contract strict typecheck)
#       bun test            (unit tests, incl. the .well-known endpoint gate)
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

echo "==> [1/2] Type-check (bunx tsc --noEmit, strict)"
bunx tsc --noEmit

echo "==> [2/2] Unit tests (bun test)"
bun test

echo "==> OK — all gates green"
