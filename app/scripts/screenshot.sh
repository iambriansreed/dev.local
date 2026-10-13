#!/bin/sh
# Takes the website's Settings screenshot from the real app: demo mode (the sample apps in
# .scripts/dev.proxies.json, served by scripts/fake-server.mjs, no nginx or sudo), dark
# appearance, Settings opened on a clone of Storefront. Writes web/assets/06-settings.png.
# The terminal running this needs Screen Recording permission (System Settings > Privacy &
# Security), or the capture comes out without the window's contents.
# Usage: app/scripts/screenshot.sh [out.png]
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-../web/assets/06-settings.png}"
TITLE="dev.localhost Settings"

./scripts/bundle.sh debug >/dev/null
WORK="$(mktemp -d)"
WINDOW_ID="$WORK/window-id"
SOCKET="$WORK/demo.sock"
swiftc -O scripts/window-id.swift -o "$WINDOW_ID" 2>/dev/null

node scripts/fake-server.mjs "$SOCKET" >/dev/null &
FAKE=$!
trap 'kill $FAKE 2>/dev/null || true; rm -rf "$WORK"' EXIT INT TERM
while [ ! -S "$SOCKET" ]; do sleep 0.1; done
DEV_LOCAL_DEMO=1 DEV_LOCAL_SOCKET="$SOCKET" DEV_LOCAL_DEMO_OPEN=clone:storefront \
    build/dev.localhost.app/Contents/MacOS/DevLocal -AppleInterfaceStyle Dark >/dev/null 2>&1 &
APP=$!
trap 'kill $APP $FAKE 2>/dev/null || true; rm -rf "$WORK"' EXIT INT TERM

# Up to 15 seconds for the window, then a moment for its first state to render
id=""
for _ in $(seq 1 30); do
    id="$("$WINDOW_ID" "$APP" "$TITLE" || true)"
    [ -n "$id" ] && break
    sleep 0.5
done
[ -n "$id" ] || { echo "screenshot: the Settings window never appeared" >&2; exit 1; }
sleep 2

# -o: no window shadow; the site adds its own (.screenshot in web/assets/style.css)
screencapture -x -o -l "$id" "$OUT"
echo "wrote $OUT"
