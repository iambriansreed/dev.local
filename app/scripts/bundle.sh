#!/bin/sh
# Builds "build/dev.localhost.app". Usage: app/scripts/bundle.sh [debug|release]
# release is a universal, ad-hoc signed binary carrying the server in Contents/Resources/server,
# at the paths the server expects (see ROOT in nginx.ts). debug carries no server: demo mode
# talks to scripts/fake-server.mjs, and under `npm run dev` the app runs the server from the
# checkout (DEV_LOCAL_ROOT in scripts/dev-app.sh).
set -eu
cd "$(dirname "$0")/.."
CONFIG="${1:-debug}"
APP="build/dev.localhost.app"
ROOT="$(cd .. && pwd)"

case "$CONFIG" in
    release)
        swift build -c release --arch arm64 --arch x86_64
        BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/DevLocal"
        ;;
    debug)
        swift build -c debug
        BIN="$(swift build -c debug --show-bin-path)/DevLocal"
        ;;
    *)
        echo "usage: $0 [debug|release]" >&2
        exit 2
        ;;
esac

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/DevLocal"
cp Resources/Info.plist "$APP/Contents/Info.plist"
# Heart.svg is the About panel's credit heart (About.swift)
cp Resources/AppIcon.icns Resources/StatusIcon*.png Resources/Glyph-*.png Resources/Heart.svg \
    "$APP/Contents/Resources/"

if [ "$CONFIG" = debug ]; then
    echo "built $APP"
    exit 0
fi

# The server, compiled into the bundle with the 502 page nginx serves and the package file
# that makes its output ES modules.
SERVER="$APP/Contents/Resources/server"
mkdir -p "$SERVER"
"$ROOT/node_modules/.bin/tsc" -p "$ROOT/server/tsconfig.json" --outDir "$SERVER/dist"
cp -R "$ROOT/server/assets" "$SERVER/assets"
cp "$ROOT/server/package.json" "$SERVER/package.json"

codesign --force --sign - --deep "$APP"
echo "built $APP"
