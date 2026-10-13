# dev.localhost

A menu bar app for your local dev servers. It turns any `http://localhost:PORT` into a tidy
`https://name.localhost` domain, starts and stops the dev servers behind them from the menu,
and keeps each one's output in a log you can open. nginx runs as you, with no password prompt.

Install with one command:

```sh
sh <(curl -fsSL https://devlocal.iambrian.com/install.sh)
```

The installer sets up Homebrew, nginx and mkcert, stops the root nginx from an older setup,
and installs the app to `/Applications`. Run it again to update. Requires macOS 14 or later.
The website is at https://devlocal.iambrian.com.

## Layout

```
app/        the menu bar app (Swift package): DevLocalCore (testable logic) and DevLocal (the UI)
server/     the Node server behind the app: nginx, dev servers, logs, a JSON API (zero dependencies)
web/        the website (a Skrapa root), including web/assets/install.sh
.scripts/   the dev loop, the sample apps for screenshots (dev.proxies.json), and release tooling
.github/    CI, release and deploy workflows
```

## Commands

Run from the repository root.

```sh
npm install                 # once: the pinned tools (TypeScript, tsx, Skrapa for the website)
npm run dev                 # the menu bar app running the server as an installed one does, and the website, all rebuilt on save
npm run dev:server          # the server's dev loop alone (tsc watches, the server restarts)
npm start                   # compile the server and run it in this terminal
npm run build               # the server (server/dist) and the website (web/dist)
npm run test:server         # the server's unit tests
npm run test:scripts        # the release tooling's tests
npm run typecheck           # type-check .scripts (TypeScript, run uncompiled by tsx or Node)
app/scripts/test.sh         # the Swift core tests
app/scripts/demo.sh         # the menu bar app against a fake server with the sample apps, no nginx or sudo
app/scripts/bundle.sh       # build/dev.localhost.app (debug, or "release" for a universal build)
app/scripts/install-local.sh # build and install to /Applications, for trying a real build
app/scripts/make-dmg.sh     # build/dev.localhost-<version>.dmg
app/scripts/make-icons.sh   # regenerate the icons from app/Resources/AppIcon.svg and StatusIcon.svg
app/scripts/screenshot.sh   # the website's Settings screenshot, taken from the app in demo mode
```

The menu bar app runs the server itself, `npm run dev` included. With `npm run dev:server` or
`npm start` in a terminal, the app attaches to that server instead of starting its own.

`npm run dev` shows your real apps. For screenshots, `demo.sh` shows the sample apps in
`.scripts/dev.proxies.json` instead; the website's screenshots use the same ones.

## Versions

`app/Resources/Info.plist` is where the version is set. `.scripts/version.ts --check` fails when
`package.json` or `web/version.json` disagree with it, and CI runs that check.

## Releasing

Push to `main`. The release workflow tests, lets the Conventional Commits since the last tag pick
the version, builds the `.dmg`, publishes the GitHub release, and deploys the website. Enable the
commit check once per clone with `git config core.hooksPath .scripts/hooks`.

## Data

Everything dev.localhost keeps is under `~/.dev.localhost`: the proxy list (`proxies.json`), the
generated nginx config, certificates and logs. Apps' output is in `logs/apps/`, and the
`.command` files in that folder are what Terminal runs for Log.

The app talks to its server over `~/.dev.localhost/server.sock`, a Unix socket only you can open,
rather than a port, so no web page can reach the API. To poke at it by hand:
`curl --unix-socket ~/.dev.localhost/server.sock http://localhost/api/state`.

## License

[Apache-2.0](LICENSE). Copyright 2026 Brian Reed. Redistributions and forks must keep
the [NOTICE](NOTICE) file.
