// Prints the CGWindowID of an app's on-screen window, for `screencapture -l`.
// Usage: swift scripts/window-id.swift <pid> <window title>
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 3, let pid = Int32(args[1]) else {
    FileHandle.standardError.write("usage: window-id.swift <pid> <window title>\n".data(using: .utf8)!)
    exit(2)
}
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let match = windows.first {
    ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowName as String] as? String) == args[2]
}
guard let id = match?[kCGWindowNumber as String] as? Int else { exit(1) }
print(id)
