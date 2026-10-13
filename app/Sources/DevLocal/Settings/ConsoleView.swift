import AppKit
import DevLocalCore
import SwiftUI

/// The console: what a dev server started here is printing, as it prints it. Output streams
/// over the live socket, and only while this is open. The list keeps processes that have
/// exited, with their exit code: a dev server that dies on boot is the one you most want to read.
struct ConsoleView: View {
    @Bindable var model: AppsModel
    @State private var follow = true
    @State private var copied = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Console").font(.title3.weight(.semibold))
                Spacer()
                Button("Close") { model.closeConsole() }.keyboardShortcut(.cancelAction)
            }
            .padding(12)
            HStack(spacing: 10) {
                Picker("Process", selection: $model.consoleSelected) {
                    ForEach(model.procs) { p in
                        Text(label(p)).tag(Optional(p.name))
                    }
                }
                .labelsHidden().frame(maxWidth: 260)
                if let p = model.procs.first(where: { $0.name == model.consoleSelected }) {
                    Text(status(p)).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Clear") { Task { await model.clearConsole() } }
                Button(copied ? "Copied" : "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(stripANSI(model.consoleText), forType: .string)
                    copied = true
                    Task { try? await Task.sleep(nanoseconds: 1_500_000_000); copied = false }
                }
                Toggle("Follow", isOn: $follow).toggleStyle(.checkbox)
            }
            .controlSize(.small)
            .padding(.horizontal, 12).padding(.bottom, 8)
            Divider()
            ScrollViewReader { scroller in
                ScrollView {
                    Text(stripANSI(model.consoleText).isEmpty ? (model.procs.isEmpty ? "Nothing has been started here yet." : "No output yet.") : stripANSI(model.consoleText))
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                    Color.clear.frame(height: 1).id("end")
                }
                .background(Color(nsColor: .textBackgroundColor))
                .onChange(of: model.consoleText) { _, _ in
                    if follow { scroller.scrollTo("end", anchor: .bottom) }
                }
            }
        }
        .frame(minWidth: 520, idealWidth: 600, minHeight: 380, idealHeight: 520)
    }

    private func label(_ p: ProcState) -> String {
        let proxy = model.proxies.first { $0.name == p.name }
        return "\(proxy?.label ?? p.name)\(p.running ? "" : " (exited)")"
    }

    private func status(_ p: ProcState) -> String {
        if p.running { return "running, pid \(p.pid ?? 0)" }
        if let signal = p.signal { return "stopped (\(signal))" }
        return "exited with code \(p.exitCode ?? 0)"
    }
}

/// Colour and cursor sequences stripped: the output is shown as text, as Terminal's Log shows
/// it in full colour.
func stripANSI(_ text: String) -> String {
    let csi = try! Regex("\u{1B}\\[[0-9;?]*[ -/]*[@-~]")
    let osc = try! Regex("\u{1B}\\][^\u{07}]*\u{07}")
    return text.replacing(csi, with: "").replacing(osc, with: "").replacing("\r\n", with: "\n")
}

/// The /etc/hosts file as it stands, split into what was there before and what we maintain.
/// Read-only: entries are added and removed from the rows.
struct HostsFileView: View {
    let file: HostsFile
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(file.path).font(.title3.weight(.semibold).monospaced())
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if let error = file.error { Text(error).foregroundStyle(.orange) }
            block("Original hosts", file.original.isEmpty ? "(empty)" : file.original, note: "What was there before dev.localhost, and what you maintain by hand. Never touched.")
            block("dev.localhost hosts", file.managed.isEmpty ? "(none)" : file.managed, note: "Inside the managed block. Fix hosts entry on a row brings these in line with your apps.")
        }
        .padding(16)
        .frame(minWidth: 560, minHeight: 420)
    }

    private func block(_ title: String, _ text: String, note: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).fontWeight(.semibold)
            Text(note).font(.system(size: 12)).foregroundStyle(.secondary)
            ScrollView {
                Text(text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
        }
    }
}
