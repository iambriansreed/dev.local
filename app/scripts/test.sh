#!/bin/sh
# swift test, with Testing.framework's path added on Command Line Tools-only setups.
set -eu
cd "$(dirname "$0")/.."
if [ "$(xcode-select -p)" = "/Library/Developer/CommandLineTools" ]; then
    exec swift test -Xswiftc -F/Library/Developer/CommandLineTools/Library/Developer/Frameworks \
        -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks "$@"
fi
exec swift test "$@"
