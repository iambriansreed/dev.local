#!/bin/sh
# Runs the app in demo mode, with the sample apps in .scripts/dev.proxies.json: a fake server
# (scripts/fake-server.mjs) answers the API and the live push on a socket of its own, so the
# menu and the Settings window can be used with no nginx, no sudo and no dev servers, beside a
# real dev.localhost. Usage: app/scripts/demo.sh [debug|release]
set -eu
cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"
SOCKET="${DEV_LOCAL_SOCKET:-$WORK/demo.sock}"

./scripts/bundle.sh "${1:-debug}" >/dev/null

node scripts/fake-server.mjs "$SOCKET" &
FAKE=$!
trap 'kill $FAKE 2>/dev/null || true; rm -rf "$WORK"' EXIT INT TERM
while [ ! -S "$SOCKET" ]; do sleep 0.1; done

# Not exec: the trap has to outlive the app to stop the fake server.
DEV_LOCAL_DEMO=1 DEV_LOCAL_SOCKET="$SOCKET" build/dev.localhost.app/Contents/MacOS/DevLocal
