#!/bin/sh
# Renders the marks in app/Resources: AppIcon.icns from AppIcon.svg (also the website's
# logo.svg and favicon.svg, and the icon inlined in server/assets/502.html), the menu bar
# StatusIcon PNGs from StatusIcon.svg (40 and 80 px, drawn at the bar's height, black with alpha,
# for macOS to tint), and the menu glyphs (scripts/glyphs.mjs).
# qlmanage renders the SVGs on white; scripts/alpha.swift makes the background transparent.
set -eu
cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A copy of the SVG at a size qlmanage will draw in full (it keeps a small viewBox small).
sized() { # sized <svg> <px> <out.svg>
    sed "s/width=\"16\" height=\"16\"/width=\"$2\" height=\"$2\"/" "$1" > "$3"
}

render() { # render <svg> <px>  ->  $WORK/<name>.png
    qlmanage -t -s "$2" -o "$WORK" "$1" >/dev/null 2>&1
    echo "$WORK/$(basename "$1").png"
}

sized Resources/AppIcon.svg 1024 "$WORK/app.svg"
APP="$(render "$WORK/app.svg" 1024)"
swift scripts/alpha.swift border "$APP" "$WORK/app-alpha.png"

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$WORK/app-alpha.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$WORK/app-alpha.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o Resources/AppIcon.icns

# The menu bar mark: the A6 house outlined, with the prompt drawn inside it (Resources/StatusIcon.svg).
sized Resources/StatusIcon.svg 512 "$WORK/status.svg"
STATUS="$(render "$WORK/status.svg" 512)"
swift scripts/alpha.swift template "$STATUS" "$WORK/status-alpha.png"
sips -z 40 40 "$WORK/status-alpha.png" --out Resources/StatusIcon.png >/dev/null
sips -z 80 80 "$WORK/status-alpha.png" --out Resources/StatusIcon@2x.png >/dev/null
# The menu glyphs, as template images (Glyph-<name>.png at 16 px, @2x at 32 px).
for name in $(node scripts/glyphs.mjs "$WORK/glyphs"); do
    sips -s format png "$WORK/glyphs/$name.svg" --out "$WORK/glyphs/$name.png" >/dev/null
    swift scripts/alpha.swift template "$WORK/glyphs/$name.png" "$WORK/glyphs/$name-alpha.png"
    sips -z 16 16 "$WORK/glyphs/$name-alpha.png" --out "Resources/Glyph-$name.png" >/dev/null
    sips -z 32 32 "$WORK/glyphs/$name-alpha.png" --out "Resources/Glyph-$name@2x.png" >/dev/null
done
echo "wrote Resources/AppIcon.icns, the StatusIcon PNGs and the menu glyphs"
