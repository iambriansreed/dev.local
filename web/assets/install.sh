#!/bin/sh
# Installs (or updates) dev.localhost: everything it needs, and the app.
#
#   sh <(curl -fsSL https://devlocal.iambrian.com/install.sh)
#
# Every step checks before it acts, so running it again is safe and is how you update. Each
# line says what it did or why it skipped.
#
# Environment, for testing without touching the real machine:
#   DEV_LOCAL_INSTALL_DIR   install the app somewhere other than /Applications
#   DEV_LOCAL_NO_OPEN=1     don't open the app afterwards
#   DEV_LOCAL_APP_ONLY=1    skip the machine setup (steps 2 to 6); just update the app
#   DEV_LOCAL_DRY_RUN=1     check everything, change nothing; each change is printed instead
#
#   sh install.sh --uninstall   quit the app, stop nginx, delete the app (keeps what it shares)
set -eu

REPO="iambriansreed/dev.local"
APP_NAME="dev.localhost"
INSTALL_DIR="${DEV_LOCAL_INSTALL_DIR:-/Applications}"
APP_PATH="$INSTALL_DIR/$APP_NAME.app"
# The app was called dev.local before; same bundle ID, so it is replaced rather than kept beside.
OLD_APP_PATH="$INSTALL_DIR/dev.local.app"
BUNDLE_ID="com.iambrian.dev-local"
DRY="${DEV_LOCAL_DRY_RUN:-}"
DIR="$HOME/.dev.localhost"

say() { printf '%s\n' "$*"; }
ok() { printf '  \342\234\223 %s\n' "$*"; }
skip() { printf '  - %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
fail() {
    printf 'dev.localhost install failed: %s\n' "$*" >&2
    exit 1
}

# Runs a command, or in dry-run mode prints it instead.
change() {
    if [ -n "$DRY" ]; then
        printf '  would run: %s\n' "$*"
    else
        "$@"
    fi
}

# The Homebrew binary, even when it is not on PATH (a fresh install, or a shell that never sourced it).
brew_bin() {
    for candidate in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

uninstall() {
    say "dev.localhost uninstaller"
    if [ -d "$APP_PATH" ] || [ -d "$OLD_APP_PATH" ]; then
        if pgrep -f "($APP_PATH|$OLD_APP_PATH)/Contents/MacOS/" >/dev/null 2>&1; then
            change osascript -e "tell application id \"$BUNDLE_ID\" to quit" || true
            sleep 2
        fi
        for app in "$APP_PATH" "$OLD_APP_PATH"; do
            [ -d "$app" ] || continue
            change rm -rf "$app"
            if [ -n "$DRY" ]; then ok "would remove $app"; else ok "removed $app"; fi
        done
    else
        skip "no app at $APP_PATH"
    fi
    master="$(pgrep -f "nginx: master process.*$DIR/nginx.conf" | head -1 || true)"
    if [ -n "$master" ]; then
        # A root master from an older setup needs sudo to be told to stop.
        if [ "$(ps -o user= -p "$master" | tr -d ' ')" = "root" ]; then
            change sudo nginx -s stop -c "$DIR/nginx.conf"
        else
            change nginx -s stop -c "$DIR/nginx.conf"
        fi
        if [ -n "$DRY" ]; then ok "would stop nginx"; else ok "stopped nginx"; fi
    fi
    say ""
    say "Left in place, because other tools may rely on them. Remove them yourself if you want:"
    say "  rm -rf $DIR                     (proxies, certificates, logs)"
    say "  brew uninstall nginx mkcert     (Homebrew packages)"
    say "  mkcert -uninstall               (the local certificate authority)"
    exit 0
}

case "${1:-}" in
    --uninstall) uninstall ;;
    "") ;;
    *) fail "unknown option: $1" ;;
esac

say "dev.localhost installer"
[ "$(uname -s)" = "Darwin" ] || fail "dev.localhost is a macOS app."
version="$(sw_vers -productVersion)"
major="$(echo "$version" | cut -d. -f1)"
[ "$major" -ge 14 ] || fail "dev.localhost needs macOS 14 or later (this Mac has $version)."
ok "macOS $version, $(uname -m)"

if [ -z "${DEV_LOCAL_APP_ONLY:-}" ]; then
    # 2. Homebrew.
    if BREW="$(brew_bin)"; then
        skip "Homebrew $("$BREW" --version | head -1 | awk '{print $2}') (already installed)"
    else
        change /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        BREW="$(brew_bin || echo /opt/homebrew/bin/brew)"
        ok "Homebrew installed"
    fi

    # 3. nginx and mkcert, never upgraded. nss only for Firefox, which mkcert needs for its trust store.
    for formula in nginx mkcert; do
        if "$BREW" list --formula "$formula" >/dev/null 2>&1; then
            skip "$formula $("$BREW" list --versions "$formula" | awk '{print $2}') (already installed)"
        else
            change "$BREW" install "$formula"
            ok "$formula installed"
        fi
    done
    if [ -d /Applications/Firefox.app ] && ! "$BREW" list --formula nss >/dev/null 2>&1; then
        change "$BREW" install nss
        ok "nss installed (Firefox is here)"
    fi

    # 4. The local certificate authority, trusted by the System keychain.
    if security find-certificate -a -c mkcert /Library/Keychains/System.keychain >/dev/null 2>&1; then
        skip "mkcert's local CA is trusted"
    else
        change mkcert -install
        ok "mkcert's local CA trusted"
    fi

    # 5. Node 24+, found through the login shell so nvm, fnm and Volta installs count.
    node_version="$("${SHELL:-/bin/zsh}" -ilc 'node -v' 2>/dev/null | tail -1 || true)"
    node_major="$(echo "$node_version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
    if [ -n "$node_major" ] && [ "$node_major" -ge 24 ]; then
        skip "Node $node_version (from your shell)"
    else
        change "$BREW" install node
        ok "Node installed with Homebrew"
    fi

    # 6. The root nginx from before: stop it, and give ~/.dev.localhost back to the user.
    master="$(pgrep -f "nginx: master process.*$DIR/nginx.conf" | head -1 || true)"
    if [ -n "$master" ] && [ "$(ps -o user= -p "$master" | tr -d ' ')" = "root" ]; then
        change sudo nginx -s stop -c "$DIR/nginx.conf"
        change sudo chown -R "$(id -un)" "$DIR"
        if [ -n "$DRY" ]; then ok "would stop the root nginx from an older setup and give $DIR back to you"; else ok "stopped the root nginx from an older setup; $DIR is yours again"; fi
    else
        skip "no root nginx from an older setup"
    fi
fi

# 7. The app: the latest release, verified, copied into place, and opened.
say "Finding the latest release..."
release="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" \
    || fail "could not read the latest release of $REPO. Is the repository public, with a release published?"
asset_info="$(printf '%s' "$release" | tr -d '\n' | sed 's/},{/}\n{/g' | grep '\.dmg"' | head -1)"
dmg_url="$(printf '%s' "$asset_info" | sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p')"
digest="$(printf '%s' "$asset_info" | sed -n 's/.*"digest": *"sha256:\([0-9a-f]*\)".*/\1/p')"
tag="$(printf '%s' "$release" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$dmg_url" ] || fail "the latest release has no .dmg."

if [ -n "$DRY" ]; then
    ok "would install dev.localhost $tag from $dmg_url"
    say ""
    say "dry run: nothing was changed."
    exit 0
fi

work="$(mktemp -d)"
mounted=""
cleanup() {
    if [ -n "$mounted" ]; then hdiutil detach -quiet "$mounted" 2>/dev/null || true; fi
    rm -rf "$work"
}
trap cleanup EXIT INT TERM

curl -fsSL -o "$work/dev.localhost.dmg" "$dmg_url"
if [ -n "$digest" ]; then
    actual="$(shasum -a 256 "$work/dev.localhost.dmg" | awk '{print $1}')"
    [ "$actual" = "$digest" ] || fail "the download's checksum does not match the release."
    ok "checksum verified"
fi

mounted="$(hdiutil attach -nobrowse -noautoopen -readonly "$work/dev.localhost.dmg" | sed -n 's|.*\(/Volumes/.*\)|\1|p' | tail -1)"
[ -d "$mounted/$APP_NAME.app" ] || fail "the disk image has no $APP_NAME.app."

# Quit a running copy, under either name: it is the same app (one bundle ID).
if pgrep -f "($APP_PATH|$OLD_APP_PATH)/Contents/MacOS/" >/dev/null 2>&1; then
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" 2>/dev/null || true
    sleep 2
fi
mkdir -p "$INSTALL_DIR"
rm -rf "$APP_PATH"
if [ -d "$OLD_APP_PATH" ]; then
    rm -rf "$OLD_APP_PATH"
    ok "removed $OLD_APP_PATH (the app's old name)"
fi
ditto "$mounted/$APP_NAME.app" "$APP_PATH"
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
ok "installed dev.localhost $tag to $INSTALL_DIR"

if [ -z "${DEV_LOCAL_NO_OPEN:-}" ]; then
    open "$APP_PATH"
fi
say "It's in your menu bar."
