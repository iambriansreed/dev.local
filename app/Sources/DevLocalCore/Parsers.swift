import Foundation

// Pure parsers for what the menu reads from the system. Each takes the text a command
// printed, so the parsing is testable without running the command.

public enum OwnerKind: Equatable, Sendable {
    case terminal
    case iterm
    case vscode
    case tmux
    /// Some other app that owns the process (Ghostty, Warp, ...). Activated, not focused by tab.
    case otherApp(name: String)
    /// Started by launchd, or from an exited shell: no app to bring forward.
    case none
}

/// Which app owns a process, from its ancestry.
/// - Parameter ancestors: the executable paths from the process upward, nearest first.
///   A macOS app's executable lives inside its `.app` bundle, so the bundle name is what
///   identifies the terminal.
public func ownerKind(ancestors: [String]) -> OwnerKind {
    for path in ancestors {
        if path.hasSuffix("/tmux") || path.contains("tmux: server") { return .tmux }
        guard let range = path.range(of: ".app/", options: .backwards) else { continue }
        let bundle = path[..<range.lowerBound]
        let name = String(bundle.split(separator: "/").last ?? "")
        switch name {
        case "Terminal": return .terminal
        case "iTerm", "iTerm2": return .iterm
        case "Code", "Visual Studio Code": return .vscode
        default: return .otherApp(name: name)
        }
    }
    return .none
}

/// The tty of a process from `ps -o tty=,ppid= -p <pid>`, e.g. "ttys004". nil when there is none.
public func parseTTY(psOutput: String) -> String? {
    let fields = psOutput.split(whereSeparator: { $0 == " " || $0 == "\n" }).map(String.init)
    guard let tty = fields.first, tty != "??", !tty.isEmpty else { return nil }
    return tty
}

/// The pid of the process listening on a port, from `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`.
public func parseListenerPID(lsofOutput: String) -> Int? {
    lsofOutput
        .split(whereSeparator: { $0.isNewline })
        .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        .first
}

/// The login shell's PATH, from `$SHELL -ilc 'printf %s "$PATH"'`. A profile can print
/// things before the PATH, so the last non-empty line is the one that counts.
public func parseLoginPath(_ output: String) -> String? {
    output
        .split(whereSeparator: { $0.isNewline })
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .last(where: { !$0.isEmpty && $0.contains("/") })
}
