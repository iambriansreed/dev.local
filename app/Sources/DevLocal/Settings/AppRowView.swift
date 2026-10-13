import AppKit
import DevLocalCore
import SwiftUI

/// One app: its light, title over host, port and path, the Start/Stop toggle, and the ⋯ menu
/// with everything else. Edit swaps the row for the fields in place.
struct AppRowView: View {
    @Bindable var model: AppsModel
    let proxy: ProxyState
    @State private var form: AppForm?
    @State private var confirmDelete = false
    @State private var hovering = false

    /// Only while the row is pointed at, as in Finder and System Settings lists (and Menu OTP),
    /// so the list reads as names rather than a column of buttons. Always shown to VoiceOver.
    /// Drawn clear rather than hidden, so they keep their space and stay in the accessibility
    /// tree; a spinner shows regardless, since it is status, not a control.
    private var actionColor: Color {
        hovering || NSWorkspace.shared.isVoiceOverEnabled ? Color.secondary : Color.clear
    }

    private var running: Bool { model.isRunning(proxy) || (model.proc(proxy.name)?.running ?? false) }
    private var starting: Bool { model.starting.contains(proxy.name) }
    private var stopping: Bool { model.stopping.contains(proxy.name) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.editing == proxy.name, let form {
                VStack(alignment: .leading, spacing: 8) {
                    AppFieldsGrid(form: form)
                    HStack {
                        if let error = form.error { Text(error).foregroundStyle(.orange).font(.system(size: 12)) }
                        Spacer()
                        Button("Cancel") { model.editing = nil }
                        Button("Save") { Task { await model.save(proxy.name, form) } }.keyboardShortcut(.defaultAction)
                    }
                    .disabled(model.busy)
                }
                .padding(SettingsMetrics.cardPadding)
            } else {
                row
            }
        }
        .onChange(of: model.editing) { _, editing in
            form = editing == proxy.name ? AppForm.editing(proxy) : nil
        }
        .onAppear { if model.editing == proxy.name { form = AppForm.editing(proxy) } }
        .confirmationDialog("Delete \(proxy.host)?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await model.delete(proxy.name) } }
        } message: {
            Text(running ? "Its dev server will be stopped." : "Its nginx config goes with it.")
        }
    }

    private var row: some View {
        HStack(spacing: 10) {
            StatusLight(on: running && !starting, loading: starting || stopping)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    // No title of its own: the domain stands in, so every row reads the same way.
                    Text(proxy.label).fontWeight(.semibold)
                    if proxy.needsHosts == true {
                        // Said in words, not a bare triangle: the click opens Terminal and asks
                        // for the Mac password, which nobody should meet without warning.
                        Button { Task { await model.fixHosts() } } label: {
                            Label("Fix hosts entry", systemImage: "exclamationmark.triangle.fill")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.orange)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                        .help("\(proxy.host) doesn't resolve yet: /etc/hosts has no line for it. Opens Terminal, which shows the change and asks for your Mac password to make it.")
                    } else if !proxy.provisioned {
                        Image(systemName: "lock.open").foregroundStyle(.orange).help("Not secured yet: start nginx")
                    }
                }
                // The port, then the address it is served at: what it is, as one line.
                HStack(spacing: 0) {
                    // String(), not interpolation: Text formats an interpolated Int for the locale,
                    // which turns port 8675 into "8,675".
                    Text(String(proxy.port) + "  :  ").foregroundStyle(.secondary)
                    Link(proxy.url, destination: URL(string: proxy.url) ?? URL(string: "https://\(proxy.host)")!)
                        .foregroundStyle(proxy.provisioned ? Color.accentColor : Color.primary)
                }
                .font(.system(size: 11, design: .monospaced))
            }
            Spacer(minLength: 8)
            Button { model.editing = proxy.name; model.adding = nil } label: {
                Image(systemName: "pencil").frame(width: 16, height: 16).modifier(RowActionPadding())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(actionColor)
            .accessibilityLabel("Edit \(proxy.label)")
            .disabled(model.busy)
            .help("Edit")
            // As Menu OTP's row actions: borderless grey glyphs, ▶ or ■ for what the click does,
            // and a spinner while it is on its way. All one size, so the column never moves.
            Button {
                Task { running ? await model.stop(proxy.name) : await model.start(proxy.name) }
            } label: {
                Group {
                    if starting || stopping {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: running ? "stop.fill" : "play.fill")
                    }
                }
                .frame(width: 16, height: 16)
                .modifier(RowActionPadding())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(starting || stopping ? Color.secondary : actionColor)
            .accessibilityLabel(starting ? "Starting" : stopping ? "Stopping" : running ? "Stop \(proxy.label)" : "Start \(proxy.label)")
            .disabled(model.busy || proxy.path == nil || starting || stopping)
            .help(proxy.path == nil ? noAppPathHint : running ? "Stop the dev server" : "Run \(proxy.command ?? model.defaultCommand) in \(shortPath(proxy.path!))")
            Menu {
                Button("Open in VS Code") { Task { await model.openInEditor(proxy.name) } }.disabled(proxy.path == nil)
                Button("Console") { model.openConsole(proxy.name) }.disabled(model.proc(proxy.name) == nil)
                Button("Restart") { Task { await model.restart(proxy.name) } }.disabled(proxy.path == nil || !running)
                Divider()
                if proxy.needsHosts == true {
                    Button("Fix Hosts Entry…") { Task { await model.fixHosts() } }
                }
                Button("Clone") { model.clone(proxy.name) }
                Divider()
                Button("Delete…", role: .destructive) { confirmDelete = true }
            } label: {
                // ⋯ is the Mac's "more actions" menu (a right chevron means drill in)
                Image(systemName: "ellipsis.circle").modifier(RowActionPadding()).foregroundStyle(actionColor)
            }
            // The borderless style adds its own ⌄ beside the label; the ⋯ already says menu
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .disabled(model.busy)
        }
        .padding(.horizontal, SettingsMetrics.cardPadding).padding(.vertical, 8)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

/// `~` for the home directory, as everything user-facing in this app shows it.
func shortPath(_ dir: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return dir.hasPrefix(home + "/") ? "~" + dir.dropFirst(home.count) : dir
}

/// Menu OTP's row action padding: a click target a little bigger than the glyph.
struct RowActionPadding: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(.horizontal, 6).padding(.vertical, 4).contentShape(Rectangle())
    }
}
