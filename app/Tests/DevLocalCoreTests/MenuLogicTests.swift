import XCTest
@testable import DevLocalCore

// The menu as the mocks draw it (.plans/mocks/generate.mjs, `mainItems`).
final class MenuLogicTests: XCTestCase {
    private func proxy(
        _ name: String, port: Int, path: String? = "/Users/me/app", title: String? = nil,
        devRunning: Bool? = nil
    ) -> ProxyState {
        ProxyState(
            name: name, port: port, path: path, title: title, host: "\(name).localhost",
            provisioned: true, url: "https://\(name).localhost", devRunning: devRunning
        )
    }

    private func state(_ proxies: [ProxyState], nginxRunning: Bool = true) -> AppState {
        AppState(
            proxies: proxies,
            nginx: NginxState(installed: true, running: nginxRunning)
        )
    }

    private func items(_ entries: [MenuEntry]) -> [MenuItem] {
        entries.compactMap { if case let .item(item) = $0 { item } else { nil } }
    }

    private func find(_ entries: [MenuEntry], titled title: String) -> MenuItem? {
        items(entries).first { $0.title == title }
    }

    /// The top-level titles with "-" for separators, as the mock lists them.
    private func outline(_ entries: [MenuEntry]) -> [String] {
        entries.map { if case let .item(item) = $0 { item.title } else { "-" } }
    }

    // The whole menu, in the mock's order: nginx, running apps, Start App and New App, Settings, About and Quit.
    func testOrderMatchesTheMock() {
        let menu = buildMenu(MenuInput(state: state([
            proxy("storefront", port: 3000, title: "Storefront", devRunning: true),
            proxy("docs", port: 5173, title: "Docs", devRunning: false),
        ])))
        XCTAssertEqual(outline(menu), [
            "nginx running", "-", "Storefront", "-", "Start App", "New App…", "-", "Settings…", "About dev.localhost", "Quit dev.localhost",
        ])
    }

    // Without running apps there is no empty block and no doubled separator.
    func testNoRunningAppsLeavesNoEmptyBlock() {
        let menu = buildMenu(MenuInput(state: state([proxy("demo", port: 8080, devRunning: false)])))
        XCTAssertEqual(outline(menu), ["nginx running", "-", "Start App", "New App…", "-", "Settings…", "About dev.localhost", "Quit dev.localhost"])
    }

    func testIconsDotsAndKeysMatchTheMock() {
        let menu = buildMenu(MenuInput(state: state([proxy("storefront", port: 3000, title: "Storefront", devRunning: true)])))
        XCTAssertEqual(find(menu, titled: "nginx running")?.dot, .on)
        XCTAssertEqual(find(menu, titled: "Storefront")?.dot, .on)
        XCTAssertEqual(find(menu, titled: "Start App")?.glyph, .play)
        XCTAssertEqual(find(menu, titled: "New App…")?.glyph, .plus)
        XCTAssertNil(find(menu, titled: "Settings…")?.glyph, "Settings has no icon")
        XCTAssertEqual(find(menu, titled: "Settings…")?.key, ",")
        XCTAssertEqual(find(menu, titled: "About dev.localhost")?.action, .about)
        XCTAssertNil(find(menu, titled: "About dev.localhost")?.key, "About has no shortcut")
        XCTAssertNil(find(menu, titled: "Quit dev.localhost")?.glyph, "Quit has no icon")
        XCTAssertEqual(find(menu, titled: "Quit dev.localhost")?.key, "q")
    }

    // A running app opens in Chrome over https while nginx is up.
    func testRunningAppOpensInChromeWhenNginxIsUp() {
        let menu = buildMenu(MenuInput(state: state([proxy("shop", port: 3000, devRunning: true)])))
        XCTAssertEqual(find(menu, titled: "shop.localhost")?.action, .open(url: "https://shop.localhost", browser: .chrome))
    }

    // While nginx is stopped, the only URL that answers is the plain port, in the default browser.
    func testRunningAppOpensLocalPortInDefaultBrowserWhenNginxIsDown() {
        let menu = buildMenu(MenuInput(state: state([proxy("shop", port: 3000, devRunning: true)], nginxRunning: false)))
        XCTAssertEqual(find(menu, titled: "shop.localhost")?.action, .open(url: "http://localhost:3000", browser: .defaultBrowser))
    }

    // The title is the label and the host its grey detail; with no title the host is the label alone.
    func testTitleWithHostDetailAndHostAloneWithoutTitle() {
        let menu = buildMenu(MenuInput(state: state([
            proxy("docs", port: 5173, title: "Docs", devRunning: true),
            proxy("playground", port: 8081, devRunning: true),
        ])))
        XCTAssertEqual(find(menu, titled: "Docs")?.detail, "docs.localhost")
        XCTAssertNil(find(menu, titled: "playground.localhost")?.detail)
    }

    // The running app's submenu: Edit, Open, Clone, Log, then Stop below a separator.
    func testRunningSubmenuMatchesTheMock() {
        let menu = buildMenu(MenuInput(state: state([proxy("shop", port: 3000, devRunning: true)]), ownedNames: ["shop"]))
        let submenu = find(menu, titled: "shop.localhost")!.submenu!
        XCTAssertEqual(outline(submenu), ["Edit", "Open", "Clone", "Log", "-", "Stop"])
        XCTAssertEqual(items(submenu).map(\.glyph), [.edit, .code, .clone, .terminal, .stop])
        XCTAssertEqual(find(submenu, titled: "Edit")?.action, .edit(name: "shop"))
        XCTAssertEqual(find(submenu, titled: "Clone")?.action, .clone(name: "shop"))
    }

    // An app started by hand gets Show Log in the same place.
    func testShowLogForAnAppStartedByHand() {
        let menu = buildMenu(MenuInput(state: state([proxy("api", port: 3000, devRunning: true)]), owners: ["api": .iterm]))
        let submenu = find(menu, titled: "api.localhost")!.submenu!
        XCTAssertEqual(outline(submenu), ["Edit", "Open", "Clone", "Show Log", "-", "Stop"])
        XCTAssertEqual(find(submenu, titled: "Show Log")?.enabled, true)
    }

    // A hand-started app with no terminal found cannot be focused, so Show Log is disabled with why.
    func testShowLogIsDisabledWhenNoTerminalOwnsIt() {
        let menu = buildMenu(MenuInput(state: state([proxy("shop", port: 3000, devRunning: true)]), owners: ["shop": .none]))
        let showLog = find(find(menu, titled: "shop.localhost")!.submenu!, titled: "Show Log")
        XCTAssertEqual(showLog?.enabled, false)
        XCTAssertEqual(showLog?.tooltip, "Started outside a terminal")
    }

    // Start App lists only apps whose port is not answering, each with a hollow dot.
    func testStartAppListsOnlyStoppedApps() {
        let menu = buildMenu(MenuInput(state: state([
            proxy("up", port: 3000, devRunning: true),
            proxy("down", port: 3001, title: "Down", devRunning: false),
        ])))
        let children = items(find(menu, titled: "Start App")!.submenu!)
        XCTAssertEqual(children.map(\.title), ["Down"])
        XCTAssertEqual(children.first?.dot, .off)
        XCTAssertEqual(children.first?.detail, "down.localhost")
        XCTAssertEqual(children.first?.action, .start(name: "down"))
    }

    // An app with no app path is listed but disabled, with a tooltip saying why.
    func testStoppedAppWithoutPathIsDisabledWithTooltip() {
        let menu = buildMenu(MenuInput(state: state([proxy("blog", port: 3001, path: nil, title: "Old Blog", devRunning: false)])))
        let child = items(find(menu, titled: "Start App")!.submenu!).first!
        XCTAssertFalse(child.enabled)
        XCTAssertEqual(child.tooltip, noAppPathTooltip)
    }

    func testStartAppEmptyState() {
        let menu = buildMenu(MenuInput(state: state([proxy("up", port: 3000, devRunning: true)])))
        XCTAssertEqual(find(menu, titled: "Start App")?.submenu, [.item(MenuItem(title: "Every app is running", enabled: false))])
    }

    // Zero proxies loaded reads differently than zero proxies stopped: the first is what an
    // unloaded or empty state looks like, the second is what a real "all running" looks like.
    // A stuck fetch of the proxy list once looked exactly like "every app is running".
    func testStartAppWithNoProxiesAtAllSaysSo() {
        let menu = buildMenu(MenuInput(state: state([])))
        XCTAssertEqual(find(menu, titled: "Start App")?.submenu, [.item(MenuItem(title: "No apps added yet", enabled: false))])
    }

    // The live push overrides the state's snapshot of what is running, and of nginx.
    func testLivePushOverridesState() {
        let p = proxy("shop", port: 3000, devRunning: false)
        let live = LiveStatus(rev: 1, nginxRunning: false, dev: ["shop": true], procs: [])
        XCTAssertTrue(isRunning(p, live: live))
        XCTAssertFalse(isRunning(p, live: nil))
        XCTAssertEqual(outline(buildMenu(MenuInput(state: state([p]), live: live))).first, "nginx stopped")
    }

    // nginx: Log, then Stop when running (mock 09) or Start when stopped (mock 04).
    func testNginxSubmenuMatchesTheMocks() {
        let up = find(buildMenu(MenuInput(state: state([], nginxRunning: true))), titled: "nginx running")!
        let down = find(buildMenu(MenuInput(state: state([], nginxRunning: false))), titled: "nginx stopped")!
        XCTAssertEqual(outline(up.submenu!), ["Log", "-", "Stop"])
        XCTAssertEqual(outline(down.submenu!), ["Log", "-", "Start"])
        XCTAssertEqual(down.dot, .off)
    }

    // The menu opens on nginx: there is no machine setup to nag about above it.
    func testMenuStartsWithNginx() {
        XCTAssertEqual(outline(buildMenu(MenuInput(state: state([])))).first, "nginx running")
    }

    // A server the app started and lost offers a restart, and nothing else but Quit.
    func testServerDownOffersRestartOnly() {
        let menu = buildMenu(MenuInput(state: state([proxy("up", port: 3000, devRunning: true)]), serverDown: true))
        XCTAssertEqual(outline(menu), ["Server stopped · Restart", "-", "Quit dev.localhost"])
    }

    // Start and Stop leave the menu open, so the result can be watched arriving.
    func testStartAndStopKeepTheMenuOpen() {
        let menu = buildMenu(MenuInput(state: state([
            proxy("up", port: 3000, devRunning: true),
            proxy("down", port: 3001, devRunning: false),
        ])))
        let stop = find(find(menu, titled: "up.localhost")!.submenu!, titled: "Stop")
        let start = items(find(menu, titled: "Start App")!.submenu!).first
        let nginx = find(find(menu, titled: "nginx running")!.submenu!, titled: "Stop")
        XCTAssertEqual(stop?.keepsMenuOpen, true)
        XCTAssertEqual(start?.keepsMenuOpen, true)
        XCTAssertEqual(nginx?.keepsMenuOpen, true)
        XCTAssertEqual(find(menu, titled: "up.localhost")?.keepsMenuOpen, false)
    }

    // A row keeps its id while its title changes, so an open menu updates it in place.
    func testRowsKeepTheirIdsAcrossStateChanges() {
        let up = buildMenu(MenuInput(state: state([], nginxRunning: true)))
        let down = buildMenu(MenuInput(state: state([], nginxRunning: false)))
        XCTAssertEqual(items(up).first?.id, "nginx")
        XCTAssertEqual(items(down).first?.id, "nginx")
    }

    // Starting moves an app into the running section at once, loading, and out of Start App.
    func testStartingAppMovesToTheMainMenuLoading() {
        let menu = buildMenu(MenuInput(state: state([proxy("down", port: 3001, title: "Down", devRunning: false)]), starting: ["down"]))
        XCTAssertEqual(outline(menu), [
            "nginx running", "-", "Down", "-", "Start App", "New App…", "-", "Settings…", "About dev.localhost", "Quit dev.localhost",
        ])
        let row = find(menu, titled: "Down")!
        XCTAssertEqual(row.dot, .loading)
        XCTAssertEqual(row.detail, "Starting…")
        XCTAssertEqual(row.action, MenuAction.none, "nothing owns it yet, so there is no log to open")
        XCTAssertNil(row.submenu, "a starting app has no submenu")
        XCTAssertEqual(find(menu, titled: "Start App")?.submenu, [.item(MenuItem(title: "Every app is running", enabled: false))])
    }

    // An app the server started tees its output into a log, so that is what a loading row opens.
    func testStartingAppOwnedByTheServerOpensItsLog() {
        let row = find(buildMenu(MenuInput(state: state([proxy("down", port: 3001, title: "Down", devRunning: false)]), ownedNames: ["down"], starting: ["down"])), titled: "Down")!
        XCTAssertEqual(row.action, MenuAction.log(name: "down"))
    }

    // Once its port answers it is an ordinary running app, whatever the pending set still says.
    func testStartedAppStopsLoadingWhenItsPortAnswers() {
        let live = LiveStatus(rev: 1, nginxRunning: true, dev: ["down": true], procs: [])
        let row = find(buildMenu(MenuInput(state: state([proxy("down", port: 3001, title: "Down")]), live: live, starting: ["down"])), titled: "Down")!
        XCTAssertEqual(row.dot, .on)
        XCTAssertEqual(row.detail, "down.localhost")
    }

    // An app on its way down says so where Stop was.
    func testStoppingAppSaysSo() {
        let menu = buildMenu(MenuInput(state: state([proxy("up", port: 3000, devRunning: true)]), stopping: ["up"]))
        let submenu = find(menu, titled: "up.localhost")!.submenu!
        XCTAssertEqual(find(submenu, titled: "Stopping…")?.enabled, false)
        XCTAssertNil(find(submenu, titled: "Stop"))
    }

    // nginx's control says what it is doing until nginx has done it.
    func testNginxPendingSaysSo() {
        let menu = buildMenu(MenuInput(state: state([], nginxRunning: true), nginxPending: true))
        let control = find(menu, titled: "nginx running")!.submenu!.last
        XCTAssertEqual(control, .item(MenuItem(id: "nginx-control", title: "Stopping…", glyph: .stop, enabled: false, keepsMenuOpen: true)))
    }

    // Dev mode looks like the installed app, apart from one disabled line at the very bottom.
    func testDevModeAddsOneLineAtTheBottom() {
        let withIt = buildMenu(MenuInput(state: state([]), devMode: true))
        let withoutIt = buildMenu(MenuInput(state: state([]), devMode: false))
        XCTAssertEqual(withIt.last, .item(MenuItem(id: "dev-mode", title: "Dev Mode", enabled: false)))
        XCTAssertEqual(withoutIt.last, .item(MenuItem(title: "Quit dev.localhost", key: "q", action: .quit)))
        XCTAssertEqual(outline(withIt).first, "nginx running", "no header above nginx in either mode")
    }

    // Settings lists the running apps first, then everything else, each alphabetically by label
    // (title, or host when there is none), ignoring case and reading numbers as numbers.
    func testSettingsOrderIsRunningFirstThenAlphabetical() {
        let proxies = [
            proxy("zeta", port: 1, devRunning: false),
            proxy("docs", port: 2, title: "Docs", devRunning: true),
            proxy("app10", port: 3, devRunning: false),
            proxy("admin", port: 4, title: "admin console", devRunning: false),
            proxy("app2", port: 5, devRunning: false),
            proxy("storefront", port: 6, title: "Storefront", devRunning: true),
        ]
        XCTAssertEqual(settingsOrder(proxies, live: nil).map(\.label), [
            "Docs", "Storefront", "admin console", "app2.localhost", "app10.localhost", "zeta.localhost",
        ])
    }

    // The push decides what is running when there is one, as it does for the menu.
    func testSettingsOrderFollowsThePush() {
        let proxies = [proxy("a", port: 1, devRunning: true), proxy("b", port: 2, devRunning: false)]
        let live = LiveStatus(rev: 1, nginxRunning: true, dev: ["a": false, "b": true], procs: [])
        XCTAssertEqual(settingsOrder(proxies, live: live).map(\.name), ["b", "a"])
    }
}
