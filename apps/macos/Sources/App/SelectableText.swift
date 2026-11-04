import AppKit
import SwiftUI
import WeeklyReportCore

/// Selectable text. Given handlers, its context menu can hide a selection from every upload or take a red piece back;
/// without them (work cards) it offers neither.
struct SelectableText: NSViewRepresentable {
    let text: NSAttributedString
    var onHide: ((String) -> Void)? = nil
    var onReveal: ((String) -> Void)? = nil
    /// Shrink to the longest line (chat bubbles). Everything else takes the full width it is offered.
    var snug = false

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
        view.onReveal = onReveal
        if !view.attributedString().isEqual(to: text) { view.textStorage?.setAttributedString(text) }
    }

    /// SwiftUI asks for the size at several widths (the real one and probes for the minimum). The measuring therefore
    /// uses a scratch text layout: resizing the live text container for a probe left it wrapping at the probe's width
    /// while the view kept the real frame, so the extra lines overflowed onto whatever came next.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView view: HidingTextView, context: Context) -> CGSize? {
        let offered = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 480
        let full = Self.measure(text, width: offered)
        guard snug else { return CGSize(width: offered, height: full.height) }
        let snugWidth = min(offered, full.width + 2)
        let narrow = Self.measure(text, width: snugWidth)
        // If the narrower width wraps differently, keep the full width rather than overflow.
        return narrow.height > full.height ? CGSize(width: offered, height: full.height) : CGSize(width: snugWidth, height: narrow.height)
    }

    private static func measure(_ text: NSAttributedString, width: CGFloat) -> CGSize {
        let storage = NSTextStorage(attributedString: text)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container)
        return CGSize(width: ceil(used.width), height: ceil(used.height))
    }
}

final class HidingTextView: NSTextView {
    var onHide: ((String) -> Void)?
    var onReveal: ((String) -> Void)?

    /// The red piece at a character position, if any.
    private func redPiece(at index: Int) -> String? {
        guard let storage = textStorage, index >= 0, index < storage.length else { return nil }
        return storage.attribute(.redactionPiece, at: index, effectiveRange: nil) as? String
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        let selection = selectedRange()
        let clicked = characterIndexForInsertion(at: convert(event.locationInWindow, from: nil))
        let clickedInSelection = selection.length > 0 && NSLocationInRange(clicked, selection)
        let anchor = selection.length > 0 && clickedInSelection ? selection.location : clicked
        if let piece = redPiece(at: anchor) ?? (clicked > 0 && selection.length == 0 ? redPiece(at: clicked - 1) : nil), onReveal != nil {
            add("取消隐藏（上传原文）", piece, #selector(reveal(_:)), to: menu)
        } else if selection.length > 0, onHide != nil {
            add("隐藏所选内容（不上传）", (string as NSString).substring(with: selection), #selector(hideSelection(_:)), to: menu)
        }
        return menu
    }

    private func add(_ title: String, _ value: String, _ action: Selector, to menu: NSMenu) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.representedObject = value
        menu.insertItem(item, at: 0)
        menu.insertItem(.separator(), at: 1)
    }

    @objc private func hideSelection(_ sender: NSMenuItem) {
        if let value = sender.representedObject as? String { onHide?(value) }
    }

    @objc private func reveal(_ sender: NSMenuItem) {
        if let value = sender.representedObject as? String { onReveal?(value) }
    }

    // Not a scroll view: let the conversation scroll when the pointer is over a message.
    override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
}

extension NSAttributedString.Key {
    /// Marks a red piece with the exact text the upload hides there.
    static let redactionPiece = NSAttributedString.Key("weeklyreport.redactionPiece")
}

/// Builds what the conversation shows: markdown styling plus red marks on what the upload will hide.
enum MessageText {
    private static let size: CGFloat = AppFont.size(13)

    private static func baseAttributes(size: CGFloat = size, monospaced: Bool = false) -> [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 5
        return [
            .font: monospaced ? NSFont.monospacedSystemFont(ofSize: size, weight: .regular) : NSFont.systemFont(ofSize: size),
            .foregroundColor: NSColor.labelColor,
            .paragraphStyle: style,
        ]
    }

    /// A reply is laid out in blocks split on blank lines; a block that starts with a fence is code.
    static func replyBlocks(_ text: String) -> [String] { text.components(separatedBy: "\n\n") }

    static func isCode(_ block: String) -> Bool { block.hasPrefix("```") }

    static func codeBody(_ block: String) -> String {
        block.components(separatedBy: "\n").dropFirst().filter { !$0.hasPrefix("```") }.joined(separator: "\n")
    }

    /// `focus` is the red span (counted from 0, top to bottom) the member was just taken to; it is drawn stronger than the rest.
    static func plain(_ text: String, hidden: [String], focus: Int? = nil) -> NSAttributedString {
        mark(NSMutableAttributedString(string: text, attributes: baseAttributes()), hidden: hidden, focus: focus)
    }

    static func code(_ text: String, hidden: [String], focus: Int? = nil) -> NSAttributedString {
        mark(NSMutableAttributedString(string: text, attributes: baseAttributes(size: AppFont.size(12), monospaced: true)), hidden: hidden, focus: focus)
    }

    static func markdown(_ block: String, hidden: [String], focus: Int? = nil) -> NSAttributedString {
        guard let parsed = try? AttributedString(markdown: block, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else {
            return plain(block, hidden: hidden, focus: focus)
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
        return mark(out, hidden: hidden, focus: focus)
    }

    /// One block of a reply as it reads on screen.
    static func reply(block: String, hidden: [String], focus: Int? = nil) -> NSAttributedString {
        isCode(block) ? code(codeBody(block), hidden: hidden, focus: focus) : markdown(block, hidden: hidden, focus: focus)
    }

    /// The words a block shows on screen, without any red marks. Markdown drops its own symbols, so this is what red spans are counted in.
    static func shown(_ block: String, isAnswer: Bool) -> String {
        isAnswer ? reply(block: block, hidden: []).string : block
    }

    /// Every occurrence of each hidden piece, matched by text because markdown changes the offsets.
    private static func mark(_ text: NSMutableAttributedString, hidden: [String], focus: Int?) -> NSAttributedString {
        let source = text.string as NSString
        for piece in Set(hidden) where !piece.isEmpty {
            var from = 0
            while from < source.length {
                let range = source.range(of: piece, options: .literal, range: NSRange(location: from, length: source.length - from))
                if range.location == NSNotFound { break }
                text.removeAttribute(.link, range: range)
                text.removeAttribute(.underlineStyle, range: range)
                text.addAttributes([.foregroundColor: NSColor(Palette.red), .backgroundColor: NSColor(Palette.red).withAlphaComponent(0.14), .redactionPiece: piece], range: range)
                from = range.location + range.length
            }
        }
        if let focus {
            let spans = RedactionRegions.ranges(in: text.string, hidden: hidden)
            if spans.indices.contains(focus) {
                text.addAttributes([.backgroundColor: NSColor(Palette.red).withAlphaComponent(0.4), .underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: NSColor(Palette.red)], range: spans[focus])
            }
        }
        return text
    }
}

/// Pieces of a message the upload will hide, found once per text and set of member decisions.
enum RedactionMarks {
    private final class Box { let value: [String]; init(_ value: [String]) { self.value = value } }
    // NSCache is thread-safe; the compiler just cannot see that.
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = { let cache = NSCache<NSString, Box>(); cache.countLimit = 4000; return cache }()

    static func hidden(in text: String, hiding: SecretScrubber.Hiding) -> [String] {
        let key = "\(hiding.hashValue)-\(text.hashValue)-\(text.utf8.count)" as NSString
        if let box = cache.object(forKey: key) { return box.value }
        let value = SecretScrubber.analyze(text, hiding: hiding).hidden
        cache.setObject(Box(value), forKey: key)
        return value
    }
}

/// One red span as the conversation lays it out: which message, which text block in it, and which red span in that block.
struct RedRegion: Equatable {
    let messageID: String
    let block: Int
    let occurrence: Int
    /// Scroll target of the block that holds this span.
    var blockID: String { "\(messageID)#\(block)" }
}

enum RedRegions {
    private final class Box { let value: [Int]; init(_ value: [Int]) { self.value = value } }
    // NSCache is thread-safe; the compiler just cannot see that.
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = { let cache = NSCache<NSString, Box>(); cache.countLimit = 4000; return cache }()

    /// Red spans in each text block of a message, found once per text and set of member decisions.
    private static func counts(in message: ConversationMessage, hiding: SecretScrubber.Hiding) -> [Int] {
        let key = "\(hiding.hashValue)-\(message.isAnswer)-\(message.text.hashValue)-\(message.text.utf8.count)" as NSString
        if let box = cache.object(forKey: key) { return box.value }
        let hidden = RedactionMarks.hidden(in: message.text, hiding: hiding)
        var value: [Int] = []
        if !hidden.isEmpty {
            let blocks = message.isAnswer ? MessageText.replyBlocks(message.text) : [message.text]
            value = blocks.map { RedactionRegions.ranges(in: MessageText.shown($0, isAnswer: message.isAnswer), hidden: hidden).count }
        }
        cache.setObject(Box(value), forKey: key)
        return value
    }

    /// Every red span in the conversation, top to bottom.
    static func all(in messages: [ConversationMessage], hiding: SecretScrubber.Hiding) -> [RedRegion] {
        messages.flatMap { message in
            counts(in: message, hiding: hiding).enumerated().flatMap { block, count in
                (0..<count).map { RedRegion(messageID: message.id, block: block, occurrence: $0) }
            }
        }
    }
}
