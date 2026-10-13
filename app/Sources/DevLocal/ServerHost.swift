import Foundation
import DevLocalCore

/// The Node server the app runs, or the one a terminal already started.
///
/// Probe first: a server that answers on the port is attached to and never stopped on
/// Quit. Otherwise the app spawns its own, with the login shell's PATH (a Finder-launched
/// app gets launchd's PATH, which has no node, mkcert or code). The server never runs sudo:
/// the one root write, /etc/hosts, goes through a Terminal script the user runs.
@MainActor
final class ServerHost {
    enum State: Equatable {
        case starting
        case running(attached: Bool)
        case stopped
        case crashed
    }

    /// Where the server answers: 7878, or DEV_LOCAL_PORT (the demo's fake server).
    nonisolated static let port = Int(ProcessInfo.processInfo.environment["DEV_LOCAL_PORT"] ?? "") ?? 7878

    /// Set by `npm run dev` (app/scripts/dev-app.sh), never by a plain install. The app still
    /// starts its own server, as an installed one does; this only marks the menu as a dev build.
    nonisolated static let devMode = ProcessInfo.processInfo.environment["DEV_LOCAL_DEV"] != nil

    private(set) var state: State = .stopped
    var onChange: ((State) -> Void)?

    private var process: Process?
    private var logHandle: FileHandle?
    private let root: URL
    private let loginPath: String

    /// - Parameters:
    ///   - root: the server folder, holding `dist/server/index.js` and `assets/502.html`.
    ///   - loginPath: PATH from the user's login shell.
    init(root: URL, loginPath: String) {
        self.root = root
        self.loginPath = loginPath
    }

    var entry: URL { root.appendingPathComponent("dist/server/index.js") }

    private var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dev.localhost/logs/server.log")
    }

    /// Attach to a server that answers, or spawn one. Safe to call again after a crash.
    func start() {
        state = .starting
        onChange?(state)
        // Demo mode runs against a fake server the demo script started: nothing to spawn.
        if ProcessInfo.processInfo.environment["DEV_LOCAL_DEMO"] != nil {
            set(.running(attached: true))
            return
        }
        Task {
            if await Self.answers(port: Self.port) {
                set(.running(attached: true))
                return
            }
            spawn()
        }
    }

    /// Stop the server this app started. Attached servers are left alone.
    func stop() async {
        guard let process, process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning, Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        self.process = nil
        set(.stopped)
    }

    private func spawn() {
        guard FileManager.default.fileExists(atPath: entry.path) else {
            set(.crashed)
            return
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        child.arguments = ["node", entry.path]
        child.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = loginPath
        env["DEV_LOCALHOST_ROOT"] = root.path
        child.environment = env

        let log = openLog()
        child.standardOutput = log
        child.standardError = log
        child.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            Task { @MainActor in self?.exited(status: status) }
        }
        do {
            try child.run()
            process = child
        } catch {
            set(.crashed)
            return
        }
        // `run()` only means the process exists, not that Node has required its modules, run
        // nginx's apply and reached `listen()`. Reporting .running before that raced the app's
        // first /api/state fetch, which then had nothing to retry it: the menu stayed stuck on
        // whatever the empty state showed (plainly, "every app is running") no matter how long
        // the server had actually been up. So this waits for the port itself.
        waitToComeUp(child)
    }

    /// Poll until the spawned server answers, or it exits (its own terminationHandler reports
    /// that), or two minutes pass (a stuck nginx apply, say) — whichever comes first.
    private func waitToComeUp(_ child: Process) {
        Task {
            let deadline = Date().addingTimeInterval(120)
            while process === child, Date() < deadline {
                if await Self.answers(port: Self.port) {
                    if process === child { set(.running(attached: false)) }
                    return
                }
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
            if process === child { set(.crashed) }
        }
    }

    /// Exit status 2 is the server saying the port is taken: someone else started one
    /// between our probe and our spawn, so attach to it.
    private func exited(status: Int32) {
        process = nil
        if status == 2 {
            start()
            return
        }
        if state == .stopped { return }
        set(.crashed)
    }

    private func set(_ new: State) {
        state = new
        onChange?(new)
    }

    private func openLog() -> FileHandle? {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        guard let handle = try? FileHandle(forWritingTo: logURL) else { return nil }
        handle.seekToEndOfFile()
        logHandle = handle
        return handle
    }

    /// Whether something answers the API on the port within 300 ms.
    static func answers(port: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/state") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.3
        return (try? await URLSession.shared.data(for: request))
            .map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
    }
}
