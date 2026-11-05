import Foundation

/// One line of the activity chart. `values` has one bucket per hour (24) or per day of the month.
public struct ActivitySeries: Equatable, Identifiable, Sendable {
    public var name: String
    public var values: [Int]
    /// The dashed 总计 line that adds the project lines up.
    public var isTotal: Bool
    public var id: String { name }
    public var sum: Int { values.reduce(0, +) }
}

/// The pure part of the 个人数据 page: bucketing of conversation turns and month/calendar arithmetic.
/// Everything works on the server's team-time strings ("YYYY-MM-DD", "YYYY-MM", "YYYY-MM-DDTHH:mm") so the
/// device's own time zone can never move a turn to another day.
public enum PersonalActivity {
    public static let singleLineName = "交互轮数"
    public static let totalName = "总计"

    /// The day of the most recent turn, which the day view opens on.
    public static func lastEventDay(_ events: [PersonalData.ActivityEvent]) -> String? {
        events.map(\.t).max().map { String($0.prefix(10)) }
    }

    /// 24 hourly buckets for `day`.
    public static func hourly(events: [PersonalData.ActivityEvent], day: String, projects: [String]) -> [ActivitySeries] {
        series(events: events, prefix: day, buckets: 24, projects: projects) { Int($0.dropFirst(11).prefix(2)) }
    }

    /// One bucket per day of `month`.
    public static func monthly(events: [PersonalData.ActivityEvent], month: String, projects: [String]) -> [ActivitySeries] {
        series(events: events, prefix: month, buckets: daysInMonth(month), projects: projects) { Int($0.dropFirst(8).prefix(2)).map { $0 - 1 } }
    }

    /// One line per project when the member has several, else a single line; several projects also get the total.
    private static func series(events: [PersonalData.ActivityEvent], prefix: String, buckets: Int, projects: [String], bucket: (String) -> Int?) -> [ActivitySeries] {
        let names = projects.count > 1 ? projects : [singleLineName]
        var lines = names.map { ActivitySeries(name: $0, values: Array(repeating: 0, count: buckets), isTotal: false) }
        let index = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })
        for event in events where event.t.hasPrefix(prefix) {
            guard let slot = bucket(event.t), (0..<buckets).contains(slot) else { continue }
            if projects.count > 1 {
                if let line = index[event.p] { lines[line].values[slot] += 1 }
            } else {
                lines[0].values[slot] += 1
            }
        }
        guard projects.count > 1 else { return lines }
        let total = (0..<buckets).map { slot in lines.reduce(0) { $0 + $1.values[slot] } }
        return lines + [ActivitySeries(name: totalName, values: total, isTotal: true)]
    }

    private static func parts(_ month: String) -> (year: Int, month: Int)? {
        let pieces = month.prefix(7).split(separator: "-")
        guard pieces.count == 2, let year = Int(pieces[0]), let value = Int(pieces[1]), (1...12).contains(value) else { return nil }
        return (year, value)
    }

    public static func daysInMonth(_ month: String) -> Int {
        guard let (year, value) = parts(month) else { return 0 }
        if value == 2 { return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28 }
        return [4, 6, 9, 11].contains(value) ? 30 : 31
    }

    /// `month` moved by `delta` months, as "YYYY-MM"; unparsable input is returned unchanged.
    public static func shiftMonth(_ month: String, by delta: Int) -> String {
        guard let (year, value) = parts(month) else { return month }
        let index = year * 12 + (value - 1) + delta
        return String(format: "%04d-%02d", index / 12, index % 12 + 1)
    }

    /// Every date of `month` as "YYYY-MM-DD".
    public static func dates(in month: String) -> [String] {
        (0..<daysInMonth(month)).map { "\(month.prefix(7))-" + String(format: "%02d", $0 + 1) }
    }

    /// The dates of a Monday-first month grid: whole weeks, leading and trailing days from the neighbouring months.
    public static func calendarGrid(month: String) -> [String] {
        guard let (year, value) = parts(month) else { return [] }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let first = calendar.date(from: DateComponents(year: year, month: value, day: 1)) else { return [] }
        let offset = (calendar.component(.weekday, from: first) + 5) % 7  // Sunday = 1 → 6, Monday = 2 → 0
        let length = (offset + daysInMonth(month) + 6) / 7 * 7
        return (0..<length).compactMap { calendar.date(byAdding: .day, value: $0 - offset, to: first) }.map {
            String(format: "%04d-%02d-%02d", calendar.component(.year, from: $0), calendar.component(.month, from: $0), calendar.component(.day, from: $0))
        }
    }

    /// "2026-11-05" → "2026年11月5日".
    public static func longDay(_ day: String) -> String {
        let pieces = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        return pieces.count == 3 ? "\(pieces[0])年\(pieces[1])月\(pieces[2])日" : day
    }

    /// "2026-11" → "2026年11月".
    public static func longMonth(_ month: String) -> String {
        guard let (year, value) = parts(month) else { return month }
        return "\(year)年\(value)月"
    }
}
