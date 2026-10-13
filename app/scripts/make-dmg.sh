#!/bin/sh
# Packs build/dev.localhost.app into build/dev.localhost-<version>.dmg, with an Applications link.
set -eu
cd "$(dirname "$0")/.."
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Resources/Info.plist)"
DMG="build/dev.localhost-$VERSION.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R build/dev.localhost.app "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname "dev.localhost $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
echo "wrote $DMG"
