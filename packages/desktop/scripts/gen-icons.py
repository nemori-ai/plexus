#!/usr/bin/env python3
"""
Generate the Plexus desktop icon assets (P6 — replace the glyph hack).

Two artifacts, both a simple diamond (◆) mark:

  1. TRAY TEMPLATE ICON (macOS menubar):
       assets/trayTemplate.png      (16x16, @1x)
       assets/trayTemplate@2x.png   (32x32, @2x)
     macOS auto-inverts a `…Template.png` for dark/light menubars, so the art is
     BLACK on transparent — only the alpha matters (the `IsTemplate` convention).

  2. APP ICON (dock / bundle):
       assets/icon.iconset/icon_{16,32,128,256,512}{,@2x}.png  → assets/icon.icns
     A filled brand-blue diamond on a rounded-rect plate (full color).

Run:  python3 scripts/gen-icons.py   (then iconutil builds the .icns — see gen-icons.sh)
Deterministic + dependency-light (Pillow only), so the committed PNGs/.icns are
reproducible placeholders; swap for designed art later without touching tray.js.
"""

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "assets")
ICONSET = os.path.join(ASSETS, "icon.iconset")
os.makedirs(ASSETS, exist_ok=True)
os.makedirs(ICONSET, exist_ok=True)

BRAND = (37, 99, 235, 255)      # brand blue (#2563eb)
PLATE = (15, 23, 42, 255)       # slate-900 plate
BLACK = (0, 0, 0, 255)


def diamond_points(size, inset_ratio):
    inset = size * inset_ratio
    cx = cy = size / 2
    r = cx - inset
    return [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]


def make_tray(size, path):
    """Monochrome BLACK diamond on transparent — a macOS template image."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Outline diamond with a hollow center → reads as a crisp glyph at 16px.
    outer = diamond_points(size, 0.10)
    inner = diamond_points(size, 0.34)
    d.polygon(outer, fill=BLACK)
    d.polygon(inner, fill=(0, 0, 0, 0))
    img.save(path)


def make_app(size, path):
    """Filled brand diamond on a rounded slate plate — the colored app icon."""
    # Supersample for smooth edges, then downscale.
    ss = 4
    big = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    s = size * ss
    pad = s * 0.06
    radius = s * 0.22
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=radius, fill=PLATE)
    d.polygon(diamond_points(s, 0.26), fill=BRAND)
    img = big.resize((size, size), Image.LANCZOS)
    img.save(path)


def main():
    # Tray template icon (@1x / @2x).
    make_tray(16, os.path.join(ASSETS, "trayTemplate.png"))
    make_tray(32, os.path.join(ASSETS, "trayTemplate@2x.png"))

    # App iconset (the sizes iconutil wants).
    specs = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, name in specs:
        make_app(size, os.path.join(ICONSET, name))

    print("[gen-icons] wrote tray template + icon.iconset")


if __name__ == "__main__":
    main()
