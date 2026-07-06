#!/usr/bin/env bash
# ============================================================================
# Plexus ↔ Codex setup — wire the `plexus` CLI onto Codex's PATH and teach Codex
# about Plexus via AGENTS.md. Idempotent and marker-guarded (safe to re-run).
#
# What it does (all reversible, nothing destructive):
#   1. Symlinks integrations/codex/bin/plexus into a PATH dir (default
#      ~/.local/bin) so `plexus …` is runnable from Codex's shell.
#   2. Appends the Plexus AGENTS.md block (integrations/codex/AGENTS.plexus.md)
#      to your global Codex instructions (~/.codex/AGENTS.md), guarded by
#      BEGIN/END PLEXUS markers so a re-run replaces rather than duplicates.
#
# Usage:
#   bash integrations/codex/setup.sh                 # ~/.local/bin + ~/.codex/AGENTS.md
#   BIN_DIR=~/bin bash integrations/codex/setup.sh   # custom PATH dir
#   AGENTS_FILE=./AGENTS.md bash integrations/codex/setup.sh   # project AGENTS.md
# ============================================================================
set -euo pipefail

here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
shim="$here/bin/plexus"
block="$here/AGENTS.plexus.md"

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
AGENTS_FILE="${AGENTS_FILE:-$HOME/.codex/AGENTS.md}"

echo "==> Plexus ↔ Codex setup"
echo "    shim:        $shim"
echo "    PATH dir:    $BIN_DIR"
echo "    AGENTS.md:   $AGENTS_FILE"

# 1. Symlink the shim onto PATH.
mkdir -p "$BIN_DIR"
ln -sf "$shim" "$BIN_DIR/plexus"
echo "==> linked $BIN_DIR/plexus -> $shim"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "    NOTE: $BIN_DIR is not on your PATH — add it (e.g. in your shell rc):"
     echo "          export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# 2. Append/refresh the AGENTS.md block (marker-guarded, idempotent).
mkdir -p "$(dirname "$AGENTS_FILE")"
touch "$AGENTS_FILE"
if grep -q "<!-- BEGIN PLEXUS -->" "$AGENTS_FILE"; then
  # Replace the existing block in place.
  tmp="$(mktemp)"
  awk '
    /<!-- BEGIN PLEXUS -->/ {skip=1; while ((getline line < BLOCK) > 0) print line; next}
    /<!-- END PLEXUS -->/   {skip=0; next}
    skip!=1 {print}
  ' BLOCK="$block" "$AGENTS_FILE" > "$tmp"
  mv "$tmp" "$AGENTS_FILE"
  echo "==> refreshed existing Plexus block in $AGENTS_FILE"
else
  { printf '\n'; cat "$block"; } >> "$AGENTS_FILE"
  echo "==> appended Plexus block to $AGENTS_FILE"
fi

echo "==> done. Verify with:  plexus --help    (and: codex exec \"use plexus list to see what you can call\")"
