#!/usr/bin/env bash
# ============================================================================
# Plexus — canonical, LAYERED release gate.
#
#   bash run-tests.sh                    →  CORE gate (default): typecheck + bun test
#   bash run-tests.sh --coverage         →  CORE gate + an instrumented coverage pass
#   bash run-tests.sh --gate <name>      →  run a specific layer (see below)
#   bash run-tests.sh --gate=<name>      →  same (=-form accepted too)
#
# Layers (--gate):
#   core         typecheck (bunx tsc --noEmit, strict) + bun test       [fast, always runs]
#   web          web-admin typecheck + vite build (+ component smoke IFF one exists)
#   desktop      desktop helper build + helper tests + electron-builder --dir pack smoke
#   linux-docker REAL Linux-kernel container e2e of the headless gateway (SKIP w/o Docker)
#   release      composes every layer runnable in THIS environment
#
# Default (no --gate) is CORE — identical commands to the historical gate, so
# existing CI/callers keep working and the default stays FAST (un-instrumented).
#
# ROBUSTNESS CONTRACT — each NON-core layer DEGRADES GRACEFULLY:
#   * a missing dir / optional toolchain  → printed as SKIPPED, does NOT fail the gate.
#   * a step that actually RUNS and FAILS → printed as FAILED, gate exits non-zero.
# We never silently pass: SKIPPED ("tool absent") and FAILED ("ran and failed")
# are reported as distinct outcomes, and a per-run summary lists ran/skipped/failed.
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")"

# ── CLI ──────────────────────────────────────────────────────────────────────
GATE="core"
WITH_COVERAGE=0

usage() {
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --coverage)  WITH_COVERAGE=1; shift ;;
    --gate)      shift; GATE="${1:-}"
                 [[ -n "$GATE" ]] || { echo "--gate requires a value" >&2; exit 2; }
                 shift ;;
    --gate=*)    GATE="${1#--gate=}"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

case "$GATE" in
  core|web|desktop|linux-docker|release) ;;
  *) echo "unknown gate: $GATE  (expected: core|web|desktop|linux-docker|release)" >&2; exit 2 ;;
esac

# ── outcome bookkeeping ──────────────────────────────────────────────────────
# Plain-string logs (bash 3.2 — no associative arrays). OVERALL flips to 1 on a
# real failure only; a SKIPPED step never flips it.
OVERALL=0
RAN_LOG=""
SKIP_LOG=""
FAIL_LOG=""

mark_ran()  { RAN_LOG="${RAN_LOG}  [ran]     $1"$'\n'; }
mark_skip() { SKIP_LOG="${SKIP_LOG}  [skipped] $1"$'\n'; }
mark_fail() { FAIL_LOG="${FAIL_LOG}  [FAILED]  $1"$'\n'; OVERALL=1; }

# step <label> <cmd...> — run a command, record ran/failed, never abort (the `if`
# exempts it from set -e). Returns the command's status so callers can compose.
step() {
  local label="$1"; shift
  echo "==> $label"
  if "$@"; then
    mark_ran "$label"
    return 0
  else
    mark_fail "$label"
    return 1
  fi
}

# ── core ─────────────────────────────────────────────────────────────────────
# The historical gate, byte-for-byte commands. FAIL-FAST (don't run bun test if
# the typecheck is already red) — preserves the default's exact semantics.
gate_core() {
  step "core · type-check (bunx tsc --noEmit, strict)" bunx tsc --noEmit || return 1
  step "core · unit tests (bun test)"                  bun test          || return 1
  if [[ "$WITH_COVERAGE" == "1" ]]; then
    step "core · coverage floor (bun test --coverage)" bun test --coverage || return 1
  fi
  return 0
}

# ── web ──────────────────────────────────────────────────────────────────────
# web-admin typecheck + production build. A component/browser smoke runs ONLY if
# one already exists — we do not invent a test framework (none is wired today).
gate_web() {
  local dir="packages/web-admin"
  [[ -d "$dir" ]]              || { mark_skip "web · package absent ($dir)"; return 0; }
  [[ -d "$dir/node_modules" ]] || { mark_skip "web · deps not installed ($dir — run 'bun install')"; return 0; }

  local rc=0
  step "web · type-check (tsc --noEmit)" bun run --cwd "$dir" typecheck || rc=1
  step "web · build (vite build)"        bun run --cwd "$dir" build     || rc=1

  if find "$dir/src" \( -name '*.test.*' -o -name '*.spec.*' \) 2>/dev/null | grep -q .; then
    step "web · component smoke (bun test)" bash -c "cd '$dir' && bun test" || rc=1
  else
    mark_skip "web · no component/browser smoke test present (none wired)"
  fi
  return $rc
}

# ── desktop ──────────────────────────────────────────────────────────────────
# (1) helper bundle smoke, (2) the OS/GUI-independent pure-helper unit tests, and
# (3) an UNSIGNED electron-builder --dir pack — but the pack runs ONLY when the
# packer is actually present, else it is reported SKIPPED (not failed).
gate_desktop() {
  local dir="packages/desktop"
  [[ -d "$dir" ]] || { mark_skip "desktop · package absent ($dir)"; return 0; }

  local rc=0
  step "desktop · helper build (bun build → main/helpers.js)" \
       bun run --cwd "$dir" build:helpers || rc=1

  if [[ -f tests/desktop-helpers.test.ts ]]; then
    step "desktop · helper tests (bun test tests/desktop-helpers.test.ts)" \
         bun test tests/desktop-helpers.test.ts || rc=1
  else
    mark_skip "desktop · helper test absent (tests/desktop-helpers.test.ts)"
  fi

  if [[ -x "$dir/node_modules/.bin/electron-builder" ]]; then
    step "desktop · pack smoke (electron-builder --dir, unsigned)" \
         bun run --cwd "$dir" pack || rc=1
  else
    mark_skip "desktop · electron-builder absent — pack smoke skipped"
  fi
  return $rc
}

# ── linux-docker ─────────────────────────────────────────────────────────────
# REAL Linux-kernel end-to-end verification of the headless portable gateway, run
# in an Ubuntu+Bun container (docker/Dockerfile) by tests/docker-linux-e2e.sh. It
# DEGRADES GRACEFULLY: absent/unusable Docker (or a missing script) is SKIPPED, not
# FAILED — so this layer never turns the gate red on a box without Docker.
gate_linux_docker() {
  local script="tests/docker-linux-e2e.sh"
  [[ -f "$script" ]] || { mark_skip "linux-docker · script absent ($script)"; return 0; }
  if ! command -v docker >/dev/null 2>&1; then
    mark_skip "linux-docker · docker CLI absent — Linux container e2e skipped"
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    mark_skip "linux-docker · docker daemon not usable — Linux container e2e skipped"
    return 0
  fi
  step "linux-docker · headless gateway container e2e (bash $script)" bash "$script"
}

# ── dispatch ─────────────────────────────────────────────────────────────────
echo "==> Plexus gate: '$GATE'"
case "$GATE" in
  core)         gate_core         || true ;;
  web)          gate_web          || true ;;
  desktop)      gate_desktop      || true ;;
  linux-docker) gate_linux_docker || true ;;
  release)
    # Compose every layer; keep going past a failure so the summary is complete.
    gate_core         || true
    gate_web          || true
    gate_desktop      || true
    gate_linux_docker || true
    ;;
esac

# ── summary ──────────────────────────────────────────────────────────────────
echo
echo "================= GATE SUMMARY ('$GATE') ================="
[[ -n "$RAN_LOG"  ]] && { echo "RAN:";     printf '%s' "$RAN_LOG"; }
[[ -n "$SKIP_LOG" ]] && { echo "SKIPPED:"; printf '%s' "$SKIP_LOG"; }
[[ -n "$FAIL_LOG" ]] && { echo "FAILED:";  printf '%s' "$FAIL_LOG"; }
echo "========================================================="
if [[ "$OVERALL" == "0" ]]; then
  echo "==> OK — gate '$GATE' green"
else
  echo "==> FAIL — gate '$GATE' has failures (see above)" >&2
fi
exit "$OVERALL"
