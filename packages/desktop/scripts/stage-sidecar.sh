#!/usr/bin/env bash
# ============================================================================
# stage-sidecar.sh — copy the compiled runtime exe(s) into the desktop build dir
# ============================================================================
# electron-builder ships `build/runtime/` as an extraResource, landing it at
# `<App>.app/Contents/Resources/runtime/`, exactly where the supervisor's
# `resolveRuntimeCommand` looks (RUNTIME_RESOURCE_DIR = "runtime").
#
# We only stage the binary matching the build host's arch by default (a pack on
# an arm64 Mac ships the arm64 exe). Pass --all to stage both arches (universal
# distribution), or PLEXUS_SIDECAR_ARCH=x64 to force one.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$HERE/.."
RUNTIME_DIST="$DESKTOP/../runtime/dist"
STAGE="$DESKTOP/build/runtime"

mkdir -p "$STAGE"
rm -f "$STAGE"/plexus-runtime-* 2>/dev/null || true

stage_one() {
  local arch="$1"
  local src="$RUNTIME_DIST/plexus-runtime-darwin-$arch"
  if [[ ! -f "$src" ]]; then
    echo "[stage-sidecar] MISSING $src — run \`bun run --cwd ../runtime build:compile\` first" >&2
    exit 1
  fi
  cp "$src" "$STAGE/"
  chmod +x "$STAGE/plexus-runtime-darwin-$arch"
  echo "[stage-sidecar] staged plexus-runtime-darwin-$arch"
}

if [[ "${1:-}" == "--all" ]]; then
  stage_one arm64
  stage_one x64
else
  ARCH="${PLEXUS_SIDECAR_ARCH:-$(uname -m)}"
  case "$ARCH" in
    arm64|aarch64) stage_one arm64 ;;
    x86_64|x64)    stage_one x64 ;;
    *) echo "[stage-sidecar] unknown host arch '$ARCH' — staging both" >&2; stage_one arm64; stage_one x64 ;;
  esac
fi
