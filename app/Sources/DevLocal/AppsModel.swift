import AppKit
import DevLocalCore

/// A message at the top of Settings.
struct Banner: Identifiable, Equatable {
    enum Kind { case info, ok, error }
    let id = UUID()
    var kind: Kind
    var text: String
    /// A second line: a URL to open, a command to copy, the output of the thing that failed.
    var detail: String?
    /// Offered beside the text: "Fix hosts entry" after saving a custom domain, say.
    var action: (label: String, run: () -> Void)?

    static func == (a: Banner, b: Banner) -> Bool { a.id == b.id }
}

/// The one store the menu and the Settings window both read: the server's state and its
/// live push, what is on its way, and every action, each of which goes to the server and
/// then takes the state the server answers with (or fetches it again).
@MainActor
@Observable
final class AppsModel {
    private(set) var state: AppState?
    private(set) var live: LiveStatus?
    private(set) var banners: [Banner] = []
    /// Apps asked to start or stop, until a push shows their port has changed (see settle).
    private(set) var starting: Set<String> = []
    private(set) var stopping: Set<String> = []
    /// nginx's state when Start or Stop was chosen, until a push shows it has changed.
    private(set) var nginxWas: Bool?
    /// Every action is one at a time: the controls disable meanwhile.
    private(set) var busy = false
    /// Owner of each hand-started app, by proxy name (see AppDelegate.resolveOwner).
    var owners: [String: OwnerKind] = [:]
    var ttys: [String: String] = [:]

    // Settings' own state.
    /// The proxy being edited in place, if any.
    var editing: String?
    /// The add form, shown when non-nil; Clone fills it in.
    var adding: AppForm?
    /// What the console shows: the processes we started, the one selected, and its output.
    private(set) var procs: [ProcState] = []
    var consoleSelected: String? { didSet { if consoleSelected != oldValue { watchConsole() } } }
    private(set) var consoleText = ""
    var consoleOpen = false { didSet { if consoleOpen != oldValue { watchConsole() } } }
    var hostsFile: HostsFile?

    let api: API
    let feed: LiveFeed
    var onChange: (() -> Void)?

    init(api: API, feed: LiveFeed) {
        self.api = api
        self.feed = feed
        feed.onStatus = { [weak self] live in self?.applyLive(live) }
        feed.onLog = { [weak self] frame in self?.applyLog(frame) }
    }

    var proxies: [ProxyState] { state?.proxies ?? [] }
    var nginxRunning: Bool { live?.nginxRunning ?? state?.nginx.running ?? false }
    func isRunning(_ p: ProxyState) -> Bool { DevLocalCore.isRunning(p, live: live) }
    /// The apps as Settings lists them: running first, then alphabetically.
    var proxiesInOrder: [ProxyState] { settingsOrder(proxies, live: live) }
    func proc(_ name: String) -> ProcSummary? { live?.procs.first { $0.name == name } }
    var ownedNames: Set<String> { Set(live?.procs.map(\.name) ?? []) }

    // MARK: State

    /// Fetch the state; a couple of retries cover a server still coming up.
    func refresh(attempt: Int = 1) async {
        do {
            apply(try await api.state())
        } catch {
            if attempt < 3 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await refresh(attempt: attempt + 1)
                return
            }
        }
    }

    private func apply(_ new: AppState) {
        state = new
        onChange?()
    }

    private func applyLive(_ new: LiveStatus) {
        let previous = live?.rev
        live = new
        // A proxy written somewhere else (the menu, another Settings action) changes the list.
        if previous != nil, previous != new.rev { Task { await refresh() } }
        settle(new)
        if consoleOpen { Task { await refreshProcs() } }
        onChange?()
    }

    /// End the waits the push answers: an app whose port now answers has started, one whose
    /// port went quiet has stopped, and nginx has done what it was asked once its state flips.
    /// A start whose process has already exited isn't coming, and says so.
    private func settle(_ live: LiveStatus) {
        for name in starting {
            let proc = live.procs.first { $0.name == name }
            if live.dev[name] == true {
                starting.remove(name)
                if let p = proxies.first(where: { $0.name == name }) {
                    banner(.ok, "\(p.label) is up", detail: p.url)
                }
            } else if let proc, !proc.running {
                starting.remove(name)
                let how = proc.signal.map { "stopped (\($0))" } ?? "exited with code \(proc.exitCode ?? 0)"
                banner(.error, "\(name) \(how) before its port answered. The Console has its output.")
            }
        }
        for name in stopping where live.dev[name] != true { stopping.remove(name) }
        if let was = nginxWas, live.nginxRunning != was { nginxWas = nil }
    }

    // MARK: Banners

    func banner(_ kind: Banner.Kind, _ text: String, detail: String? = nil, action: (label: String, run: () -> Void)? = nil) {
        let new = Banner(kind: kind, text: text, detail: detail, action: action)
        banners.append(new)
        if banners.count > 4 { banners.removeFirst() }
        // Every banner closes itself after 15 seconds; the × closes it sooner.
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            self?.dismiss(new)
        }
    }

    func dismiss(_ banner: Banner) {
        banners.removeAll { $0 == banner }
    }

    /// Run one request, with the controls disabled meanwhile, and take the state it answers with.
    private func perform(_ request: () async throws -> ActionResult) async -> ActionResult? {
        busy = true
        defer { busy = false }
        do {
            let result = try await request()
            if let state = result.state { apply(state) } else { await refresh() }
            return result
        } catch {
            banner(.error, "Could not reach the dev.localhost server. Is it running?")
            return nil
        }
    }

    /// How an add or edit ends: a failure, or the proxy served. A custom domain that nothing
    /// resolves yet opens the /etc/hosts fix in Terminal at once, since the browser can't reach
    /// it until that runs; an /etc/hosts line a rename left behind is offered to the same fix.
    private func finish(_ result: ActionResult, host: String, previous: ProxyState?) async {
        let saved = result.proxy?.host ?? host
        guard result.succeeded else {
            if let applied = result.applied, !applied.ok {
                banner(.error, applied.step == "nginx" ? "nginx is not installed." : "nginx \(applied.step ?? "apply") failed", detail: applied.out)
            } else {
                banner(.error, result.failure)
            }
            return
        }
        if proxies.first(where: { $0.host == saved })?.needsHosts == true {
            await fixHosts(saved: saved)
            return
        }
        banner(.ok, "\(saved) is served", detail: "https://\(saved)")
        if let previous, previous.host != saved, previous.hostsManaged == true {
            banner(.info, "\(previous.host) no longer needs its line in /etc/hosts.", action: ("Remove It", fixHostsAction.run))
        }
    }

    // MARK: Proxies

    func add(_ form: AppForm) async {
        guard let input = validate(form, excluding: nil) else { return }
        guard let result = await perform({ try await api.addProxy(input) }) else { return }
        if let error = result.error {
            form.error = error
            return
        }
        adding = nil
        await finish(result, host: input.name, previous: nil)
    }

    func save(_ name: String, _ form: AppForm) async {
        guard let input = validate(form, excluding: name) else { return }
        let was = proxies.first { $0.name == name }
        guard let result = await perform({ try await api.updateProxy(name, input) }) else { return }
        if let error = result.error {
            form.error = error
            return
        }
        editing = nil
        await finish(result, host: input.name, previous: was)
    }

    private func validate(_ form: AppForm, excluding: String?) -> API.ProxyInput? {
        form.error = nil
        let host = normalizeHost(form.domain)
        guard validHost(host) else { form.error = hostHint; return nil }
        guard let port = Int(form.port.trimmingCharacters(in: .whitespaces)), validPort(port) else { form.error = portHint; return nil }
        if let clash = portTaken(port, in: proxies, excluding: excluding) {
            form.error = "Port \(port) is already used by \(clash.host)."
            return nil
        }
        return API.ProxyInput(name: host, port: port, path: form.path.trimmingCharacters(in: .whitespaces),
                              command: form.command.trimmingCharacters(in: .whitespaces), title: form.title.trimmingCharacters(in: .whitespaces))
    }

    func delete(_ name: String) async {
        guard let p = proxies.first(where: { $0.name == name }) else { return }
        guard let result = await perform({ try await api.deleteProxy(name) }) else { return }
        if let error = result.error { banner(.error, error); return }
        if p.hostsManaged == true {
            banner(.info, "\(p.host) removed. Its line in /etc/hosts is no longer needed.", action: ("Remove It", fixHostsAction.run))
        } else {
            banner(.info, "\(p.host) removed")
        }
    }

    /// Clone loads the row's settings into the add form under a free name rather than creating
    /// the proxy outright: a copy almost always wants a tweak first.
    func clone(_ name: String) {
        guard let p = proxies.first(where: { $0.name == name }) else { return }
        let form = AppForm()
        form.title = p.title.map { "\($0) (copy)" } ?? ""
        form.domain = cloneHost(p.host, taken: proxies.map(\.host))
        form.port = String(p.port)
        form.path = p.path ?? ""
        form.command = p.command ?? defaultCommand
        adding = form
        editing = nil
    }

    func showAddForm() {
        if adding == nil { adding = AppForm() }
        editing = nil
    }

    // MARK: Start and stop

    func start(_ name: String) async {
        guard !busy else { return }
        starting.insert(name)
        onChange?()
        guard let result = await perform({ try await api.startDev(name) }) else { starting.remove(name); return }
        if result.ok != true {
            starting.remove(name)
            banner(.error, result.failure)
        }
        // Not settled by the push within a minute: not coming.
        Task { try? await Task.sleep(nanoseconds: 60_000_000_000); starting.remove(name) }
    }

    func stop(_ name: String) async {
        guard !busy else { return }
        stopping.insert(name)
        onChange?()
        guard let result = await perform({ try await api.stopDev(name) }) else { stopping.remove(name); return }
        if result.ok != true { stopping.remove(name); banner(.error, result.failure) }
        else if result.stopped == false { stopping.remove(name) } // nothing was running
        Task { try? await Task.sleep(nanoseconds: 60_000_000_000); stopping.remove(name) }
    }

    func restart(_ name: String) async {
        guard !busy else { return }
        starting.insert(name)
        guard let result = await perform({ try await api.restartDev(name) }) else { starting.remove(name); return }
        if result.ok != true { starting.remove(name); banner(.error, result.failure) }
    }

    func openInEditor(_ name: String) async {
        guard let result = await perform({ try await api.openEditor(name) }) else { return }
        if result.ok != true { banner(.error, result.failure) }
    }

    // MARK: /etc/hosts

    /// Bring /etc/hosts in line with the apps: every custom domain gets its line, and a line
    /// no app uses goes. The app never writes the file itself. It opens a Terminal script that
    /// says what it will change and why that needs the Mac password, then asks for it with
    /// sudo; the server sees the file change and the rows update. `saved` is the domain a save
    /// just added, which leads the banner and keeps the fix one click away if Terminal fails.
    func fixHosts(saved: String? = nil) async {
        guard let result = await perform({ try await api.fixHosts() }) else { return }
        if result.ok != true {
            if let saved {
                banner(.error, "\(saved) is saved, but its /etc/hosts line could not be prepared.",
                       detail: result.failure, action: fixHostsAction)
            } else {
                banner(.error, result.failure)
            }
        } else if let script = result.script {
            Launch.openLog(commandFile: URL(fileURLWithPath: script))
            let lead = saved.map { "\($0) is saved and needs a line in /etc/hosts. " } ?? ""
            banner(.info, "\(lead)Terminal is open. It shows the change to /etc/hosts and asks for your Mac password.")
        } else {
            banner(.ok, "/etc/hosts already has every line dev.localhost needs.")
        }
        if hostsFile != nil { await loadHostsFile() }
    }

    var fixHostsAction: (label: String, run: () -> Void) {
        ("Fix Hosts Entry", { [weak self] in Task { await self?.fixHosts() } })
    }

    func loadHostsFile() async {
        hostsFile = try? await api.hostsFile()
    }

    // MARK: nginx

    func nginx(start: Bool) async {
        guard !busy else { return }
        nginxWas = !start
        guard let result = await perform({ start ? try await api.startNginx() : try await api.stopNginx() }) else { nginxWas = nil; return }
        if !result.succeeded { nginxWas = nil; banner(.error, "nginx did not \(start ? "start" : "stop")", detail: result.failure) }
        Task { try? await Task.sleep(nanoseconds: 60_000_000_000); nginxWas = nil }
    }

    func reloadNginx() async {
        guard let result = await perform({ try await api.reloadNginx() }) else { return }
        if result.succeeded { banner(.ok, "nginx reloaded") } else { banner(.error, "nginx reload failed", detail: result.failure) }
    }

    func provisionCert() async {
        guard let result = await perform({ try await api.provisionCert() }) else { return }
        if result.ok == true { banner(.ok, "Certificate provisioned") } else { banner(.error, "Certificate provisioning failed", detail: result.failure) }
    }

    func openConfigDir() async {
        _ = await perform { try await api.openConfigDir() }
    }

    // MARK: Console

    func openConsole(_ name: String? = nil) {
        consoleOpen = true
        Task {
            await refreshProcs()
            consoleSelected = name ?? consoleSelected ?? procs.first?.name
        }
    }

    func closeConsole() {
        consoleOpen = false
    }

    private func refreshProcs() async {
        procs = (try? await api.procs()) ?? []
        if consoleSelected == nil { consoleSelected = procs.first?.name }
    }

    private func watchConsole() {
        let name = consoleOpen ? consoleSelected : nil
        feed.watch(name)
        if name == nil { consoleText = "" }
    }

    private func applyLog(_ frame: LogFrame) {
        guard frame.name == consoleSelected else { return }
        consoleText = frame.reset == true ? frame.text : consoleText + frame.text
    }

    func clearConsole() async {
        guard let name = consoleSelected else { return }
        try? await api.clearProc(name)
        consoleText = ""
        await refreshProcs()
    }

    var defaultCommand: String { "npm run dev" }
}

/// What the add form and an edit in place hold. A class so SwiftUI's fields bind to it.
@MainActor
@Observable
final class AppForm {
    var title = ""
    var domain = ""
    var port = ""
    var path = ""
    var command = "npm run dev"
    var error: String?

    init() {}

    static func editing(_ p: ProxyState) -> AppForm {
        let form = AppForm()
        form.title = p.title ?? ""
        form.domain = p.host
        form.port = String(p.port)
        form.path = p.path ?? ""
        form.command = p.command ?? "npm run dev"
        return form
    }
}
