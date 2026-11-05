import Foundation

/// Hides what must not leave this Mac: values that grant access (keys, tokens, passwords), details that
/// identify a person, machine or place (email, phone, IP address, URL, local path) and whatever the
/// member marked by hand. It touches nothing else: wording and whitespace stay as written.
///
/// The automatic rules mirror `redactSensitive` in `packages/contracts/src/privacy.ts` and are checked
/// against the shared vectors in `privacy-vectors.json`. Boundaries and classes are spelled out in
/// ASCII instead of `\b`, `\w` and `\d`, because ICU treats CJK characters as word characters and
/// accepts non-ASCII digits, and JavaScript does neither.
public enum SecretScrubber {
    public static let hidden = "[已隐藏]"

    /// What the member decided on top of the automatic rules: `terms` are hidden wherever they occur, `patterns`
    /// (regular expressions the member wrote) hide whatever they match, and an automatic or pattern match whose
    /// text is exactly one of `allowed` is let through. Red in the UI means "hidden on upload".
    public struct Hiding: Hashable, Sendable, Codable {
        public var terms: [String] = []
        public var allowed: [String] = []
        public var patterns: [String] = []
        public init(terms: [String] = [], allowed: [String] = [], patterns: [String] = []) { self.terms = terms; self.allowed = allowed; self.patterns = patterns }
        public static let none = Hiding()
    }

    /// Why a regular expression written by the member cannot be used.
    public enum PatternProblem: Equatable, Sendable {
        case invalid, matchesEmptyText, tooSlow
        public var message: String {
            switch self {
            case .invalid: "正则表达式写法有误，请检查括号、转义和方括号是否成对。"
            case .matchesEmptyText: "这条规则会匹配空文字，范围过宽，请写得更具体一些。"
            case .tooSlow: "这条规则匹配起来太慢，可能会卡住 App，请换一种写法。"
            }
        }
    }

    private final class RegexBox { let value: NSRegularExpression?; init(_ value: NSRegularExpression?) { self.value = value } }
    // NSCache is thread-safe; the compiler just cannot see that.
    nonisolated(unsafe) private static let userRegexCache: NSCache<NSString, RegexBox> = { let cache = NSCache<NSString, RegexBox>(); cache.countLimit = 200; return cache }()
    /// A text longer than this on any one rule is not worth waiting for: see `termRanges`.
    private static let patternBudget: TimeInterval = 1

    private static func userRegex(_ pattern: String) -> NSRegularExpression? {
        if let box = userRegexCache.object(forKey: pattern as NSString) { return box.value }
        let regex = try? NSRegularExpression(pattern: pattern)
        userRegexCache.setObject(RegexBox(regex), forKey: pattern as NSString)
        return regex
    }

    /// Non-empty matches of a member's expression, or nil if matching ran past `budget` (a runaway expression).
    private static func userMatches(_ regex: NSRegularExpression, in text: String, budget: TimeInterval) -> [NSRange]? {
        let deadline = Date.now.addingTimeInterval(budget)
        var found: [NSRange] = []
        var timedOut = false
        regex.enumerateMatches(in: text, options: [.reportProgress], range: NSRange(location: 0, length: (text as NSString).length)) { result, _, stop in
            if Date.now > deadline { timedOut = true; stop.pointee = true; return }
            if let range = result?.range, range.length > 0 { found.append(range) }
        }
        return timedOut ? nil : found
    }

    /// nil when the expression can be used; otherwise the reason it was refused. Syntax is ICU's (what macOS provides):
    /// case-sensitive unless it starts with `(?i)`.
    public static func problem(withPattern pattern: String) -> PatternProblem? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return .invalid }
        if regex.firstMatch(in: "", options: [], range: NSRange(location: 0, length: 0)) != nil { return .matchesEmptyText }
        // Typical runaway shapes such as `(a+)+$` stall on a long near-match; refuse them now instead of freezing later.
        for probe in [String(repeating: "a", count: 40) + "!", String(repeating: "ab ", count: 25) + "!"] {
            if userMatches(regex, in: probe, budget: 0.15) == nil { return .tooSlow }
        }
        return nil
    }

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
        compile(#"(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])"#),
    ]

    // A secret written as a sentence ("口令设成 123456") sits some words after its keyword.
    private static let credentialContext = compile(
        #"(密码|口令|密钥|令牌|凭证|token|secret|passwd|password)([^。，,；;！!？?\n]{0,40})"#, caseInsensitive: true)
    // A token touching a slash is a path segment, not a secret.
    private static let contextToken = compile(
        #"(?<![A-Za-z0-9!@#$%^&*_.\-/\\])[A-Za-z0-9!@#$%^&*_.-]{6,}(?![A-Za-z0-9!@#$%^&*_.\-/\\])"#)

    /// Identifying details. A URL goes before the email, IP address and path inside it.
    private static let identifyingPatterns: [NSRegularExpression] = [
        compile(#"(?<![A-Za-z0-9_])https?://[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+(?<![.,;:!?'])"#),
        compile(#"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"#),
        compile(#"(?<![A-Za-z0-9_.\-/~])(?:/(?:Users|home|var|private|tmp|Volumes)|~)/[^\s)）\]"'`，。；：！？、<>]+(?<![.,;:!?])"#),
        compile(#"(?<![A-Za-z0-9_])[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s)）\]"'`，。；：！？、<>]+(?<![.,;:!?])"#),
        compile(#"(?<![A-Za-z0-9_.])(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?::[0-9]{1,5})?(?![A-Za-z0-9_])(?!\.[0-9])"#),
        compile(#"(?<![0-9])(?:\+?86[ -]?)?1[3-9][0-9]{9}(?![0-9])"#),
    ]

    private static func replaceAll(_ regex: NSRegularExpression, in text: String, allowing allowed: Set<String>) -> String {
        let ranges = matchRanges(regex, in: text, allowing: allowed)
        guard !ranges.isEmpty else { return text }
        let source = text as NSString
        var out = "", cursor = 0
        for range in ranges {
            out += source.substring(with: NSRange(location: cursor, length: range.location - cursor)) + hidden
            cursor = range.location + range.length
        }
        return out + source.substring(from: cursor)
    }

    /// Terms and expressions the member marked by hand are hidden everywhere they occur, before the automatic rules run.
    private static func replaceTerms(_ hiding: Hiding, in text: String) -> String {
        let ranges = termRanges(hiding, in: text)
        guard !ranges.isEmpty else { return text }
        let source = text as NSString
        var out = "", cursor = 0
        for range in ranges {
            out += source.substring(with: NSRange(location: cursor, length: range.location - cursor)) + hidden
            cursor = range.location + range.length
        }
        return out + source.substring(from: cursor)
    }

    public static func redact(_ text: String, hiding: Hiding = .none) -> String {
        let allowed = Set(hiding.allowed)
        var out = replaceTerms(hiding, in: text)
        for pattern in credentialPatterns { out = replaceAll(pattern, in: out, allowing: allowed) }
        let source = out as NSString
        var result = ""
        var last = 0
        for match in credentialContext.matches(in: out, options: [], range: NSRange(location: 0, length: source.length)) {
            result += source.substring(with: NSRange(location: last, length: match.range.location - last))
            let keyword = source.substring(with: match.range(at: 1))
            let rest = source.substring(with: match.range(at: 2))
            result += keyword + replaceAll(contextToken, in: rest, allowing: allowed)
            last = match.range.location + match.range.length
        }
        out = result + source.substring(from: last)
        for pattern in identifyingPatterns { out = replaceAll(pattern, in: out, allowing: allowed) }
        return out
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

    private static func matchRanges(_ regex: NSRegularExpression, in text: String, allowing allowed: Set<String> = []) -> [NSRange] {
        let source = text as NSString
        return regex.matches(in: text, options: [], range: NSRange(location: 0, length: source.length)).map(\.range)
            .filter { allowed.isEmpty || !allowed.contains(source.substring(with: $0)) }
    }

    private static func termRanges(_ hiding: Hiding, in text: String) -> [NSRange] {
        let source = text as NSString
        var found: [NSRange] = []
        for term in Set(hiding.terms) where !term.isEmpty {
            var from = 0
            while from < source.length {
                let range = source.range(of: term, options: [.literal], range: NSRange(location: from, length: source.length - from))
                if range.location == NSNotFound { break }
                found.append(range); from = range.location + range.length
            }
        }
        let allowed = Set(hiding.allowed)
        for pattern in Set(hiding.patterns) where !pattern.isEmpty {
            guard let regex = userRegex(pattern) else { continue }
            // An expression that runs away on this text must not let anything through unhidden: hide all of it.
            guard let matches = userMatches(regex, in: text, budget: patternBudget) else { return [NSRange(location: 0, length: source.length)] }
            found += matches.filter { allowed.isEmpty || !allowed.contains(source.substring(with: $0)) }
        }
        // Overlapping matches collapse into one hidden piece.
        var merged: [NSRange] = []
        for range in found.sorted(by: { $0.location < $1.location }) {
            if let last = merged.last, range.location < last.location + last.length {
                merged[merged.count - 1] = NSRange(location: last.location, length: max(last.length, range.location + range.length - last.location))
            } else { merged.append(range) }
        }
        return merged
    }

    /// Same rules as `redact`, applied in the same order, additionally reporting what was hidden.
    /// Kept separate so the upload path stays a plain string rewrite; tests require identical output.
    public static func analyze(_ text: String, hiding: Hiding = .none) -> Analysis {
        let allowed = Set(hiding.allowed)
        let units = Array(text.utf16)
        var working = Working(units: units, origin: Array(0..<units.count))
        working.hide(termRanges(hiding, in: text))
        for pattern in credentialPatterns { working.hide(matchRanges(pattern, in: working.string, allowing: allowed)) }
        let current = working.string
        let source = current as NSString
        var tokens: [NSRange] = []
        for match in credentialContext.matches(in: current, options: [], range: NSRange(location: 0, length: source.length)) {
            let rest = match.range(at: 2)
            tokens += matchRanges(contextToken, in: source.substring(with: rest), allowing: allowed)
                .map { NSRange(location: rest.location + $0.location, length: $0.length) }
        }
        working.hide(tokens)
        for pattern in identifyingPatterns { working.hide(matchRanges(pattern, in: working.string, allowing: allowed)) }
        var merged: [Range<Int>] = []
        for span in working.spans.sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = merged.last, span.lowerBound <= last.upperBound { merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, span.upperBound) }
            else { merged.append(span) }
        }
        let original = text as NSString
        return Analysis(text: working.string, hidden: merged.map { original.substring(with: NSRange(location: $0.lowerBound, length: $0.count)) })
    }

    public static func redact(_ turn: ChatTurn, hiding: Hiding = .none) -> ChatTurn {
        var copy = turn
        copy.prompt = redact(turn.prompt, hiding: hiding)
        copy.answer = turn.answer.map { redact($0, hiding: hiding) }
        return copy
    }

    public static func redact(_ session: CollectorSession, hiding: Hiding = .none) -> CollectorSession {
        var copy = session
        copy.title = redact(session.title, hiding: hiding)
        copy.turns = session.turns.map { redact($0, hiding: hiding) }
        return copy
    }
}
