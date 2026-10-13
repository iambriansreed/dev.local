import Foundation
import DevLocalCore

/// Finds the terminal behind a process that listens on a port: the listening pid, its
/// tty, and the chain of executables above it. Runs `lsof` and `ps`, so call it off the
/// main thread.
enum Owner {
    static func find(port: Int) -> (kind: OwnerKind, tty: String?) {
        let lsof = capture("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-t"])
        guard let pid = parseListenerPID(lsofOutput: lsof) else { return (.none, nil) }

        let tty = parseTTY(psOutput: capture("/bin/ps", ["-o", "tty=,ppid=", "-p", "\(pid)"]))
        return (ownerKind(ancestors: ancestors(of: pid)), tty)
    }

    /// The executable paths from `pid` upward, nearest first, stopping at launchd.
    static func ancestors(of pid: Int) -> [String] {
        var paths: [String] = []
        var current = pid
        for _ in 0..<32 {
            let fields = capture("/bin/ps", ["-o", "ppid=,comm=", "-p", "\(current)"])
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .split(separator: " ", maxSplits: 1)
            guard fields.count == 2, let parent = Int(fields[0]) else { break }
            paths.append(String(fields[1]))
            if parent <= 1 { break }
            current = parent
        }
        return paths
    }

    static func capture(_ tool: String, _ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return ""
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
