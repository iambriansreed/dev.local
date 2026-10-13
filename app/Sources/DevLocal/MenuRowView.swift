import AppKit
import DevLocalCore

/// One menu row, drawn by the app rather than by AppKit, so it can be taller than a native row
/// (28 pt, with room around the text as the Menu OTP menu has). It draws what a native row
/// draws: the image or status dot, the title, the grey detail, the shortcut, and the submenu arrow.
///
/// A title too long for its row is truncated with an ellipsis, and scrolls left to read in full
/// while the row is highlighted, holding at each end — the same behaviour (and timing) as Menu
/// OTP's account rows, MenuView.swift's MarqueeText. The detail is truncated the same way but
/// does not scroll: one moving line per row is plenty.
///
/// Rows that stay open (Start and Stop) run their action on a click and leave the menu up. Every
/// other row runs its action and closes the menu, as a native row does. A row with a submenu opens
/// it on hover, as a native row does, and a click on it does nothing.
@MainActor
final class MenuRowView: NSView {
    private(set) var model = MenuItem(title: "")
    private var image: NSImage?
    private let onAction: (MenuAction) -> Void

    /// The row's height in points: taller than a native row, so each item has room around it.
    static let height: CGFloat = 28
    private static let inset: CGFloat = 5
    private static let imageX: CGFloat = 14
    private static let titleX: CGFloat = 38
    private static let trailing: CGFloat = 18
    private static let arrowWidth: CGFloat = 10
    /// The title never gives up more room than this to the detail beside it.
    private static let minTitleWidth: CGFloat = 50
    private static let gap: CGFloat = 8
    /// The narrowest a fitted submenu gets, so a short title still has a comfortable row.
    private static let minFittedWidth: CGFloat = 140

    // Laid out once per `update`, in `layOut()`, so `draw` and the marquee timer read fixed
    // numbers rather than recomputing them on every frame. Never drawn before the first `update`
    // sets real values, so the zero starting point here is never seen.
    private var titleX: CGFloat = 0
    private var titleMaxWidth: CGFloat = 0
    private var titleFullWidth: CGFloat = 0
    private var truncatedTitle = ""
    private var detailMaxWidth: CGFloat = 0
    private var truncatedDetail: String?
    private var rightEdge: CGFloat = 0
    /// The width this row was last laid out for: the menu's own, so every row in one menu lines up.
    private var width: CGFloat = StatusMenu.menuWidth

    private var marqueeTimer: Timer?
    private var marqueeStart = Date()
    /// Points per second, and the hold at each end before it moves on — Menu OTP's MarqueeScroll.
    private static let marqueeSpeed: CGFloat = 40
    private static let marqueeHold: TimeInterval = 0.8

    init(onAction: @escaping (MenuAction) -> Void) {
        self.onAction = onAction
        super.init(frame: NSRect(x: 0, y: 0, width: 200, height: Self.height))
        // The menu sizes a view item to its own width, so a row stretches to the menu's width and
        // its detail sits flush against the right edge.
        autoresizingMask = [.width]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// The spinner's next frame, for a loading row.
    func setImage(_ image: NSImage?) {
        self.image = image
        needsDisplay = true
    }

    func update(_ model: MenuItem, image: NSImage?, width: CGFloat) {
        self.model = model
        self.image = image
        // Every row is its menu's fixed width, so the rows of one level line up; text too long
        // for it truncates against the row's own edge instead of widening it.
        self.width = width
        setFrameSize(NSSize(width: width, height: Self.height))
        toolTip = model.tooltip
        layOut()
        setHighlighted(isHighlighted) // re-measure the marquee against the new text, if any
    }

    /// Where everything in the row sits, and which strings are already short enough as they are.
    private func layOut() {
        titleX = image != nil ? Self.titleX : Self.imageX

        var right = width - Self.trailing
        if model.submenu != nil {
            right -= Self.arrowWidth + 12
        } else if let key = model.key {
            right -= StatusMenu.width(of: shortcutText(key), font: StatusMenu.detailFont) + 12
        }
        rightEdge = right

        if let detail = model.detail {
            let natural = StatusMenu.width(of: detail, font: StatusMenu.detailFont)
            let available = max(0, rightEdge - titleX - Self.minTitleWidth - Self.gap)
            detailMaxWidth = min(natural, available)
            (truncatedDetail, _) = Self.truncated(detail, font: StatusMenu.detailFont, maxWidth: detailMaxWidth)
            titleMaxWidth = max(0, rightEdge - titleX - (detailMaxWidth > 0 ? detailMaxWidth + Self.gap : 0))
        } else {
            detailMaxWidth = 0
            truncatedDetail = nil
            titleMaxWidth = max(0, rightEdge - titleX)
        }

        titleFullWidth = StatusMenu.width(of: model.title, font: StatusMenu.font)
        (truncatedTitle, _) = Self.truncated(model.title, font: StatusMenu.font, maxWidth: titleMaxWidth)
    }

    /// The width a menu of action rows (no detail text) needs: room for its longest title and
    /// nothing more, but never wider than a full menu. A menu whose rows carry detail text keeps
    /// the full width, since the host or status beside a title is what fills it.
    static func fittedWidth(for entries: [MenuEntry]) -> CGFloat {
        var widest: CGFloat = 0
        for case let .item(model) in entries {
            if model.detail != nil { return StatusMenu.menuWidth }
            let x = model.glyph != nil || model.dot != nil ? titleX : imageX
            widest = max(widest, x + StatusMenu.width(of: model.title, font: StatusMenu.font) + trailing)
        }
        return min(StatusMenu.menuWidth, max(minFittedWidth, widest))
    }

    private func shortcutText(_ key: String) -> String {
        "⌘" + (key == "q" ? "Q" : key.uppercased())
    }

    /// The longest prefix of `text`, plus "…", that fits in `maxWidth` — `text` itself if it
    /// already does.
    private static func truncated(_ text: String, font: NSFont, maxWidth: CGFloat) -> (String, CGFloat) {
        let attrs: [NSAttributedString.Key: Any] = [.font: font]
        let fullWidth = (text as NSString).size(withAttributes: attrs).width
        guard fullWidth > maxWidth, maxWidth > 0 else { return (text, fullWidth) }
        var lo = 0, hi = text.count, fit = 0
        while lo <= hi {
            let mid = (lo + hi) / 2
            let candidate = String(text.prefix(mid)) + "…"
            if (candidate as NSString).size(withAttributes: attrs).width <= maxWidth {
                fit = mid
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
        let result = fit > 0 ? String(text.prefix(fit)) + "…" : "…"
        return (result, (result as NSString).size(withAttributes: attrs).width)
    }

    /// Whether the row can be picked: it has an action, or a submenu to open.
    private var isPickable: Bool { model.enabled && (model.action != .none || model.submenu != nil) }
    private var isHighlighted: Bool { isPickable && (enclosingMenuItem?.isHighlighted ?? false) }

    /// Called by StatusMenu as the pointer's highlight moves between rows. Starts or stops the
    /// title's marquee; every other row just redraws to show or lose its highlight.
    func setHighlighted(_ highlighted: Bool) {
        marqueeTimer?.invalidate()
        marqueeTimer = nil
        needsDisplay = true
        guard highlighted, titleFullWidth - titleMaxWidth > 0.5 else { return }
        marqueeStart = Date()
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.needsDisplay = true }
        }
        RunLoop.main.add(timer, forMode: .common)
        marqueeTimer = timer
    }

    /// Hold at the start, scroll to the end, hold there, then back to the start — Menu OTP's
    /// MarqueeScroll.offset(at:), without its Reduce Motion case (AppKit has no equivalent hook
    /// on a plain NSTimer; the destination is reached quickly enough either way at this length).
    private func marqueeOffset() -> CGFloat {
        let overflow = titleFullWidth - titleMaxWidth
        guard overflow > 0 else { return 0 }
        let travel = Double(overflow) / Double(Self.marqueeSpeed)
        let cycle = travel + 2 * Self.marqueeHold
        let elapsed = Date().timeIntervalSince(marqueeStart).truncatingRemainder(dividingBy: cycle)
        let t = min(max(elapsed - Self.marqueeHold, 0), travel)
        return CGFloat(t) * Self.marqueeSpeed
    }

    override func draw(_ dirtyRect: NSRect) {
        let highlighted = isHighlighted
        if highlighted {
            let rect = bounds.insetBy(dx: Self.inset, dy: 1)
            NSColor.controlAccentColor.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 5, yRadius: 5).fill()
        }

        // A starting app reads as a normal row whose status is quieter: its title keeps the label
        // colour, and "Starting…" is the tertiary grey.
        let loading = model.dot == .loading
        let textColor: NSColor = loading ? .labelColor
            : !model.enabled ? .disabledControlTextColor
            : highlighted ? .white : .labelColor
        let detailColor: NSColor = loading ? .tertiaryLabelColor
            : highlighted ? .white.withAlphaComponent(0.78)
            : model.enabled ? .secondaryLabelColor : .disabledControlTextColor

        if let image {
            let side: CGFloat = 16
            let rect = NSRect(x: Self.imageX, y: (bounds.height - side) / 2, width: side, height: side)
            if image.isTemplate {
                tinted(image, textColor).draw(in: rect)
            } else {
                image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: model.enabled ? 1 : 0.5)
            }
        }

        drawTitle(color: textColor, scrolling: marqueeTimer != nil)

        if model.submenu != nil {
            drawArrow(at: rightEdge + Self.gap, color: highlighted ? .white : .secondaryLabelColor)
        } else if let key = model.key {
            let shortcut = NSAttributedString(string: shortcutText(key), attributes: [
                .font: StatusMenu.detailFont, .foregroundColor: detailColor,
            ])
            shortcut.draw(at: NSPoint(x: rightEdge + Self.gap, y: (bounds.height - shortcut.size().height) / 2))
        }

        if let detail = truncatedDetail {
            let text = NSAttributedString(string: detail, attributes: [.font: StatusMenu.detailFont, .foregroundColor: detailColor])
            text.draw(at: NSPoint(x: rightEdge - text.size().width, y: (bounds.height - text.size().height) / 2))
        }
    }

    /// Truncated and still while the row isn't highlighted; scrolling, the full title clipped to
    /// its column, once it is — and only then, since a title that already fits has nothing to show.
    private func drawTitle(color: NSColor, scrolling: Bool) {
        guard scrolling else {
            let text = NSAttributedString(string: truncatedTitle, attributes: [.font: StatusMenu.font, .foregroundColor: color])
            text.draw(at: NSPoint(x: titleX, y: (bounds.height - text.size().height) / 2))
            return
        }
        let text = NSAttributedString(string: model.title, attributes: [.font: StatusMenu.font, .foregroundColor: color])
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: NSRect(x: titleX, y: 0, width: titleMaxWidth, height: bounds.height)).setClip()
        text.draw(at: NSPoint(x: titleX - marqueeOffset(), y: (bounds.height - text.size().height) / 2))
        NSGraphicsContext.restoreGraphicsState()
    }

    /// The submenu chevron, as the native row draws it.
    private func drawArrow(at x: CGFloat, color: NSColor) {
        let path = NSBezierPath()
        let mid = bounds.midY
        path.move(to: NSPoint(x: x + 2, y: mid + 4))
        path.line(to: NSPoint(x: x + 6, y: mid))
        path.line(to: NSPoint(x: x + 2, y: mid - 4))
        path.lineWidth = 1.6
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        color.setStroke()
        path.stroke()
    }

    /// A template image drawn in `color`, as a native row tints its image.
    private func tinted(_ image: NSImage, _ color: NSColor) -> NSImage {
        NSImage(size: image.size, flipped: false) { rect in
            image.draw(in: rect)
            color.set()
            rect.fill(using: .sourceAtop)
            return true
        }
    }

    // The highlight moves between rows as the pointer does, so each row redraws when asked.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        activate()
    }

    /// VoiceOver and Accessibility tools press a row the way a click does. Without this a
    /// view-based menu item answers AXPress with nothing.
    override func accessibilityPerformPress() -> Bool {
        guard model.enabled, model.action != .none else { return false }
        activate()
        return true
    }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityLabel() -> String? { model.detail.map { "\(model.title), \($0)" } ?? model.title }
    override func accessibilityRole() -> NSAccessibility.Role? { .menuItem }

    private func activate() {
        guard model.enabled, model.action != .none else { return }
        onAction(model.action)
        // A row that stays open keeps the menu up; every other row closes it, as a native row does.
        if !model.keepsMenuOpen { enclosingMenuItem?.menu?.cancelTracking() }
    }
}
