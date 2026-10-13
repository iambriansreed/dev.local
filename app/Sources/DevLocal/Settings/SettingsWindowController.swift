import AppKit
import SwiftUI

/// The Settings window: a SwiftUI view of the shared model, in an ordinary window. Opens at
/// a deep link from the menu (New App, Edit, Clone), and drops the app back to menu-bar-only
/// when it closes, as Menu OTP's does.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let model: AppsModel
    private(set) var window: NSWindow?

    init(model: AppsModel) {
        self.model = model
    }

    func show() {
        if window == nil {
            let hosting = NSHostingController(rootView: SettingsView(model: model))
            // The window's size is the user's; don't let SwiftUI's ideal size drive it
            hosting.sizingOptions = []
            let window = NSWindow(contentViewController: hosting)
            window.title = "dev.localhost Settings"
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            // An empty compact toolbar only for its height: the title bar is then 38pt like
            // other apps' toolbar windows beside it, not a bare 28pt strip
            window.toolbar = NSToolbar(identifier: "settings")
            window.toolbarStyle = .unifiedCompact
            window.setContentSize(NSSize(width: 640, height: 640))
            window.contentMinSize = NSSize(width: 480, height: 400)
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.center()
            self.window = window
        }
        // In the Dock and Cmd-Tab only while Settings is open.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        model.closeConsole()
        model.adding = nil
        model.editing = nil
        window = nil
        NSApp.setActivationPolicy(.accessory)
    }
}
