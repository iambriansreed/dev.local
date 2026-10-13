import AppKit
import DevLocalCore

/// Everything the menu does that leaves the app: opening URLs and logs, and focusing the
/// terminal that runs an app the server did not start.
enum Launch {
    static let chromeBundleID = "com.google.Chrome"

    static func open(_ urlString: String, in browser: Browser) {
        guard let url = URL(string: urlString) else { return }
        switch browser {
        case .defaultBrowser:
            NSWorkspace.shared.open(url)
        case .chrome:
            guard let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: chromeBundleID) else {
                NSWorkspace.shared.open(url)
                return
            }
            NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    /// The `.command` script the server wrote for an app. Terminal runs `.command` files,
    /// so opening it needs no Automation permission.
    static func openLog(commandFile url: URL) {
        NSWorkspace.shared.open(url)
    }

    /// Bring forward the terminal tab (or window) that runs a hand-started app.
    /// - Parameters:
    ///   - owner: from `OwnerKind` for the process on the app's port.
    ///   - tty: the process's tty, e.g. "ttys004". Needed to pick the exact tab.
    ///   - cwd: the app's folder, for VS Code.
    static func focusOwner(_ owner: OwnerKind, tty: String?, cwd: String?) {
        switch owner {
        case .terminal:
            runAppleScript(terminalScript(app: "Terminal", tty: tty))
        case .iterm:
            runAppleScript(itermScript(tty: tty))
        case .vscode:
            if let cwd {
                _ = try? Process.run(URL(fileURLWithPath: "/usr/bin/env"), arguments: ["code", cwd])
            }
        case .tmux, .otherApp, .none:
            activateApp(owner)
        }
    }

    private static func activateApp(_ owner: OwnerKind) {
        guard case let .otherApp(name) = owner else { return }
        let match = NSWorkspace.shared.runningApplications.first { $0.localizedName == name }
        match?.activate()
    }

    /// Terminal.app: the tab whose tty matches is selected, and its window brought to the front.
    static func terminalScript(app: String, tty: String?) -> String {
        let device = tty.map { "/dev/\($0)" } ?? ""
        return """
        tell application "\(app)"
            activate
            repeat with w in windows
                repeat with t in tabs of w
                    if tty of t is "\(device)" then
                        set selected of t to true
                        set index of w to 1
                        return
                    end if
                end repeat
            end repeat
        end tell
        """
    }

    /// iTerm2: the session whose tty matches is selected.
    static func itermScript(tty: String?) -> String {
        let device = tty.map { "/dev/\($0)" } ?? ""
        return """
        tell application "iTerm"
            activate
            repeat with w in windows
                repeat with t in tabs of w
                    repeat with s in sessions of t
                        if tty of s is "\(device)" then
                            select s
                            select t
                            select w
                            return
                        end if
                    end repeat
                end repeat
            end repeat
        end tell
        """
    }

    private static func runAppleScript(_ source: String) {
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
    }
}
