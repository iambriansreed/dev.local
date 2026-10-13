import Foundation

// The menu, as data. Nothing here touches AppKit: StatusMenu turns these entries into
// NSMenu items and AppDelegate carries out the actions. The layout follows the mocks
// (.plans/mocks/generate.mjs, `mainItems`), so every rule there is testable here.

public enum Browser: Equatable, Sendable {
    /// Google Chrome, the browser the apps are opened in.
    case chrome
    /// Whatever the system opens http URLs in. Used while nginx is down, when only the
    /// plain `http://localhost:PORT` answers.
    case defaultBrowser
}

public enum MenuAction: Equatable, Sendable {
    case none
    case open(url: String, browser: Browser)
    case start(name: String)
    case stop(name: String)
    /// Terminal opens the log the server tees this app's output into.
    case log(name: String)
    /// Focus the terminal tab or window that runs an app the server did not start.
    case showLog(name: String)
    case nginxLog
    case nginxStart
    case nginxStop
    /// Starts the dev.localhost server again after it stopped unexpectedly.
    case restartServer
    case edit(name: String)
    case openEditor(name: String)
    case clone(name: String)
    case newApp
    case settings
    /// The standard About panel: name, version, copyright and Credits.rtf.
    case about
    case quit
}

/// The menu's glyphs (app/scripts/glyphs.mjs), drawn as template images.
public enum Glyph: String, Equatable, Sendable, CaseIterable {
    case edit, code, clone, terminal, play, stop, plus, gear, power, warning
}

/// The status light at the head of a row: green and filled when up, grey and hollow when not,
/// and a spinning arc while an app is on its way up.
public enum Dot: Equatable, Sendable {
    case on
    case off
    case loading
}

public struct MenuItem: Equatable, Sendable {
    /// What this row is, kept the same while its title or state changes ("nginx", "app:<name>"),
    /// so an open menu can update the row in place rather than replace it.
    public var id: String
    public var title: String
    /// Shown grey and right-aligned (an app's host).
    public var detail: String?
    public var glyph: Glyph?
    public var dot: Dot?
    /// A key equivalent, held with Command: "," for Settings, "q" for Quit.
    public var key: String?
    public var enabled: Bool
    public var tooltip: String?
    public var action: MenuAction
    public var submenu: [MenuEntry]?
    /// Clicking it runs its action and leaves the menu open (Start and Stop), so the result
    /// can be watched arriving.
    public var keepsMenuOpen: Bool

    public init(
        id: String? = nil, title: String, detail: String? = nil, glyph: Glyph? = nil, dot: Dot? = nil,
        key: String? = nil, enabled: Bool = true, tooltip: String? = nil, action: MenuAction = .none,
        submenu: [MenuEntry]? = nil, keepsMenuOpen: Bool = false
    ) {
        self.id = id ?? title
        self.keepsMenuOpen = keepsMenuOpen
        self.title = title
        self.detail = detail
        self.glyph = glyph
        self.dot = dot
        self.key = key
        self.enabled = enabled
        self.tooltip = tooltip
        self.action = action
        self.submenu = submenu
    }
}

public enum MenuEntry: Equatable, Sendable {
    case item(MenuItem)
    case separator
}

/// Everything the menu decides from.
public struct MenuInput: Sendable {
    public var state: AppState
    /// The latest push. Nil until the first one arrives, in which case `devRunning` from
    /// the state is used.
    public var live: LiveStatus?
    /// Running from `npm run dev`. The menu looks like the installed app either way; this only
    /// adds a small marker at the bottom, so dev mode stays a close approximation of the real thing.
    public var devMode: Bool
    /// Process names the server started, from `live.procs`.
    public var ownedNames: Set<String>
    /// Owner of each hand-started app, by proxy name. Missing means not looked up yet.
    public var owners: [String: OwnerKind]
    /// The server this app started has stopped. The menu then offers to start it again.
    public var serverDown: Bool
    /// Apps asked to start or stop whose ports have not changed yet, and the same for nginx.
    public var starting: Set<String>
    public var stopping: Set<String>
    public var nginxPending: Bool

    public init(
        state: AppState, live: LiveStatus? = nil, devMode: Bool = false,
        ownedNames: Set<String> = [],
        owners: [String: OwnerKind] = [:], serverDown: Bool = false,
        starting: Set<String> = [], stopping: Set<String> = [], nginxPending: Bool = false
    ) {
        self.starting = starting
        self.stopping = stopping
        self.nginxPending = nginxPending
        self.state = state
        self.live = live
        self.devMode = devMode
        self.ownedNames = ownedNames
        self.owners = owners
        self.serverDown = serverDown
    }
}

public let noAppPathTooltip = "Add an app path (via Edit) to start the dev server from here"

/// Whether a proxy's dev server is answering. The live push wins once it has arrived.
public func isRunning(_ proxy: ProxyState, live: LiveStatus?) -> Bool {
    if let live, let up = live.dev[proxy.name] { return up }
    return proxy.devRunning ?? false
}

/// The order Settings lists the apps in: running first, then the rest, each alphabetically by
/// label as Finder sorts names (case ignored, `app2` before `app10`), the host breaking a tie.
public func settingsOrder(_ proxies: [ProxyState], live: LiveStatus?) -> [ProxyState] {
    proxies.sorted { a, b in
        let (upA, upB) = (isRunning(a, live: live), isRunning(b, live: live))
        if upA != upB { return upA }
        let byLabel = a.label.localizedStandardCompare(b.label)
        if byLabel != .orderedSame { return byLabel == .orderedAscending }
        return a.host.localizedStandardCompare(b.host) == .orderedAscending
    }
}

/// Whether nginx is up, from the push when there is one.
public func nginxIsRunning(_ input: MenuInput) -> Bool {
    input.live?.nginxRunning ?? input.state.nginx.running
}

/// The menu, top to bottom.
public func buildMenu(_ input: MenuInput) -> [MenuEntry] {
    var entries: [MenuEntry] = []

    if input.serverDown {
        entries.append(.item(MenuItem(title: "Server stopped · Restart", glyph: .warning, action: .restartServer)))
        entries.append(.separator)
        entries.append(.item(MenuItem(title: "Quit dev.localhost", key: "q", action: .quit)))
        return entries
    }

    entries.append(.item(nginxItem(
        running: nginxIsRunning(input), installed: input.state.nginx.installed, pending: input.nginxPending
    )))
    entries.append(.separator)

    // An app asked to start joins the running ones at once, loading, rather than waiting in
    // Start App until its port answers.
    let up = { (p: ProxyState) in isRunning(p, live: input.live) || input.starting.contains(p.name) }
    let running = input.state.proxies.filter(up)
    let stopped = input.state.proxies.filter { !up($0) }
    if !running.isEmpty {
        for proxy in running { entries.append(.item(runningItem(proxy, input))) }
        entries.append(.separator)
    }

    entries.append(.item(startAppItem(stopped, totalApps: input.state.proxies.count, starting: input.starting)))
    entries.append(.item(MenuItem(title: "New App…", glyph: .plus, action: .newApp)))
    entries.append(.separator)
    entries.append(.item(MenuItem(title: "Settings…", key: ",", action: .settings)))
    entries.append(.item(MenuItem(title: "About dev.localhost", action: .about)))
    entries.append(.item(MenuItem(title: "Quit dev.localhost", key: "q", action: .quit)))
    if input.devMode {
        entries.append(.item(MenuItem(id: "dev-mode", title: "Dev Mode", enabled: false)))
    }
    return entries
}

/// The host, shown beside the label only when the label is a title: a proxy with no title
/// is already labelled with its host, and saying it twice tells nobody anything.
func detail(for proxy: ProxyState) -> String? {
    proxy.label == proxy.host ? nil : proxy.host
}

/// The nginx row: the status and the control in one, its submenu holding Log, then Stop or Start.
/// The control keeps the menu open, and says what it is doing until nginx has done it.
func nginxItem(running: Bool, installed: Bool, pending: Bool = false) -> MenuItem {
    let control: MenuItem
    if pending {
        control = MenuItem(
            id: "nginx-control", title: running ? "Stopping…" : "Starting…", glyph: running ? .stop : .play,
            enabled: false, keepsMenuOpen: true
        )
    } else if running {
        control = MenuItem(id: "nginx-control", title: "Stop", glyph: .stop, action: .nginxStop, keepsMenuOpen: true)
    } else {
        control = MenuItem(
            id: "nginx-control", title: "Start", glyph: .play, enabled: installed,
            tooltip: installed ? nil : "Install nginx first: brew install nginx", action: .nginxStart,
            keepsMenuOpen: true
        )
    }
    return MenuItem(
        id: "nginx",
        title: running ? "nginx running" : "nginx stopped",
        dot: running ? .on : .off,
        submenu: [
            .item(MenuItem(title: "Log", glyph: .terminal, action: .nginxLog)),
            .separator,
            .item(control),
        ]
    )
}

/// One app that is answering. Clicking it opens it; its submenu is Edit, Open, Clone, Log
/// (or Show Log), then Stop below a separator.
func runningItem(_ proxy: ProxyState, _ input: MenuInput) -> MenuItem {
    // Loading until its port answers: nothing to open yet, and the host says what is happening.
    let loading = input.starting.contains(proxy.name) && !isRunning(proxy, live: input.live)

    let log: MenuItem
    if input.ownedNames.contains(proxy.name) {
        log = MenuItem(title: "Log", glyph: .terminal, action: .log(name: proxy.name))
    } else {
        let owner = input.owners[proxy.name]
        let canFocus = owner != nil && owner != OwnerKind.none
        log = MenuItem(
            title: "Show Log", glyph: .terminal, enabled: canFocus,
            tooltip: canFocus ? nil : "Started outside a terminal", action: .showLog(name: proxy.name)
        )
    }
    let hasPath = proxy.path != nil

    // While it loads there is nothing to open, but its log is the useful thing to look at.
    let action: MenuAction
    if loading {
        action = log.enabled ? log.action : .none
    } else if nginxIsRunning(input) {
        action = .open(url: "https://\(proxy.host)", browser: .chrome)
    } else {
        action = .open(url: "http://localhost:\(proxy.port)", browser: .defaultBrowser)
    }

    return MenuItem(
        id: "app:\(proxy.name)",
        title: proxy.label,
        detail: loading ? "Starting…" : detail(for: proxy),
        dot: loading ? .loading : .on,
        action: action,
        // Nothing else to act on until it is up: the row says it is starting and opens its log.
        submenu: loading ? nil : [
            .item(MenuItem(title: "Edit", glyph: .edit, action: .edit(name: proxy.name))),
            .item(MenuItem(
                title: "Open", glyph: .code, enabled: hasPath,
                tooltip: hasPath ? "Open \(proxy.path!) in VS Code" : "Add an app path (via Edit) to open this project in VS Code",
                action: .openEditor(name: proxy.name)
            )),
            .item(MenuItem(title: "Clone", glyph: .clone, action: .clone(name: proxy.name))),
            .item(log),
            .separator,
            .item(input.stopping.contains(proxy.name)
                ? MenuItem(id: "stop:\(proxy.name)", title: "Stopping…", glyph: .stop, enabled: false, keepsMenuOpen: true)
                : MenuItem(id: "stop:\(proxy.name)", title: "Stop", glyph: .stop, action: .stop(name: proxy.name), keepsMenuOpen: true)),
        ]
    )
}

/// The Start App submenu: every app whose port is not answering. Empty state is one disabled line.
/// Each row starts its app and keeps the menu open; a row whose app is on its way up says so.
func startAppItem(_ stopped: [ProxyState], totalApps: Int, starting: Set<String> = []) -> MenuItem {
    let children: [MenuEntry]
    if stopped.isEmpty {
        // These read the same when nothing has loaded yet as when every app genuinely is
        // running, which is exactly how a stuck fetch of the proxy list went unnoticed once.
        // Telling them apart costs nothing: zero proxies loaded is never "every app is running".
        let title = totalApps == 0 ? "No apps added yet" : "Every app is running"
        children = [.item(MenuItem(title: title, enabled: false))]
    } else {
        children = stopped.map { proxy in
            let hasPath = proxy.path != nil
            if starting.contains(proxy.name) {
                return .item(MenuItem(
                    id: "start:\(proxy.name)", title: proxy.label, detail: "Starting…", dot: .off,
                    enabled: false, keepsMenuOpen: true
                ))
            }
            return .item(MenuItem(
                id: "start:\(proxy.name)",
                title: proxy.label,
                detail: detail(for: proxy),
                dot: .off,
                enabled: hasPath,
                tooltip: hasPath ? nil : noAppPathTooltip,
                action: hasPath ? .start(name: proxy.name) : .none,
                keepsMenuOpen: true
            ))
        }
    }
    return MenuItem(id: "start-app", title: "Start App", glyph: .play, submenu: children)
}
