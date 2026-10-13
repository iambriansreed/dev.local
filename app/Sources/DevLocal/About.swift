import AppKit

/// The About panel: the stock one, filled in from the bundle (name, version and build,
/// NSHumanReadableCopyright), with the website footer's credit under it: "Made with ♥ by
/// Brian", the heart drawn from Heart.svg (the footer's own path and accent colour).
@MainActor
enum About {
    /// The link's colour: the heart's indigo, lightened in dark mode (the website's
    /// --accent-hover, #a5b4fc) and deepened in light mode (#4f46e5), since the heart's own
    /// #6366f1 is hard to read as text on either panel background.
    static let linkColor = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0xa5 / 255, green: 0xb4 / 255, blue: 0xfc / 255, alpha: 1)
            : NSColor(srgbRed: 0x4f / 255, green: 0x46 / 255, blue: 0xe5 / 255, alpha: 1)
    }

    static func show() {
        // Activated first, since an accessory app's window otherwise opens behind the
        // frontmost app's.
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits()])
        colorLink()
    }

    /// A text view draws links with its own linkTextAttributes (the system blue), whatever
    /// colour the string gives them, so the credit's text view in the open panel is found and
    /// given linkColor.
    private static func colorLink() {
        for window in NSApp.windows {
            guard let view = window.contentView, let text = creditsView(in: view) else { continue }
            text.linkTextAttributes = [
                .foregroundColor: linkColor,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
                .cursor: NSCursor.pointingHand,
            ]
            return
        }
    }

    private static func creditsView(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView, text.string.hasPrefix("Made with") { return text }
        for child in view.subviews {
            if let found = creditsView(in: child) { return found }
        }
        return nil
    }

    static func credits() -> NSAttributedString {
        let font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        let centered = NSMutableParagraphStyle()
        centered.alignment = .center
        let plain: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: centered]
        var link = plain
        link[.link] = URL(string: "https://iambrian.com")!

        let text = NSMutableAttributedString(string: "Made with ", attributes: plain)
        text.append(heart(font: font, attributes: plain))
        text.append(NSAttributedString(string: " by ", attributes: plain))
        text.append(NSAttributedString(string: "Brian", attributes: link))
        return text
    }

    /// The heart, 1.5em square (bigger than the footer's 1em, since the panel's credit text is
    /// small) and centred on the capitals so it sits level with the words around it. A text
    /// heart if the image is missing.
    private static func heart(font: NSFont, attributes: [NSAttributedString.Key: Any]) -> NSAttributedString {
        guard let url = Bundle.main.url(forResource: "Heart", withExtension: "svg"),
              let image = NSImage(contentsOf: url) else {
            return NSAttributedString(string: "♥", attributes: attributes)
        }
        let side = (font.pointSize * 1.5).rounded()
        let attachment = NSTextAttachment()
        attachment.image = image
        attachment.bounds = CGRect(x: 0, y: ((font.capHeight - side) / 2).rounded(), width: side, height: side)
        let heart = NSMutableAttributedString(attachment: attachment)
        heart.addAttributes(attributes, range: NSRange(location: 0, length: heart.length))
        return heart
    }
}
