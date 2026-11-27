import Foundation

/// One line of the activity chart. `values` has one bucket per hour (24) or per day of the week.
public struct ActivitySeries: Equatable, Identifiable, Sendable {
    public var name: String
    public var values: [Int]
    /// The dashed 总计 line that adds the project lines up.
    public var isTotal: Bool
    /// Position in the page's colour palette; the same project has the same colour on its card and in the chart.
    public var colorIndex: Int
    public var id: String { name }
    public var sum: Int { values.reduce(0, +) }
    public init(name: String, values: [Int], isTotal: Bool, colorIndex: Int = 0) {
        self.name = name; self.values = values; self.isTotal = isTotal; self.colorIndex = colorIndex
    }
}

/// The pure part of the 本周进展 page: bucketing of conversation turns and the week's calendar arithmetic.
/// Events are the server's team-time strings ("YYYY-MM-DDTHH:mm"), so the device's own time zone can never move a
/// turn to another day; only the period's absolute instants are converted, and always into the team's zone.
public enum PersonalActivity {
    public static let singleLineName = "交互轮数"
    public static let totalName = "总计"

    /// The latest of `days` that has a turn, which the hour view opens on.
    public static func lastEventDay(_ events: [PersonalData.ActivityEvent], within days: [String]) -> String? {
        let allowed = Set(days)
        return events.map { String($0.t.prefix(10)) }.filter(allowed.contains).max()
    }

    /// 24 hourly buckets for `day`.
    public static func hourly(events: [PersonalData.ActivityEvent], day: String, projects: [String]) -> [ActivitySeries] {
        series(events: events.filter { $0.t.hasPrefix(day) }, buckets: 24, projects: projects) { Int($0.dropFirst(11).prefix(2)) }
    }

    /// One bucket per entry of `days` ("YYYY-MM-DD").
    public static func daily(events: [PersonalData.ActivityEvent], days: [String], projects: [String]) -> [ActivitySeries] {
        let slots = Dictionary(uniqueKeysWithValues: days.enumerated().map { ($1, $0) })
        return series(events: events, buckets: days.count, projects: projects) { slots[String($0.prefix(10))] }
    }

    /// One line per project when the member has several, else a single line; several projects also get the total.
    private static func series(events: [PersonalData.ActivityEvent], buckets: Int, projects: [String], bucket: (String) -> Int?) -> [ActivitySeries] {
        let names = projects.count > 1 ? projects : [singleLineName]
        var lines = names.enumerated().map { ActivitySeries(name: $1, values: Array(repeating: 0, count: buckets), isTotal: false, colorIndex: $0) }
        let index = Dictionary(names.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        for event in events {
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

    // MARK: Team-time calendar

    /// A Gregorian calendar in the team's zone. Falls back to the device zone only when the server sent none we know.
    static func calendar(_ timezone: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timezone) ?? .current
        return calendar
    }

    /// The team-time calendar day of an instant, "YYYY-MM-DD".
    public static func day(of date: Date, timezone: String) -> String {
        let c = calendar(timezone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The team-time clock of an instant, "HH:mm".
    public static func clock(of date: Date, timezone: String) -> String {
        let c = calendar(timezone).dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// "2026-11-17" or "2026-11-17T15:59" → "11月17日".
    public static func monthDay(_ day: String) -> String {
        let pieces = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        return pieces.count == 3 ? "\(pieces[1])月\(pieces[2])日" : day
    }

    /// "2026-11-17" → "周二". Weekdays are the same in every zone for a calendar date, so UTC is used.
    public static func weekday(_ day: String) -> String {
        let p = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        guard p.count == 3, let date = utc.date(from: DateComponents(year: p[0], month: p[1], day: p[2])) else { return "" }
        return "周" + ["日", "一", "二", "三", "四", "五", "六"][utc.component(.weekday, from: date) - 1]
    }

    /// Whole calendar days from `from` to `to`, both "YYYY-MM-DD".
    public static func dayDistance(from: String, to: String) -> Int? {
        func ordinal(_ day: String) -> Int? {
            let p = day.prefix(10).split(separator: "-").compactMap { Int($0) }
            var utc = Calendar(identifier: .gregorian)
            utc.timeZone = TimeZone(identifier: "UTC")!
            guard p.count == 3, let date = utc.date(from: DateComponents(year: p[0], month: p[1], day: p[2])) else { return nil }
            return Int((date.timeIntervalSince1970 / 86_400).rounded())
        }
        guard let a = ordinal(from), let b = ordinal(to) else { return nil }
        return b - a
    }

    /// `day` moved by `offset` calendar days, "YYYY-MM-DD"; `day` itself when it is not a date.
    public static func shift(_ day: String, by offset: Int) -> String {
        let p = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        guard p.count == 3, let date = utc.date(from: DateComponents(year: p[0], month: p[1], day: p[2] + offset)) else { return day }
        let c = utc.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// An instant as "11月17日 11:10" in team time.
    public static func stamp(_ date: Date, timezone: String) -> String {
        "\(monthDay(day(of: date, timezone: timezone))) \(clock(of: date, timezone: timezone))"
    }

    /// "2026-11-17T15:59" → "11月17日 15:59".
    public static func stamp(_ teamTime: String) -> String {
        teamTime.count >= 16 ? "\(monthDay(teamTime)) \(teamTime.dropFirst(11).prefix(5))" : monthDay(teamTime)
    }

    /// How long until `cutoff`: "2 天 5 小时", "5 小时 12 分钟", "12 分钟"; "已截止" once it has passed.
    public static func countdown(to cutoff: Date, now: Date) -> String {
        let minutes = Int(cutoff.timeIntervalSince(now) / 60)
        guard minutes > 0 else { return "已截止" }
        let (days, hours, rest) = (minutes / 1440, minutes % 1440 / 60, minutes % 60)
        if days > 0 { return "\(days) 天 \(hours) 小时" }
        if hours > 0 { return "\(hours) 小时 \(rest) 分钟" }
        return "\(rest) 分钟"
    }
}

extension PersonalData {
    /// Every calendar day of the period, from the day it starts to the day it is cut off, "YYYY-MM-DD".
    public var days: [String] {
        let first = PersonalActivity.day(of: period.startsAt, timezone: timezone)
        let last = PersonalActivity.day(of: period.cutoffAt, timezone: timezone)
        let calendar = PersonalActivity.calendar(timezone)
        var days: [String] = []
        var cursor = period.startsAt
        // The loop is bounded: a period is days long, and a malformed one (cutoff before start) yields just its first day.
        while days.count < 62 {
            let day = PersonalActivity.day(of: cursor, timezone: timezone)
            if day > last { break }
            if days.last != day { days.append(day) }
            guard let next = calendar.date(byAdding: .day, value: 1, to: cursor) else { break }
            cursor = next
        }
        return days.isEmpty ? [first] : days
    }

    /// The team's today, as of the moment the server answered.
    public var today: String { PersonalActivity.day(of: generatedAt ?? Date(), timezone: timezone) }

    /// The days that have begun; later days of the week are not drawn.
    public var elapsedDays: [String] { days.filter { $0 <= today } }

    /// "W47" from the period key ("2026-W47"); the whole key when it has no week number.
    public var weekLabel: String {
        guard let range = period.periodKey.range(of: #"W\d+"#, options: .regularExpression) else { return period.periodKey }
        return String(period.periodKey[range])
    }

    /// "11月17日 11:10 – 11月20日（周五）16:00".
    public var rangeLabel: String {
        let end = PersonalActivity.day(of: period.cutoffAt, timezone: timezone)
        return "\(PersonalActivity.stamp(period.startsAt, timezone: timezone)) – \(PersonalActivity.monthDay(end))（\(PersonalActivity.weekday(end))）\(PersonalActivity.clock(of: period.cutoffAt, timezone: timezone))"
    }

    /// Which of the four week steps is under way at `now`: 0 recording, 2 review (cards are generated at the cutoff), 3 published.
    public func currentStep(now: Date) -> Int {
        if now < period.cutoffAt { return 0 }
        return now < period.autoApproveAt ? 2 : 3
    }

}

/// 工作投入: the same figures as the leadership page's member view, computed live over `history`.
extension PersonalData {
    /// Projects with turns in the window, most first; the order is each project's colour slot.
    public var investmentProjects: [String] {
        let counts = Dictionary(grouping: history.events, by: \.p).mapValues(\.count)
        return counts.keys.sorted { counts[$0]! != counts[$1]! ? counts[$0]! > counts[$1]! : $0 < $1 }
    }

    /// The first of the 28 team days ending today.
    public var from28: String { PersonalActivity.shift(today, by: -27) }
    private var recent28: [ActivityEvent] { history.events.filter { $0.t.prefix(10) >= from28 } }
    public var turns28: Int { recent28.count }
    public var activeDays28: Int { Set(recent28.map { $0.t.prefix(10) }).count }
    public var lastActiveDay: String? { history.events.map { String($0.t.prefix(10)) }.max() }

    /// Each project's part of the last 28 days, largest first; projects without turns are left out.
    public var shares: [(name: String, turns: Int, colorIndex: Int)] {
        let counts = Dictionary(grouping: recent28, by: \.p).mapValues(\.count)
        return investmentProjects.enumerated()
            .compactMap { index, name in counts[name].map { (name: name, turns: $0, colorIndex: index) } }
            .sorted { $0.turns > $1.turns }
    }

    /// Every day of `month` ("YYYY-MM"), "YYYY-MM-DD".
    public static func days(ofMonth month: String) -> [String] {
        let first = "\(month)-01"
        guard PersonalActivity.dayDistance(from: first, to: first) != nil else { return [] }
        return (0..<31).map { PersonalActivity.shift(first, by: $0) }.filter { $0.hasPrefix(month) }
    }

    /// 24 hourly lines for `day`.
    public func investmentHourly(day: String) -> [ActivitySeries] {
        Self.withoutIdle(PersonalActivity.hourly(events: history.events, day: day, projects: investmentProjects))
    }

    /// One bucket per day of `month`.
    public func investmentDaily(month: String) -> [ActivitySeries] {
        Self.withoutIdle(PersonalActivity.daily(events: history.events, days: Self.days(ofMonth: month), projects: investmentProjects))
    }

    /// Projects without a turn in the viewed range get no line; the 总计 line stays only while several lines remain.
    private static func withoutIdle(_ lines: [ActivitySeries]) -> [ActivitySeries] {
        let kept = lines.filter { !$0.isTotal && $0.sum > 0 }
        guard kept.count > 1, let total = lines.first(where: \.isTotal) else { return kept }
        return kept + [total]
    }
}

extension PersonalData {
    /// "周五": the weekday the period is cut off and the work cards are generated.
    public var cutoffWeekday: String { PersonalActivity.weekday(PersonalActivity.day(of: period.cutoffAt, timezone: timezone)) }
    /// "周一": the weekday the leadership panel is published.
    public var publishWeekday: String { PersonalActivity.weekday(PersonalActivity.day(of: period.publishAt, timezone: timezone)) }
    /// The week's project count that have a kept session: "涉及 N 个项目".
    public var activeProjectCount: Int { projects.filter(\.hasActivity).count }
    /// True when the last upload was before today (or there is none), so today's sessions may not be on the server yet.
    public var todayNotUploaded: Bool {
        guard let lastUpload, lastUpload.status == "completed" else { return true }
        return PersonalActivity.day(of: lastUpload.at, timezone: timezone) < today
    }
}
