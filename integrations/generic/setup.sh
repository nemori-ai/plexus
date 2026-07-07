#!/usr/bin/env bash
# ============================================================================
# Plexus generic-agent setup — wire the `plexus` CLI onto ANY agent's PATH and
# teach it about Plexus via a dropped-in AGENTS.plexus.md. Idempotent and
# marker-guarded (safe to re-run). Agent-agnostic: no product-specific wiring.
#
# What it does (all reversible, nothing destructive):
#   1. Symlinks integrations/generic/bin/plexus into a PATH dir (default
#      ~/.local/bin) so `plexus …` is runnable from your agent's shell.
#   2. Lands the Plexus instruction block (integrations/generic/AGENTS.plexus.md)
#      where your agent reads it — appended to $AGENTS_FILE (default
#      ~/.plexus/AGENTS.plexus.md), guarded by BEGIN/END PLEXUS markers so a
#      re-run replaces rather than duplicates.
#
# The one-time enrollment code is NEVER handled here — after setup, ask your
# administrator for a code and run `plexus enroll <code>` once. This script is
# code-free and key-free: it wires reachability + instructions only.
#
# Usage:
#   bash integrations/generic/setup.sh                       # ~/.local/bin + ~/.plexus/AGENTS.plexus.md
#   BIN_DIR=~/bin bash integrations/generic/setup.sh         # custom PATH dir
#   AGENTS_FILE=./AGENTS.md bash integrations/generic/setup.sh   # your agent's instruction file
# ============================================================================
set -euo pipefail

here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
shim="$here/bin/plexus"
block="$here/AGENTS.plexus.md"

PLEXUS_HOME="${PLEXUS_HOME:-$HOME/.plexus}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
AGENTS_FILE="${AGENTS_FILE:-$PLEXUS_HOME/AGENTS.plexus.md}"
# The console URL the instruction points the agent at (loopback default). Override with
# PLEXUS_GATEWAY when your gateway binds a non-default port.
CONSOLE_URL="${PLEXUS_GATEWAY:-http://127.0.0.1:7077}/admin"

echo "==> Plexus generic-agent setup"
echo "    shim:        $shim"
echo "    PATH dir:    $BIN_DIR"
echo "    AGENTS file: $AGENTS_FILE"

# 1. Symlink the shim onto PATH.
mkdir -p "$BIN_DIR"
ln -sf "$shim" "$BIN_DIR/plexus"
echo "==> linked $BIN_DIR/plexus -> $shim"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "    NOTE: $BIN_DIR is not on your PATH — add it (e.g. in your shell rc):"
     echo "          export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# 2. Land the AGENTS instruction block (marker-guarded, idempotent), with the console
#    URL filled in.
mkdir -p "$(dirname "$AGENTS_FILE")"
touch "$AGENTS_FILE"
filled="$(mktemp)"
sed "s#{{PLEXUS_CONSOLE_URL}}#$CONSOLE_URL#g" "$block" > "$filled"
if grep -q "<!-- BEGIN PLEXUS -->" "$AGENTS_FILE"; then
  tmp="$(mktemp)"
  awk '
    /<!-- BEGIN PLEXUS -->/ {skip=1; while ((getline line < BLOCK) > 0) print line; next}
    /<!-- END PLEXUS -->/   {skip=0; next}
    skip!=1 {print}
  ' BLOCK="$filled" "$AGENTS_FILE" > "$tmp"
  mv "$tmp" "$AGENTS_FILE"
  echo "==> refreshed existing Plexus block in $AGENTS_FILE"
else
  { printf '\n'; cat "$filled"; } >> "$AGENTS_FILE"
  echo "==> appended Plexus block to $AGENTS_FILE"
fi
rm -f "$filled"

echo "==> done. Next: ask your administrator for a one-time code, then run:  plexus enroll <code>"
echo "    Verify with:  plexus --help   (and: plexus list)"
