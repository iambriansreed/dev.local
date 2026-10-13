import AppKit
import DevLocalCore

/// The status item and its menu, drawn as the mocks draw it: a glyph or status dot at the
/// head of each row, the host grey and right-aligned, ⌘ shortcuts on Settings and Quit.
///
/// The menu is built when it opens and kept current while it is open: every push updates its
/// rows in place (`reload`). A row that is still the same row (by its id) keeps its NSMenuItem,
/// so an open submenu stays open while the rows around it change.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
    var input: () -> MenuInput = { MenuInput(state: .empty) }
    var onAction: ((MenuAction) -> Void)?
    var serverMessage: String? { didSet { refreshIcon() } }

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var nginxRunning = false
    private var serverUp = false

    /// The item under the pointer, for the click on an app row that also has a submenu.
    private weak var highlighted: NSMenuItem?
    private var clickMonitor: Any?
    private var isOpen = false
    /// Rows showing the loading arc, turned by `spinner` while the menu is open.
    private var loadingItems: [NSMenuItem] = []
    private var spinner: Timer?
    private var phase: CGFloat = 0

    /// What a row takes beyond its text: the image column and the space after the text.
    static let rowGutter: CGFloat = 56

    /// Every menu and submenu is this wide, so they line up with each other and with the
    /// installed app's. A detail too long to fit is clipped against the row's own edge rather
    /// than widening the menu around it.
    static let menuWidth: CGFloat = 300

    /// The menu bar mark's size, in points.
    static let iconSize: CGFloat = 17

    override init() {
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        refreshIcon()
    }

    /// The template mark, full strength while nginx runs and dimmed while it is stopped.
    func setStatus(nginxRunning: Bool, serverUp: Bool) {
        self.nginxRunning = nginxRunning
        self.serverUp = serverUp
        refreshIcon()
    }

    private func refreshIcon() {
        let image = NSImage(named: "StatusIcon")
        image?.isTemplate = true
        // A fixed size rather than one derived from the bar's height, which is taller on a Mac
        // with a notch and made the mark oversized there. The PNGs are drawn at 40 and 80 px,
        // so any size up to 40 pt stays sharp.
        let side: CGFloat = Self.iconSize
        image?.size = NSSize(width: side, height: side)
        // Down only: scaling up stretched the mark to the button's full height, whatever its size.
        item.button?.imageScaling = .scaleProportionallyDown
        item.button?.image = image
        item.button?.alphaValue = serverUp && nginxRunning ? 1 : 0.45
        item.button?.toolTip = serverMessage ?? "dev.localhost"
    }

    // MARK: Building

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === self.menu else { return }
        rebuild()
    }

    /// Bring an open menu up to date with the model. Nothing to do while it is shut: it is built
    /// again as it opens.
    func reload() {
        guard isOpen else { return }
        rebuild()
    }

    private func rebuild() {
        loadingItems = []
        apply(buildMenu(input()), to: menu, width: Self.menuWidth)
        updateSpinner()
    }

    /// Turn the loading arcs while the menu is open and has any. In the common run loop modes,
    /// since an open menu runs the loop in its tracking mode.
    private func updateSpinner() {
        let wanted = isOpen && !loadingItems.isEmpty
        if wanted, spinner == nil {
            let timer = Timer(timeInterval: 1.0 / 12, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.spin() }
            }
            RunLoop.main.add(timer, forMode: .common)
            spinner = timer
        } else if !wanted {
            spinner?.invalidate()
            spinner = nil
        }
    }

    private func spin() {
        phase += .pi / 6
        let image = Self.dotImage(.loading, phase: phase)
        for item in loadingItems {
            if let row = item.view as? MenuRowView { row.setImage(image) } else { item.image = image }
        }
    }

    /// Make `menu` show `entries`, reusing every item that is still the same row. Where a row
    /// has gone or another has taken its place, the items from there on are replaced.
    private func apply(_ entries: [MenuEntry], to menu: NSMenu, width: CGFloat) {
        menu.autoenablesItems = false
        menu.delegate = self
        menu.minimumWidth = width
        for (index, entry) in entries.enumerated() {
            let key = identity(of: entry)
            if index < menu.numberOfItems, let existing = menu.item(at: index), existing.identifier?.rawValue == key {
                if case let .item(model) = entry { configure(existing, model, width: width) }
                continue
            }
            if index < menu.numberOfItems { menu.removeItem(at: index) }
            menu.insertItem(make(entry, width: width), at: index)
        }
        while menu.numberOfItems > entries.count { menu.removeItem(at: entries.count) }
    }

    /// The same row, for reuse: its id, whether it has a submenu and whether it is a view, since
    /// none of those can change on an existing item without rebuilding it.
    private func identity(of entry: MenuEntry) -> String {
        guard case let .item(model) = entry else { return "-" }
        return "\(model.id)|\(model.submenu != nil)|\(model.keepsMenuOpen)"
    }

    private func make(_ entry: MenuEntry, width: CGFloat) -> NSMenuItem {
        guard case let .item(model) = entry else {
            let separator = NSMenuItem.separator()
            separator.identifier = NSUserInterfaceItemIdentifier("-")
            return separator
        }
        let ns = NSMenuItem(title: model.title, action: nil, keyEquivalent: model.key ?? "")
        ns.identifier = NSUserInterfaceItemIdentifier(identity(of: entry))
        if model.key != nil { ns.keyEquivalentModifierMask = [.command] }
        if model.submenu != nil {
            ns.submenu = NSMenu(title: model.title)
        }
        // Every item row is drawn by MenuRowView, which gives it the room the Menu OTP menu has.
        ns.view = MenuRowView { [weak self] action in self?.onAction?(action) }
        configure(ns, model, width: width)
        return ns
    }

    /// Everything about a row that can change while the menu is open.
    private func configure(_ ns: NSMenuItem, _ model: MenuItem, width: CGFloat) {
        ns.isEnabled = model.enabled
        ns.toolTip = model.tooltip
        ns.representedObject = ActionBox(model.action)
        // Keyboard activation goes through the item, so it keeps its target and action.
        if model.action != .none {
            ns.target = self
            ns.action = #selector(run(_:))
        } else {
            ns.target = nil
            ns.action = nil
        }
        if let submenu = model.submenu, let child = ns.submenu {
            apply(submenu, to: child, width: MenuRowView.fittedWidth(for: submenu))
        }

        let image = model.glyph.flatMap(Self.glyphImage) ?? model.dot.map { Self.dotImage($0, phase: phase) }
        if model.dot == .loading, !loadingItems.contains(where: { $0 === ns }) { loadingItems.append(ns) }
        // The view draws the title; this is what VoiceOver and Accessibility Inspector read
        // instead, and it has no drawing of its own to update since the view covers that.
        ns.title = model.title
        (ns.view as? MenuRowView)?.update(model, image: image, width: width)
    }

    static let font = NSFont.menuFont(ofSize: 0)
    static let detailFont = NSFont.menuFont(ofSize: NSFont.systemFontSize - 1)

    static func width(of text: String, font: NSFont) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    // MARK: Images

    private static var glyphs: [Glyph: NSImage] = [:]

    static func glyphImage(_ glyph: Glyph) -> NSImage? {
        if let cached = glyphs[glyph] { return cached }
        guard let image = NSImage(named: "Glyph-\(glyph.rawValue)") else { return nil }
        image.isTemplate = true
        image.size = NSSize(width: 16, height: 16)
        glyphs[glyph] = image
        return image
    }

    /// The status light: green and filled for up, a grey ring for down, and for loading a green
    /// arc turned by `phase` (radians; the spin timer advances it). Drawn, not templated, since
    /// its colour is the point.
    static func dotImage(_ dot: Dot, phase: CGFloat = 0) -> NSImage {
        NSImage(size: NSSize(width: 16, height: 16), flipped: false) { rect in
            let center = NSPoint(x: rect.midX, y: rect.midY)
            switch dot {
            case .on:
                NSColor.systemGreen.withAlphaComponent(0.35).setFill()
                NSBezierPath(ovalIn: NSRect(x: center.x - 5.5, y: center.y - 5.5, width: 11, height: 11)).fill()
                NSColor.systemGreen.setFill()
                NSBezierPath(ovalIn: NSRect(x: center.x - 4, y: center.y - 4, width: 8, height: 8)).fill()
            case .off:
                let ring = NSBezierPath(ovalIn: NSRect(x: center.x - 3.6, y: center.y - 3.6, width: 7.2, height: 7.2))
                ring.lineWidth = 1.4
                NSColor.secondaryLabelColor.setStroke()
                ring.stroke()
            case .loading:
                let track = NSBezierPath(ovalIn: NSRect(x: center.x - 4.5, y: center.y - 4.5, width: 9, height: 9))
                track.lineWidth = 1.6
                NSColor.systemGreen.withAlphaComponent(0.25).setStroke()
                track.stroke()
                let start = -phase * 180 / .pi
                let arc = NSBezierPath()
                arc.appendArc(withCenter: center, radius: 4.5, startAngle: start, endAngle: start + 110, clockwise: false)
                arc.lineWidth = 1.6
                arc.lineCapStyle = .round
                NSColor.systemGreen.setStroke()
                arc.stroke()
            }
            return true
        }
    }

    // MARK: Clicks

    @objc private func run(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? ActionBox else { return }
        onAction?(box.action)
    }

    /// The highlight moves between rows: each row that gains or loses it is told, so a title too
    /// long to fit can start or stop scrolling (see MenuRowView.setHighlighted).
    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        (highlighted?.view as? MenuRowView)?.setHighlighted(false)
        highlighted = item
        (item?.view as? MenuRowView)?.setHighlighted(true)
    }

    /// AppKit opens the submenu of an item that has one and never sends that item's action, but
    /// a running app's row is meant to open the app when clicked. So a click released on such a
    /// row is caught here: the menu is closed and the row's action is run.
    func menuWillOpen(_ menu: NSMenu) {
        guard menu === self.menu else { return }
        isOpen = true
        // menuNeedsUpdate ran just before this, while the menu still counted as shut.
        updateSpinner()
        guard clickMonitor == nil else { return }
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] event in
            guard let self, let item = self.highlighted, item.submenu != nil,
                  let box = item.representedObject as? ActionBox, box.action != .none else { return event }
            self.menu.cancelTracking()
            DispatchQueue.main.async { self.onAction?(box.action) }
            return nil
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        guard menu === self.menu else { return }
        isOpen = false
        updateSpinner()
        // Belt and braces: stop a scrolling title even if AppKit's own willHighlight(nil) is
        // skipped on this path.
        (highlighted?.view as? MenuRowView)?.setHighlighted(false)
        highlighted = nil
        guard let monitor = clickMonitor else { return }
        NSEvent.removeMonitor(monitor)
        clickMonitor = nil
    }

    /// NSMenuItem's `representedObject` takes an object, and MenuAction is a value type.
    private final class ActionBox: NSObject {
        let action: MenuAction
        init(_ action: MenuAction) { self.action = action }
    }
}
