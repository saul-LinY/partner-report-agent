import Foundation

/// Removes values that grant access (keys, tokens, passwords) from conversation text before it
/// leaves the Mac. It touches nothing else: wording, whitespace, paths and addresses stay as written.
///
/// The rules mirror `redactCredentials` in `packages/contracts/src/privacy.ts` and are checked
/// against the shared vectors in `privacy-vectors.json`. Boundaries are spelled out in ASCII
/// instead of `\b`, because ICU treats CJK characters as word characters and JavaScript does not.
public enum SecretScrubber {
    public static let hidden = "[已隐藏]"

    private static func compile(_ pattern: String, caseInsensitive: Bool = false) -> NSRegularExpression {
        // The patterns are constants covered by tests, so a failure here is a programming error.
        try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    private static let credentialPatterns: [NSRegularExpression] = [
        compile(#"(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}"#),
        compile(#"(?<![A-Za-z0-9_])(?:ghp|gho|github_pat|xox[abp]|AKIA)[A-Za-z0-9_-]{12,}"#),
        compile(#"(?<![A-Za-z0-9_])Bearer\s+[A-Za-z0-9._~-]{16,}"#, caseInsensitive: true),
        compile(#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"#),
        compile(#"(?<![A-Za-z0-9_])(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{4,}"#, caseInsensitive: true),
        compile(#"(?<![A-Za-z0-9_])[A-Fa-f0-9]{32,}(?![A-Za-z0-9_])"#),
        compile(#"(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])"#),
    ]

    // A secret written as a sentence ("口令设成 123456") sits some words after its keyword.
    private static let credentialContext = compile(
        #"(密码|口令|密钥|令牌|凭证|token|secret|passwd|password)([^。，,；;！!？?\n]{0,40})"#, caseInsensitive: true)
    // A token touching a slash is a path segment, not a secret.
    private static let contextToken = compile(
        #"(?<![A-Za-z0-9!@#$%^&*_.\-/\\])[A-Za-z0-9!@#$%^&*_.-]{6,}(?![A-Za-z0-9!@#$%^&*_.\-/\\])"#)
    private static let hiddenTemplate = NSRegularExpression.escapedTemplate(for: hidden)

    private static func replaceAll(_ regex: NSRegularExpression, in text: String) -> String {
        regex.stringByReplacingMatches(
            in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length), withTemplate: hiddenTemplate)
    }

    public static func redact(_ text: String) -> String {
        var out = text
        for pattern in credentialPatterns { out = replaceAll(pattern, in: out) }
        let source = out as NSString
        var result = ""
        var last = 0
        for match in credentialContext.matches(in: out, options: [], range: NSRange(location: 0, length: source.length)) {
            result += source.substring(with: NSRange(location: last, length: match.range.location - last))
            let keyword = source.substring(with: match.range(at: 1))
            let rest = source.substring(with: match.range(at: 2))
            result += keyword + replaceAll(contextToken, in: rest)
            last = match.range.location + match.range.length
        }
        return result + source.substring(from: last)
    }

    /// What `redact` would upload, and the exact pieces of the original it hides (for showing them to the user).
    public struct Analysis: Equatable, Sendable {
        public var text: String
        public var hidden: [String]
    }

    /// Text being rewritten, remembering which original UTF-16 offset every unit came from.
    private struct Working {
        var units: [UInt16]
        var origin: [Int]
        var spans: [Range<Int>] = []
        var string: String { String(decoding: units, as: UTF16.self) }

        mutating func hide(_ ranges: [NSRange]) {
            guard !ranges.isEmpty else { return }
            let marker = Array(SecretScrubber.hidden.utf16)
            var nextUnits: [UInt16] = [], nextOrigin: [Int] = [], cursor = 0
            nextUnits.reserveCapacity(units.count)
            nextOrigin.reserveCapacity(units.count)
            for range in ranges {
                nextUnits += units[cursor..<range.location]
                nextOrigin += origin[cursor..<range.location]
                let covered = origin[range.location..<(range.location + range.length)].filter { $0 >= 0 }
                if let low = covered.min(), let high = covered.max() { spans.append(low..<(high + 1)) }
                nextUnits += marker
                nextOrigin += Array(repeating: -1, count: marker.count)
                cursor = range.location + range.length
            }
            nextUnits += units[cursor...]
            nextOrigin += origin[cursor...]
            units = nextUnits; origin = nextOrigin
        }
    }

    private static func matchRanges(_ regex: NSRegularExpression, in text: String) -> [NSRange] {
        regex.matches(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length)).map(\.range)
    }

    /// Same rules as `redact`, applied in the same order, additionally reporting what was hidden.
    /// Kept separate so the upload path stays a plain string rewrite; tests require identical output.
    public static func analyze(_ text: String) -> Analysis {
        let units = Array(text.utf16)
        var working = Working(units: units, origin: Array(0..<units.count))
        for pattern in credentialPatterns { working.hide(matchRanges(pattern, in: working.string)) }
        let current = working.string
        let source = current as NSString
        var tokens: [NSRange] = []
        for match in credentialContext.matches(in: current, options: [], range: NSRange(location: 0, length: source.length)) {
            let rest = match.range(at: 2)
            tokens += matchRanges(contextToken, in: source.substring(with: rest))
                .map { NSRange(location: rest.location + $0.location, length: $0.length) }
        }
        working.hide(tokens)
        var merged: [Range<Int>] = []
        for span in working.spans.sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = merged.last, span.lowerBound <= last.upperBound { merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, span.upperBound) }
            else { merged.append(span) }
        }
        let original = text as NSString
        return Analysis(text: working.string, hidden: merged.map { original.substring(with: NSRange(location: $0.lowerBound, length: $0.count)) })
    }

    public static func redact(_ turn: ChatTurn) -> ChatTurn {
        var copy = turn
        copy.prompt = redact(turn.prompt)
        copy.answer = turn.answer.map(redact)
        return copy
    }

    public static func redact(_ session: CollectorSession) -> CollectorSession {
        var copy = session
        copy.title = redact(session.title)
        copy.turns = session.turns.map(redact)
        return copy
    }
}
