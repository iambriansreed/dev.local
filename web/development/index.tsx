import { GitHubLink, REPO_URL } from '../components/github-link';
import { SiteFooter } from '../components/site-footer';

const SETUP_COMMAND = `git clone ${REPO_URL}.git && cd dev.local && npm install`;

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
                    <a href="./">Home</a>
                    <GitHubLink />
                </nav>
            </header>

            <div class="center">
                <h1>Development</h1>
                <div class="prose">
                    <h2>Prerequisites</h2>
                    <ul>
                        <li>macOS 14 or later. The app is AppKit and runs nowhere else.</li>
                        <li>
                            Xcode, or just the Command Line Tools, with Swift 6 or later. The app is a Swift
                            package built by scripts; there is no Xcode project.
                        </li>
                        <li>Node.js 24 or later, for the server and this website.</li>
                        <li>nginx and mkcert from Homebrew, to run the real server.</li>
                    </ul>

                    <h2>Setup</h2>
                    <Command>{SETUP_COMMAND}</Command>
                    <p>
                        The repository holds three subprojects: the Swift app in <code>app/</code>, the
                        server behind it in <code>server/</code>, and this website in{' '}
                        <code>web/</code>. One <code>package.json</code> at the root holds the tools for all
                        of them. Every command below runs from the repository root.
                    </p>

                    <h2>Running it</h2>
                    <Command>npm run dev</Command>
                    <p>
                        Starts the menu bar app, which runs the server as an installed one does, and this
                        website. The menu and the Settings window show your real apps: the server manages
                        nginx and your dev servers through <code>~/.dev.localhost</code>, and its log is
                        followed in the terminal. A change under <code>app/</code> or to the server's code
                        rebuilds and restarts the app (and the server with it), and this site reloads on
                        save.
                    </p>
                    <Command>app/scripts/demo.sh</Command>
                    <p>
                        The app against a stand-in server (<code>app/scripts/fake-server.mjs</code>) with the
                        sample apps in <code>.scripts/dev.proxies.json</code>, for screenshots. It never touches nginx, sudo or your own apps.
                    </p>

                    <h2>Testing</h2>
                    <Command>npm run test:server && npm run test:scripts && npm run typecheck && app/scripts/test.sh</Command>
                    <p>
                        The server's pure logic, the release tooling and its types, and the app's
                        testable core (<code>DevLocalCore</code>: the menu, the form's rules, the
                        parsers).
                    </p>

                    <h2>Building</h2>
                    <Command>app/scripts/bundle.sh release && app/scripts/make-dmg.sh</Command>
                    <p>
                        A universal, ad-hoc signed <code>app/build/dev.localhost.app</code> carrying the server,
                        then <code>app/build/dev.localhost-&lt;version&gt;.dmg</code>.{' '}
                        <code>app/scripts/make-icons.sh</code> regenerates the icons.
                    </p>

                    <h2>Commits and releasing</h2>
                    <p>
                        Commits follow Conventional Commits; enable the check once per clone with{' '}
                        <code>git config core.hooksPath .scripts/hooks</code>. A push to <code>main</code>{' '}
                        tests, lets the commits since the last tag pick the version, builds the{' '}
                        <code>.dmg</code>, publishes the GitHub release, and deploys this site.
                    </p>

                    <h2>How it works</h2>
                    <p>
                        The menu bar app starts the Node server as a child process, or attaches to one a
                        terminal already started, and talks to it over HTTP and a WebSocket. The server
                        writes nginx's config, runs nginx as you, starts dev servers and keeps their output
                        in <code>~/.dev.localhost/logs/apps/</code>, which is what Log opens. Settings is a
                        native window on the same API. Only writes to <code>/etc/hosts</code> need root. The
                        server never runs <code>sudo</code>: it stages the new file, and the app opens a
                        Terminal script that shows the change and asks for your Mac password.
                    </p>
                </div>
            </div>

            <SiteFooter />
        </>
    );
}
