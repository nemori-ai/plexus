#!/usr/bin/env bash
# ============================================================================
# Plexus — canonical endpoint test gate.
#   bash run-tests.sh              →  exits 0 iff typecheck + unit tests pass.
#   bash run-tests.sh --coverage   →  same, plus an instrumented coverage pass.
# Runs: bunx tsc --noEmit   (frozen-contract strict typecheck)
#       bun test            (unit tests, incl. the .well-known endpoint gate)
# The default run is un-instrumented so it stays FAST; --coverage adds a pass
# that enforces the coverage floor from bunfig.toml.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

WITH_COVERAGE=0
for arg in "$@"; do
  case "$arg" in
    --coverage) WITH_COVERAGE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

echo "==> [1/2] Type-check (bunx tsc --noEmit, strict)"
bunx tsc --noEmit

echo "==> [2/2] Unit tests (bun test)"
bun test

if [[ "$WITH_COVERAGE" == "1" ]]; then
  echo "==> [extra] Coverage (bun test --coverage, enforces bunfig floor)"
  bun test --coverage
fi

echo "==> OK — all gates green"
