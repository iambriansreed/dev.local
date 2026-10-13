import AppKit

// Menu bar only: no Dock icon, no main window. The settings window switches to a regular
// app while it is open (see SettingsWindow).
MainActor.assumeIsolated {
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
}
