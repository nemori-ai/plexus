#!/usr/bin/env bash
# ============================================================================
# Plexus ↔ Codex setup — teach Codex about Plexus in the PROJECT you run it
# from, via ./AGENTS.md. Idempotent and marker-guarded (safe to re-run).
# Per-agent injections land in the project
# (docs/design/agent-integration-project-scope.md); ~/.plexus is the only
# sanctioned home-directory write. Codex discovers a project-root ./AGENTS.md
# by itself (git-root→cwd walk) — no global instruction file is needed.
#
# What it does (all reversible, nothing destructive):
#   1. Lands the Plexus AGENTS.md block (integrations/codex/AGENTS.plexus.md)
#      at $AGENTS_FILE — default $PWD/AGENTS.md, the project you paste this in —
#      guarded by BEGIN/END PLEXUS markers so a re-run replaces rather than
#      duplicates. The block teaches the shim's ABSOLUTE path (the {{PLEXUS_CMD}}
#      fill), robust under Codex's per-call workdir with zero PATH setup.
#   2. ONLY when you explicitly set BIN_DIR=: also symlinks the shim into that
#      dir as a PATH convenience for humans.
#
# To teach EVERY Codex session on this machine (a global injection — know what
# you're opting into): AGENTS_FILE=~/.codex/AGENTS.md bash integrations/codex/setup.sh
#
# Usage:
#   bash integrations/codex/setup.sh                          # lands ./AGENTS.md in the current project
#   AGENTS_FILE=./NOTES.md bash integrations/codex/setup.sh   # a different instruction file
#   BIN_DIR=~/bin bash integrations/codex/setup.sh            # ALSO symlink the shim onto PATH (explicit opt-in)
# ============================================================================
set -euo pipefail

here="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
shim="$here/bin/plexus"
block="$here/AGENTS.plexus.md"

AGENTS_FILE="${AGENTS_FILE:-$PWD/AGENTS.md}"
# The console URL the instruction points Codex at (loopback default). Override with
# PLEXUS_GATEWAY when your gateway binds a non-default port.
CONSOLE_URL="${PLEXUS_GATEWAY:-http://127.0.0.1:7077}/admin"

echo "==> Plexus ↔ Codex setup"
echo "    command:     $shim"
echo "    AGENTS.md:   $AGENTS_FILE"

if [ "$PWD" = "$HOME" ]; then
  echo "    WARNING — you are running this from your HOME directory, so the instruction block will land at $HOME/AGENTS.md (visible to every agent session started there)." >&2
  echo "    WARNING — cd into the project you run codex in, then re-run there. Proceeding anyway (not fatal)." >&2
fi

# 1. Land the AGENTS.md block (marker-guarded, idempotent), filling the console URL and
#    the absolute shim command ({{PLEXUS_CMD}}).
mkdir -p "$(dirname "$AGENTS_FILE")"
touch "$AGENTS_FILE"
filled="$(mktemp)"
sed -e "s#{{PLEXUS_CONSOLE_URL}}#$CONSOLE_URL#g" -e "s#{{PLEXUS_CMD}}#$shim#g" "$block" > "$filled"
if grep -q "<!-- BEGIN PLEXUS -->" "$AGENTS_FILE"; then
  # Replace the existing block in place.
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

# 2. PATH convenience — ONLY when BIN_DIR was explicitly set (no default). The block above
#    already teaches the absolute command, so a PATH entry is a human nicety, not wiring.
if [ -n "${BIN_DIR:-}" ]; then
  mkdir -p "$BIN_DIR"
  ln -sf "$shim" "$BIN_DIR/plexus"
  echo "==> linked $BIN_DIR/plexus -> $shim (explicit BIN_DIR opt-in)"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "    NOTE: $BIN_DIR is not on your PATH — add it (e.g. in your shell rc):"
       echo "          export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
fi

echo "==> done. Codex picks the block up from $AGENTS_FILE by itself; it teaches the absolute command: $shim"
echo "    Verify with:  $shim --help    (and: codex exec \"use plexus list to see what you can call\")"
