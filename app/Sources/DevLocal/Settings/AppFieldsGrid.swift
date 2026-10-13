import AppKit
import DevLocalCore
import SwiftUI

/// The five fields an app has, in the add form and an edit alike: what it is called, where it
/// is served and what it forwards to on the first line; where it runs and how on the second,
/// the command taking 40% of the width.
struct AppFieldsGrid: View {
    @Bindable var form: AppForm

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                field("Title", optional: true) { TextField("My App", text: $form.title) }
                field("Domain", help: domainWarning(normalizeHost(form.domain))) {
                    TextField("myapp, or local.api.example.com", text: $form.domain)
                }
                field("Port") { TextField("3000", text: $form.port).frame(width: 72) }
            }
            FractionRow(trailing: 0.4, spacing: 8) {
                field("App path", optional: true) {
                    HStack(spacing: 4) {
                        TextField("~/Projects/myapp", text: $form.path)
                        Button("Browse…") { browse() }.controlSize(.small)
                    }
                }
                field("Dev command") { TextField("npm run dev", text: $form.command).font(.system(.body, design: .monospaced)) }
            }
        }
        .textFieldStyle(.roundedBorder)
    }

    /// A labelled field. `help`, when there is one, puts a small icon beside the label that
    /// opens the explanation on click: the form stays quiet unless someone asks.
    private func field<Content: View>(
        _ label: String, optional: Bool = false, help: DomainWarning? = nil, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(label).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                if optional { Text("optional").font(.system(size: 11)).italic().foregroundStyle(.tertiary) }
                if let help { HelpButton(warning: help) }
            }
            content()
        }
    }

    /// The native folder picker. An app path has to be absolute to `cd` into.
    private func browse() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = "Choose the app folder"
        let start = form.path.trimmingCharacters(in: .whitespaces)
        if !start.isEmpty { panel.directoryURL = URL(fileURLWithPath: (start as NSString).expandingTildeInPath) }
        if panel.runModal() == .OK, let url = panel.url { form.path = url.path }
    }
}

/// The add form, as the first row of the Apps card: the fields, Save and Cancel.
struct AddAppView: View {
    @Bindable var model: AppsModel
    @Bindable var form: AppForm
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("New app").fontWeight(.semibold)
            AppFieldsGrid(form: form)
            HStack {
                if let error = form.error { Text(error).foregroundStyle(.orange).font(.system(size: 12)) }
                Spacer()
                Button("Cancel") { model.adding = nil }
                Button("Add") { Task { await model.add(form) } }.keyboardShortcut(.defaultAction)
            }
            .disabled(model.busy)
        }
        .padding(SettingsMetrics.cardPadding)
    }
}

/// A small icon that opens a popover: an orange warning for a domain that will misbehave, a
/// grey question mark for one with a catch worth knowing.
private struct HelpButton: View {
    let warning: DomainWarning
    @State private var shown = false

    var body: some View {
        let problem = warning.severity == .problem
        Button { shown.toggle() } label: {
            Image(systemName: problem ? "exclamationmark.triangle.fill" : "questionmark.circle")
                .font(.system(size: 11))
                .foregroundStyle(problem ? Color.orange : Color.secondary)
        }
        .buttonStyle(.plain)
        .help(problem ? "Why this domain is a problem" : "About this domain")
        .popover(isPresented: $shown, arrowEdge: .bottom) {
            Text(.init(warning.text))
                .font(.system(size: 12))
                .fixedSize(horizontal: false, vertical: true)
                .frame(width: 280, alignment: .leading)
                .padding(12)
        }
    }
}

/// Two views side by side, the second taking `trailing` of the width (less the spacing) and
/// the first the rest. HStack can only share space by ideal sizes, which a text field doesn't
/// usefully have, so the split is done here.
private struct FractionRow: Layout {
    var trailing: CGFloat
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 400
        let height = widths(width).enumerated().map { i, w in
            subviews[i].sizeThatFits(ProposedViewSize(width: w, height: nil)).height
        }.max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        for (i, w) in widths(bounds.width).enumerated() {
            subviews[i].place(at: CGPoint(x: x, y: bounds.maxY), anchor: .bottomLeading,
                              proposal: ProposedViewSize(width: w, height: nil))
            x += w + spacing
        }
    }

    private func widths(_ total: CGFloat) -> [CGFloat] {
        let usable = max(total - spacing, 0)
        return [usable * (1 - trailing), usable * trailing]
    }
}
