#!/bin/sh
# Builds dev.localhost and installs it to /Applications, for trying a real build without waiting on
# a release. Usage: app/scripts/install-local.sh [debug|release]
# release (the default) carries the server, so the installed app runs for real: nginx, your
# proxies, everything in ~/.dev.localhost. debug is the quicker build without that, for checking
# the app itself; it needs a server already running to attach to (see app/scripts/dev-app.sh).
set -eu
cd "$(dirname "$0")/.."
CONFIG="${1:-release}"
APP_NAME="dev.localhost"
DEST="/Applications/$APP_NAME.app"

./scripts/bundle.sh "$CONFIG"

# A running copy holds its single server process; quit it before replacing the bundle under it.
if pgrep -f "$DEST/Contents/MacOS/$APP_NAME" >/dev/null 2>&1; then
    osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
    sleep 2
fi

rm -rf "$DEST"
ditto "build/$APP_NAME.app" "$DEST"
echo "installed $DEST"
open "$DEST"
