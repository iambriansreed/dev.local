import Foundation
import ServiceManagement
import DevLocalCore

/// Machine-side settings: the login PATH, and launch at login.
enum Setup {
    /// The PATH a login shell sees, so node, mkcert and code resolve when the app is
    /// launched from Finder. Falls back to launchd's PATH when the shell cannot say.
    static func loginPath() -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-ilc", "printf %s \"$PATH\""]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return fallbackPath
        }
        process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return parseLoginPath(output) ?? fallbackPath
    }

    private static let fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    static var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                NSLog("dev.localhost: launch at login: \(error.localizedDescription)")
            }
        }
    }
}
