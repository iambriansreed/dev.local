import AppKit
import DevLocalCore

/// Wires the server, the model, the menu and the Settings window together. The model holds
/// the state and runs every action; the menu reads from it and the Settings window observes it.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusMenu = StatusMenu()
    private let feed = LiveFeed()
    private var model: AppsModel!
    private var server: ServerHost?
    private var settings: SettingsWindowController!
    private var resolving: Set<String> = []
    private var loginPath = ""
    private var demo = false
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        loginPath = Setup.loginPath()
        demo = ProcessInfo.processInfo.environment["DEV_LOCAL_DEMO"] != nil
        installEditMenu()

        model = AppsModel(api: API(), feed: feed)
        model.onChange = { [weak self] in self?.changed() }
        settings = SettingsWindowController(model: model)

        if let root = serverRoot() {
            let host = ServerHost(root: root, loginPath: loginPath)
            host.onChange = { [weak self] state in self?.serverChanged(state) }
            server = host
        }
        statusMenu.input = { [weak self] in self?.menuInput() ?? MenuInput(state: .empty) }
        statusMenu.onAction = { [weak self] action in self?.perform(action) }
        feed.onConnectionChange = { [weak self] _ in self?.refreshIcon() }

        server?.start()
        feed.start()
        Task {
            await model.refresh()
            if demo { openForScreenshot() }
        }
        stopServerOnSignal()
    }

    /// Demo mode only: DEV_LOCAL_DEMO_OPEN opens a window at launch, so app/scripts/screenshot.sh
    /// can capture it without clicking through the menu. `settings`, `new`, or `clone:<name>`.
    private func openForScreenshot() {
        guard let open = ProcessInfo.processInfo.environment["DEV_LOCAL_DEMO_OPEN"] else { return }
        if open == "settings" {
            perform(.settings)
        } else if open == "new" {
            perform(.newApp)
        } else if open.hasPrefix("clone:") {
            perform(.clone(name: String(open.dropFirst("clone:".count))))
        }
    }

    /// SIGTERM and SIGINT (what `npm run dev` sends when it restarts or stops the app) end the
    /// process without applicationWillTerminate, which would leave the server it started
    /// running and holding the port. Stop it first, as Quit does.
    private func stopServerOnSignal() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                Task { @MainActor in
                    await self?.server?.stop()
                    NSApp.terminate(nil)
                }
            }
            source.resume()
            signalSources.append(source)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        feed.stop()
    }

    // MARK: Server and state

    /// The server folder: inside the bundle when packaged, or DEV_LOCAL_ROOT for a checkout.
    private func serverRoot() -> URL? {
        if let root = ProcessInfo.processInfo.environment["DEV_LOCAL_ROOT"] {
            return URL(fileURLWithPath: root)
        }
        return Bundle.main.resourceURL?.appendingPathComponent("server")
    }

    private func serverChanged(_ state: ServerHost.State) {
        if case .running = state {
            Task { await model.refresh() }
        }
        statusMenu.serverMessage = state == .crashed ? "Server stopped" : nil
        refreshIcon()
    }

    /// The model changed: a push, a fetch, an action. Find the terminal behind any app that
    /// just started answering and that we did not start ourselves, then redraw.
    private func changed() {
        if let live = model.live {
            for (name, up) in live.dev where up && model.owners[name] == nil && !resolving.contains(name) {
                if live.procs.contains(where: { $0.name == name }) { continue }
                resolveOwner(name)
            }
        }
        refreshIcon()
    }

    private func refreshIcon() {
        let up = server.map { if case .running = $0.state { return true } else { return false } } ?? false
        statusMenu.setStatus(nginxRunning: model.nginxRunning, serverUp: up || demo)
        // An open menu follows along; a shut one is built again as it opens.
        statusMenu.reload()
    }

    private func menuInput() -> MenuInput {
        MenuInput(
            state: model.state ?? .empty,
            live: model.live,
            // Set by dev-app.sh (npm run dev), never by a plain install: a debug or release
            // build run by hand is not "dev mode".
            devMode: ServerHost.devMode,
            ownedNames: model.ownedNames,
            owners: model.owners,
            serverDown: server?.state == .crashed,
            starting: model.starting,
            stopping: model.stopping,
            nginxPending: model.nginxWas != nil
        )
    }

    // MARK: Owners of hand-started apps

    /// Find the terminal that runs the process on an app's port. Done off the main thread,
    /// once, when the port starts answering; the answer is cached until it stops.
    private func resolveOwner(_ name: String) {
        guard let port = model.proxies.first(where: { $0.name == name })?.port else { return }
        resolving.insert(name)
        Task.detached {
            let found = Owner.find(port: port)
            await MainActor.run {
                self.resolving.remove(name)
                self.model.owners[name] = found.kind
                self.model.ttys[name] = found.tty
                self.refreshIcon()
            }
        }
    }

    // MARK: Actions

    private func perform(_ action: MenuAction) {
        switch action {
        case .none:
            break
        case let .open(url, browser):
            Launch.open(url, in: browser)
        case let .start(name):
            Task { await model.start(name) }
        case let .stop(name):
            Task { await model.stop(name) }
        case let .log(name):
            Launch.openLog(commandFile: logsDirectory.appendingPathComponent("apps/\(name).command"))
        case let .showLog(name):
            Launch.focusOwner(model.owners[name] ?? .none, tty: model.ttys[name], cwd: model.proxies.first { $0.name == name }?.path)
        case .nginxLog:
            Launch.openLog(commandFile: logsDirectory.appendingPathComponent("nginx.command"))
        case .nginxStart:
            Task { await model.nginx(start: true) }
        case .nginxStop:
            Task { await model.nginx(start: false) }
        case .restartServer:
            server?.start()
        case let .openEditor(name):
            Task { await model.openInEditor(name) }
        case let .edit(name):
            model.editing = name
            model.adding = nil
            settings.show()
        case let .clone(name):
            model.clone(name)
            settings.show()
        case .newApp:
            model.showAddForm()
            settings.show()
        case .settings:
            settings.show()
        case .about:
            About.show()
        case .quit:
            Task {
                await server?.stop()
                NSApp.terminate(nil)
            }
        }
    }

    @objc private func showAbout() {
        About.show()
    }

    private var logsDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dev.localhost/logs")
    }

    /// Edit menu, so Cmd-C and Cmd-V work in the Settings window's fields (the app has no
    /// main menu of its own). The app menu goes first, since the first item always takes that
    /// slot, and carries About as Menu OTP's does.
    private func installEditMenu() {
        let main = NSMenu()
        let app = NSMenu(title: "dev.localhost")
        let about = NSMenuItem(title: "About dev.localhost", action: #selector(showAbout), keyEquivalent: "")
        about.target = self
        app.addItem(about)
        app.addItem(.separator())
        app.addItem(NSMenuItem(title: "Quit dev.localhost", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        let appItem = NSMenuItem()
        appItem.submenu = app
        main.addItem(appItem)
        let edit = NSMenu(title: "Edit")
        for (title, key, selector) in [
            ("Cut", "x", #selector(NSText.cut(_:))),
            ("Copy", "c", #selector(NSText.copy(_:))),
            ("Paste", "v", #selector(NSText.paste(_:))),
            ("Select All", "a", #selector(NSText.selectAll(_:))),
        ] {
            edit.addItem(NSMenuItem(title: title, action: selector, keyEquivalent: key))
        }
        let editItem = NSMenuItem()
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }
}

extension AppState {
    static let empty = AppState(
        proxies: [],
        nginx: NginxState(installed: false, running: false)
    )
}
