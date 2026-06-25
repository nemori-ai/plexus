#!/usr/bin/env bash
# Regenerate the desktop icon assets (P6). Produces:
#   assets/trayTemplate.png, assets/trayTemplate@2x.png   (macOS template tray icon)
#   assets/icon.iconset/*                                  (intermediate)
#   assets/icon.icns                                       (dock / bundle app icon)
# Requires: python3 + Pillow, and macOS `iconutil` for the .icns.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ASSETS="$HERE/../assets"

python3 "$HERE/gen-icons.py"

if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns "$ASSETS/icon.iconset" -o "$ASSETS/icon.icns"
  echo "[gen-icons] wrote assets/icon.icns"
else
  echo "[gen-icons] iconutil not found (non-macOS) — skipping .icns build" >&2
fi
