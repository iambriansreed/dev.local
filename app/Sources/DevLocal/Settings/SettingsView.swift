import AppKit
import DevLocalCore
import SwiftUI

/// Settings: every app, nginx and the certificate in one window. A ScrollView of sections, each a card, as
/// System Settings and Menu OTP draw them. Not a List: on macOS a List holds a click on a
/// text field in one of its rows for the double-click interval before the field gets focus.
struct SettingsView: View {
    @Bindable var model: AppsModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsMetrics.sectionGap) {
                BannersView(model: model)
                SetupSection(model: model)

                SettingsSection("Apps") {
                    HStack(spacing: 8) {
                        Button("Console…") { model.openConsole() }
                            .help("What the dev servers started here are printing")
                        Button("Add…") { model.showAddForm() }
                            .disabled(model.adding != nil)
                    }
                } content: {
                    VStack(spacing: 0) {
                        if let form = model.adding {
                            AddAppView(model: model, form: form)
                            Divider()
                        }
                        NginxRow(model: model)
                        ForEach(model.proxiesInOrder) { proxy in
                            Divider().padding(.leading, SettingsMetrics.cardPadding)
                            AppRowView(model: model, proxy: proxy)
                        }
                        if model.state == nil {
                            Text("Loading…").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 14)
                        }
                    }
                    .settingsCard(padded: false)
                }

                SettingsSection("nginx & certificate") {
                    NginxSection(model: model).settingsCard()
                }

                SettingsSection("General") {
                    GeneralSection(model: model).settingsCard()
                }
            }
            .padding(20)
        }
        .frame(minWidth: 480, minHeight: 400)
        .sheet(isPresented: $model.consoleOpen) { ConsoleView(model: model) }
        .sheet(isPresented: Binding(get: { model.hostsFile != nil }, set: { if !$0 { model.hostsFile = nil } })) {
            if let file = model.hostsFile { HostsFileView(file: file) }
        }
    }
}

/// One set of spacing for every section, so they line up. Menu OTP's values.
enum SettingsMetrics {
    static let sectionGap: CGFloat = 20
    static let headingGap: CGFloat = 8
    static let cardPadding: CGFloat = 12
    static let cardRadius: CGFloat = 8
}

extension View {
    /// The rounded, bordered card every section's content sits in, as in System Settings.
    func settingsCard(padded: Bool = true) -> some View {
        padding(padded ? SettingsMetrics.cardPadding : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: SettingsMetrics.cardRadius).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: SettingsMetrics.cardRadius).strokeBorder(Color(nsColor: .separatorColor)))
    }
}

/// A titled group: a heading, an optional control at its right, then the content.
struct SettingsSection<Accessory: View, Content: View>: View {
    let title: String
    let accessory: Accessory
    let content: Content

    init(_ title: String, @ViewBuilder accessory: () -> Accessory, @ViewBuilder content: () -> Content) {
        self.title = title
        self.accessory = accessory()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SettingsMetrics.headingGap) {
            HStack {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                accessory
            }
            content
        }
    }
}

extension SettingsSection where Accessory == EmptyView {
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.init(title, accessory: { EmptyView() }, content: content)
    }
}

// MARK: Banners

struct BannersView: View {
    @Bindable var model: AppsModel

    var body: some View {
        ForEach(model.banners) { banner in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: banner.kind == .error ? "exclamationmark.triangle.fill" : banner.kind == .ok ? "checkmark.circle.fill" : "info.circle.fill")
                    .foregroundStyle(banner.kind == .error ? Color.orange : banner.kind == .ok ? Color.green : Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(banner.text)
                    if let detail = banner.detail {
                        if detail.hasPrefix("http") {
                            Link(detail, destination: URL(string: detail)!).font(.system(size: 12))
                        } else {
                            Text(detail).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                }
                Spacer()
                if let action = banner.action { Button(action.label, action: action.run) }
                Button { model.dismiss(banner) } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.secondary)
            }
            .settingsCard()
        }
    }
}

// MARK: Setup

/// The steps between a fresh install and a working setup. Shown only while one is left.
struct SetupSection: View {
    let model: AppsModel

    var body: some View {
        if let state = model.state, !state.nginx.installed || !(state.cert?.mkcertAvailable ?? true) {
            SettingsSection("Setup") {
                VStack(alignment: .leading, spacing: 12) {
                    if !state.nginx.installed {
                        step("Install nginx", "The reverse proxy that serves your *.localhost domains.", command: "brew install nginx")
                    }
                    if !(state.cert?.mkcertAvailable ?? true) {
                        step("Install mkcert", "Issues the locally trusted TLS certificate, so https:// works with no warnings.", command: "brew install mkcert")
                    }
                }
                .settingsCard()
            }
        }
    }

    private func step(_ title: String, _ text: String, command: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).fontWeight(.semibold)
            Text(text).foregroundStyle(.secondary)
            CommandText(command)
        }
    }
}

/// A command to run, with a Copy button.
struct CommandText: View {
    let command: String
    @State private var copied = false

    init(_ command: String) { self.command = command }

    var body: some View {
        HStack {
            Text(command).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
            Button(copied ? "Copied" : "Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
                copied = true
                Task { try? await Task.sleep(nanoseconds: 1_500_000_000); copied = false }
            }
            .controlSize(.small)
        }
    }
}

// MARK: nginx

/// The row at the top of the list: nginx itself, one switch for every domain.
struct NginxRow: View {
    let model: AppsModel

    var body: some View {
        let running = model.nginxRunning
        HStack(spacing: 10) {
            StatusLight(on: running, loading: model.nginxWas != nil)
            Text("nginx").fontWeight(.semibold)
            Spacer()
            Text("this app").font(.system(size: 10, weight: .semibold)).textCase(.uppercase)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.5))).foregroundStyle(Color.accentColor)
            Button(model.nginxWas != nil ? (running ? "Stopping…" : "Starting…") : running ? "Stop nginx" : "Start nginx") {
                Task { await model.nginx(start: !running) }
            }
            .disabled(model.busy || model.nginxWas != nil || !(model.state?.nginx.installed ?? false))
            .help(running ? "Stop nginx: every domain below stops responding" : "Start nginx to serve every domain below over https")
        }
        .padding(.horizontal, SettingsMetrics.cardPadding).padding(.vertical, 8)
    }
}

struct NginxSection: View {
    let model: AppsModel

    var body: some View {
        let nginx = model.state?.nginx
        let cert = model.state?.cert
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent("nginx") {
                Text(nginx.map { $0.installed ? "\($0.version.map { "v\($0)" } ?? "installed")\($0.running ? ", running" : ", stopped")" : "not installed" } ?? "…")
            }
            LabeledContent("Certificate") {
                if let cert {
                    Text(cert.exists ? "\(cert.method ?? "")\(cert.version.map { " \($0)" } ?? ""), covers \(cert.hosts.count) host\(cert.hosts.count == 1 ? "" : "s")" : "none yet")
                } else {
                    Text("…")
                }
            }
            if let trust = cert?.trustCmd {
                Text("The self-signed certificate has to be trusted once:").foregroundStyle(.secondary)
                CommandText(trust)
            }
            LabeledContent("Files") {
                Text(model.state?.baseDir ?? "~/.dev.localhost").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
            }
            HStack {
                Button("Reload nginx") { Task { await model.reloadNginx() } }
                Button("Provision certificate") { Task { await model.provisionCert() } }
                Button("Open config folder") { Task { await model.openConfigDir() } }
                Button("View /etc/hosts…") { Task { await model.loadHostsFile() } }
            }
            .disabled(model.busy)
            .controlSize(.small)
        }
    }
}

// MARK: General

struct GeneralSection: View {
    let model: AppsModel
    @State private var launchAtLogin = Setup.launchAtLogin

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Open at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, on in Setup.launchAtLogin = on }
        }
    }
}

/// The light at the head of a row: green when the app answers, grey when it doesn't, and a
/// spinner while it is on its way either way.
struct StatusLight: View {
    let on: Bool
    var loading = false

    var body: some View {
        if loading {
            ProgressView().controlSize(.mini).frame(width: 10, height: 10)
        } else {
            Circle().fill(on ? Color.green : Color.secondary.opacity(0.5)).frame(width: 8, height: 8)
                .shadow(color: on ? .green.opacity(0.6) : .clear, radius: 3)
                .accessibilityLabel(on ? "running" : "not running")
        }
    }
}
