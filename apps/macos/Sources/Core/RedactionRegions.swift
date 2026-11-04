import Foundation

/// Where the upload will hide text, as the member sees it: red spans in reading order.
public enum RedactionRegions {
    /// Every occurrence of each hidden piece in `text` (as UTF-16 ranges, the way AppKit counts), top to bottom.
    /// Occurrences that overlap or touch are one span, so the same text always gives the same spans no matter in
    /// which order the pieces were found.
    public static func ranges(in text: String, hidden: [String]) -> [NSRange] {
        let source = text as NSString
        var found: [NSRange] = []
        for piece in Set(hidden) where !piece.isEmpty {
            var from = 0
            while from < source.length {
                let range = source.range(of: piece, options: .literal, range: NSRange(location: from, length: source.length - from))
                if range.location == NSNotFound { break }
                found.append(range)
                from = range.location + range.length
            }
        }
        var merged: [NSRange] = []
        for range in found.sorted(by: { $0.location != $1.location ? $0.location < $1.location : $0.length > $1.length }) {
            if let last = merged.last, range.location <= last.location + last.length {
                merged[merged.count - 1].length = max(last.length, range.location + range.length - last.location)
            } else {
                merged.append(range)
            }
        }
        return merged
    }

    /// The span a click on the red notice should show next: the first one, then each following one, then back to the first.
    public static func next(after current: Int?, count: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let current else { return 0 }
        return (min(current, count - 1) + 1) % count
    }
}
