#!/bin/sh
# Runs a debug build of the app the way an installed one runs: it starts the server itself, from
# the server folder `npm run dev` compiles (DEV_LOCAL_ROOT), so the menu shows your real apps.
# For the sample apps in .scripts/dev.proxies.json instead (screenshots, no nginx), use
# scripts/demo.sh.
set -eu
cd "$(dirname "$0")/.."
./scripts/bundle.sh debug >/dev/null
DEV_LOCAL_DEV=1 DEV_LOCAL_ROOT="$(cd ../server && pwd)" exec build/dev.localhost.app/Contents/MacOS/DevLocal
