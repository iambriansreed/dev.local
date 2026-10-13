import { GitHubLink, REPO_URL } from './components/github-link';
import { SiteFooter } from './components/site-footer';
// The app's version: a generated copy of CFBundleShortVersionString in
// app/Resources/Info.plist, kept in step by .scripts/version.ts and checked by CI before
// every deploy, so it's never typed here.
import { version } from './version.json';

const RELEASE_URL = `${REPO_URL}/releases/latest`;
/** web/assets/install.sh, which the site serves at its root */
const INSTALL_COMMAND = 'sh <(curl -fsSL https://devlocal.iambrian.com/install.sh)';
/** The same script's source on GitHub, with history, for anyone reading before running */
const INSTALL_SCRIPT_URL = `${REPO_URL}/blob/main/web/assets/install.sh`;
const BUILD_COMMAND = `git clone ${REPO_URL}.git && cd dev.local && npm install && app/scripts/bundle.sh release && app/scripts/make-dmg.sh`;

/** A shell command with a Copy button (see copy.ts). */
function Command({ children }: Skrapa.PropsWithChildren) {
    return (
        <div class="code-block">
            <pre>
                <code>{children}</code>
            </pre>
            <button class="copy-btn" type="button">
                Copy
            </button>
        </div>
    );
}

export function Page(): Skrapa.Page {
    return (
        <>
            <header class="nav">
                <a href="./" class="brand">
                    <img src="logo.svg" alt="" width="28" height="28" />
                    dev.localhost
                </a>
                <nav>
                    <a href="development/">Development</a>
                    <GitHubLink />
                </nav>
            </header>

            <section class="hero">
                <h1>Your dev servers, in your menu bar</h1>
                <p class="tagline">
                    dev.localhost is a small, native Mac app. Every local app gets a tidy{' '}
                    <code>https://name.localhost</code> address, and starting, stopping and reading its
                    log is one click away.
                </p>
                <img
                    class="hero-shot"
                    src="01-menu-running.svg"
                    alt="The dev.localhost menu: nginx running, Storefront and Northwind running with their hosts, and Storefront's submenu with Edit, Open, Clone, Log and Stop"
                    width="580"
                    height="280"
                />
            </section>

            <section class="install" id="install">
                <h2>Install</h2>
                <div class="tabs" role="tablist" aria-label="How to install">
                    <button class="tab" type="button" role="tab" id="tab-bash" aria-controls="panel-bash" aria-selected="true">
                        Bash
                    </button>
                    <button class="tab" type="button" role="tab" id="tab-manual" aria-controls="panel-manual" aria-selected="false" tabindex="-1">
                        Manual
                    </button>
                </div>
                <div class="tab-panel" role="tabpanel" id="panel-bash" aria-labelledby="tab-bash">
                    <Command>{INSTALL_COMMAND}</Command>
                    <p class="sub">
                        Installs what dev.localhost needs (Homebrew, nginx, mkcert and Node, whichever are
                        missing) and installs the latest release. Read{' '}
                        <a href={INSTALL_SCRIPT_URL} target="_blank" rel="noopener">
                            the script
                        </a>{' '}
                        first if you like. Run it again any time to update.
                    </p>
                </div>
                <div class="tab-panel" role="tabpanel" id="panel-manual" aria-labelledby="tab-manual" hidden>
                    <a class="btn btn-primary" href={RELEASE_URL}>
                        Download dev.localhost {version}
                    </a>
                    <div class="prose">
                        <ol>
                            <li>
                                Install nginx and mkcert with Homebrew (<code>brew install nginx mkcert</code>
                                ), then run <code>mkcert -install</code> once. dev.localhost also needs Node 24 or
                                later.
                            </li>
                            <li>
                                Open the downloaded <code>.dmg</code> and drag dev.localhost into Applications.
                            </li>
                            <li>
                                The app isn't notarized by Apple, so macOS blocks it the first time. Run this,
                                then open the app again:
                                <Command>xattr -dr com.apple.quarantine "/Applications/dev.localhost.app"</Command>
                            </li>
                        </ol>
                    </div>
                </div>
            </section>

            <section class="build-locally">
                <h2>Build from source</h2>
                <p class="lede">Requires macOS 14, Xcode or just the Command Line Tools, and Node 24.</p>
                <Command>{BUILD_COMMAND}</Command>
                <p class="sub">
                    The installer is written to <code>dev.local/app/build/dev.localhost-&lt;version&gt;.dmg</code>. The{' '}
                    <a href="development/">development guide</a> covers the other scripts.
                </p>
            </section>

            <section class="usage" id="guide">
                <h2>Using dev.localhost</h2>
                <div class="usage-layout">
                    <div class="prose">
                        <h3>Your apps</h3>
                        <p>
                            Everything that is running sits at the top of the menu, with a green light, its
                            title and its address. Click one to open it in Chrome. Its submenu edits it,
                            opens its folder in VS Code, clones it as the start of a new app, shows its log,
                            and, last, stops it.
                        </p>
                        <p>
                            <strong>Start App</strong> lists everything that isn't running. Pick one and its
                            dev server starts in its folder, with its own command (<code>npm run dev</code>{' '}
                            unless you set another). An app with no folder set is listed but greyed out;
                            point at it to see why.
                        </p>
                        <img
                            class="screenshot"
                            src="02-menu-start-app.svg"
                            alt="The Start App submenu: stopped apps with their hosts, and Old Blog greyed out with the tooltip Add an app path (via Edit) to start the dev server from here"
                            width="700"
                            height="320"
                            loading="lazy"
                            decoding="async"
                        />

                        <h3>Logs</h3>
                        <p>
                            <strong>Log</strong> opens Terminal on the app's output, colours and all, and
                            keeps following it across restarts. Closing the window stops the tail, never the
                            app. For an app you started yourself in a terminal, the item is{' '}
                            <strong>Show Log</strong>, and it brings that exact Terminal or iTerm2 tab (or
                            VS Code window) to the front.
                        </p>
                        <img
                            class="screenshot"
                            src="07-log-terminal.svg"
                            alt="Terminal following a dev server's output"
                            width="940"
                            height="380"
                            loading="lazy"
                            decoding="async"
                        />

                        <h3>nginx</h3>
                        <p>
                            The first row says whether nginx is running, and its submenu holds its log and the
                            switch. Stopping nginx leaves your dev servers running: their{' '}
                            <code>https</code> addresses stop answering, and clicking an app opens{' '}
                            <code>http://localhost:PORT</code> instead. nginx runs as you, so starting and
                            stopping it never asks for a password.
                        </p>
                        <img
                            class="screenshot"
                            src="04-menu-nginx-stopped.svg"
                            alt="nginx stopped, its submenu offering Log and Start, with the apps still listed"
                            width="540"
                            height="260"
                            loading="lazy"
                            decoding="async"
                        />

                        <h3>Adding apps</h3>
                        <p>
                            <strong>New App…</strong> opens Settings with the form ready: a title, the domain
                            (a bare name becomes <code>name.localhost</code>), the port your dev server uses,
                            its folder and its command. <strong>Clone</strong> fills the same form from an
                            existing app under a free name.
                        </p>
                        <p>
                            Any <code>.localhost</code> name works with nothing else to set up. A domain of
                            your own, like <code>local.api.example.com</code>, needs a line in{' '}
                            <code>/etc/hosts</code>. Saving one that has no line yet opens Terminal right
                            away, which shows the exact lines it will change and then asks for your Mac
                            password, since <code>/etc/hosts</code> belongs to the system. Until the line is
                            there, its row says <strong>Fix hosts entry</strong>, which opens the same
                            Terminal again.
                        </p>

                        <h3>Running from a terminal</h3>
                        <p>
                            If you already run the dev.localhost server from a terminal, the app attaches to it
                            instead of starting its own, and quitting the app leaves it running.
                        </p>
                    </div>
                    <img
                        class="screenshot"
                        src="06-settings-new-app.svg"
                        alt="The Settings window: the new app form filled in from Clone, and the apps with their titles, addresses, ports and folders"
                        width="1000"
                        height="690"
                        loading="lazy"
                        decoding="async"
                    />
                </div>
            </section>

            <SiteFooter />
        </>
    );
}
