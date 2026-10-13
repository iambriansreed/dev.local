#!/bin/sh
# Runs the app in demo mode, with the sample apps in .scripts/dev.proxies.json: a fake server
# (scripts/fake-server.mjs) answers the API and the live socket, so the menu and the Settings
# window can be used with no nginx, no sudo and no dev servers. Usage: app/scripts/demo.sh [debug|release]
set -eu
cd "$(dirname "$0")/.."
PORT="${DEV_LOCAL_PORT:-7979}"

./scripts/bundle.sh "${1:-debug}" >/dev/null

node scripts/fake-server.mjs "$PORT" &
FAKE=$!
trap 'kill $FAKE 2>/dev/null || true' EXIT INT TERM

# Not exec: the trap has to outlive the app to stop the fake server.
DEV_LOCAL_DEMO=1 DEV_LOCAL_PORT="$PORT" build/dev.localhost.app/Contents/MacOS/DevLocal
