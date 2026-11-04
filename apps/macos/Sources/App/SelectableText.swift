import AppKit
import SwiftUI
import WeeklyReportCore

/// Selectable text whose context menu can hide the selection from every upload.
struct SelectableText: NSViewRepresentable {
    let text: NSAttributedString
    var onHide: (String) -> Void

    func makeNSView(context: Context) -> HidingTextView {
        let view = HidingTextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateNSView(_ view: HidingTextView, context: Context) {
        view.onHide = onHide
        if !view.attributedString().isEqual(to: text) { view.textStorage?.setAttributedString(text) }
    }

    /// Wraps at the offered width but is no wider than its longest line, so short messages keep a snug bubble.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: HidingTextView, context: Context) -> CGSize? {
        guard let container = view.textContainer, let layout = view.layoutManager else { return nil }
        let offered = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 480
        container.containerSize = NSSize(width: offered, height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        return CGSize(width: min(offered, ceil(used.width) + 2), height: ceil(used.height))
    }
}

final class HidingTextView: NSTextView {
    var onHide: ((String) -> Void)?

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        let range = selectedRange()
        guard range.length > 0 else { return menu }
        let item = NSMenuItem(title: "隐藏所选内容（不上传）", action: #selector(hideSelection(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = (string as NSString).substring(with: range)
        menu.insertItem(item, at: 0)
        menu.insertItem(.separator(), at: 1)
        return menu
    }

    @objc private func hideSelection(_ sender: NSMenuItem) {
        guard let selected = sender.representedObject as? String else { return }
        onHide?(selected)
    }

    // Not a scroll view: let the conversation scroll when the pointer is over a message.
    override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
}

/// Builds what the conversation shows: markdown styling plus red marks on what the upload will hide.
enum MessageText {
    private static let size: CGFloat = 13

    private static func baseAttributes(size: CGFloat = size, monospaced: Bool = false) -> [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 5
        return [
            .font: monospaced ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular) : NSFont.systemFont(ofSize: size),
            .foregroundColor: NSColor.labelColor,
            .paragraphStyle: style,
        ]
    }

    static func plain(_ text: String, hidden: [String]) -> NSAttributedString {
        mark(NSMutableAttributedString(string: text, attributes: baseAttributes()), hidden: hidden)
    }

    static func code(_ text: String, hidden: [String]) -> NSAttributedString {
        mark(NSMutableAttributedString(string: text, attributes: baseAttributes(size: 12, monospaced: true)), hidden: hidden)
    }

    static func markdown(_ block: String, hidden: [String]) -> NSAttributedString {
        guard let parsed = try? AttributedString(markdown: block, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else {
            return plain(block, hidden: hidden)
        }
        let out = NSMutableAttributedString()
        for run in parsed.runs {
            var attributes = baseAttributes()
            if let intent = run.inlinePresentationIntent {
                var font = NSFont.systemFont(ofSize: size, weight: intent.contains(.stronglyEmphasized) ? .semibold : .regular)
                if intent.contains(.emphasized) { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
                if intent.contains(.code) {
                    font = NSFont.monospacedSystemFont(ofSize: size - 1, weight: .regular)
                    attributes[.backgroundColor] = NSColor(Palette.quiet)
                }
                attributes[.font] = font
                if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            }
            if let link = run.link { attributes[.link] = link }
            out.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
        }
        return mark(out, hidden: hidden)
    }

    /// Every occurrence of each hidden piece, matched by text because markdown changes the offsets.
    private static func mark(_ text: NSMutableAttributedString, hidden: [String]) -> NSAttributedString {
        let source = text.string as NSString
        for piece in Set(hidden) where !piece.isEmpty {
            var from = 0
            while from < source.length {
                let range = source.range(of: piece, options: .literal, range: NSRange(location: from, length: source.length - from))
                if range.location == NSNotFound { break }
                text.removeAttribute(.link, range: range)
                text.removeAttribute(.underlineStyle, range: range)
                text.addAttributes([.foregroundColor: NSColor(Palette.red), .backgroundColor: NSColor(Palette.red).withAlphaComponent(0.14)], range: range)
                from = range.location + range.length
            }
        }
        return text
    }
}

/// Pieces of a message the upload will hide, found once per text and set of marked terms.
enum RedactionMarks {
    private final class Box { let value: [String]; init(_ value: [String]) { self.value = value } }
    // NSCache is thread-safe; the compiler just cannot see that.
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = { let cache = NSCache<NSString, Box>(); cache.countLimit = 4000; return cache }()

    static func hidden(in text: String, terms: [String]) -> [String] {
        let key = "\(terms.hashValue)-\(text.hashValue)-\(text.utf8.count)" as NSString
        if let box = cache.object(forKey: key) { return box.value }
        let value = SecretScrubber.analyze(text, hiding: terms).hidden
        cache.setObject(Box(value), forKey: key)
        return value
    }
}
