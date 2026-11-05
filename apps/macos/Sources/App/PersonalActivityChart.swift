import SwiftUI
import Charts
import WeeklyReportCore

/// 会话活跃度: conversation turns per hour of one day, or per day of one month.
struct PersonalActivityChart: View {
    let data: PersonalData
    private enum Mode: Hashable { case day, month }
    @State private var mode: Mode = .day
    @State private var pickedDay: String?
    @State private var pickedMonth: String?

    private var events: [PersonalData.ActivityEvent] { data.activity.events }
    private var projectNames: [String] { data.projects.map(\.project.projectName) }
    private var day: String? { pickedDay ?? PersonalActivity.lastEventDay(events) }
    private var month: String { pickedMonth ?? String((day ?? data.activity.to).prefix(7)) }
    private var firstMonth: String { String(data.activity.from.prefix(7)) }
    private var lastMonth: String { String(data.activity.to.prefix(7)) }

    private var series: [ActivitySeries] {
        switch mode {
        case .day: PersonalActivity.hourly(events: events, day: day ?? "never", projects: projectNames)
        case .month: PersonalActivity.monthly(events: events, month: month, projects: projectNames)
        }
    }
    private var hasTurns: Bool { series.contains { $0.sum > 0 } }

    private var title: String {
        switch mode {
        case .month: "\(PersonalActivity.longMonth(month)) 会话活跃度"
        case .day: day.map { "\(PersonalActivity.longDay($0)) 会话活跃度" } ?? "会话活跃度"
        }
    }

    var body: some View {
        PersonalSection(title: title) {
            controls
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                if hasTurns {
                    ActivityLines(series: series, monthly: mode == .month, month: month) { date in
                        pickedDay = "\(month)-\(date)"; mode = .day
                    }
                    .frame(height: 260).accessibilityIdentifier("personal-activity-chart")
                } else {
                    Text(mode == .day ? "这一天没有交互" : "这个月没有交互").font(.app(size: 13)).foregroundStyle(Palette.secondary)
                        .frame(maxWidth: .infinity, minHeight: 120).accessibilityIdentifier("personal-activity-empty")
                }
                Text("统计与 AI 的交互轮数（\(data.activity.timezone)），已剔除测试、闲聊等无效会话。")
                    .font(.app(size: 11)).foregroundStyle(Palette.secondary)
            }.padding(16).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
        }
    }

    private var controls: some View {
        HStack(spacing: 12) {
            HStack(spacing: 0) {
                ForEach([(Mode.day, "按天看"), (.month, "按月看")], id: \.0) { value, label in
                    Button(label) { mode = value }
                        .buttonStyle(.plain).font(.app(size: 12, weight: mode == value ? .semibold : .regular))
                        .padding(.horizontal, 12).frame(height: 28)
                        .background(mode == value ? Palette.selected : .clear, in: RoundedRectangle(cornerRadius: 5))
                        .accessibilityAddTraits(mode == value ? .isSelected : [])
                        .accessibilityIdentifier("personal-activity-\(value == .day ? "day" : "month")")
                }
            }.padding(2).overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
            if mode == .day {
                DatePicker("日期", selection: dayBinding, in: dayRange, displayedComponents: .date)
                    .datePickerStyle(.field).labelsHidden().fixedSize().accessibilityLabel("日期")
            } else {
                HStack(spacing: 6) {
                    monthButton("chevron.left", "上一月", disabled: month <= firstMonth, delta: -1)
                    Text(month).font(.app(size: 13)).monospacedDigit().frame(minWidth: 60)
                    monthButton("chevron.right", "下一月", disabled: month >= lastMonth, delta: 1)
                }
            }
        }
    }

    private func monthButton(_ symbol: String, _ label: String, disabled: Bool, delta: Int) -> some View {
        Button { pickedMonth = PersonalActivity.shiftMonth(month, by: delta) } label: { Image(systemName: symbol).frame(width: 24, height: 24) }
            .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.35 : 1).accessibilityLabel(label).help(label)
    }

    // The picker works in the server's team-time calendar days, never the Mac's time zone.
    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()
    private static func date(_ day: String) -> Date? {
        let p = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        return p.count == 3 ? utc.date(from: DateComponents(year: p[0], month: p[1], day: p[2])) : nil
    }
    private var dayRange: ClosedRange<Date> {
        let low = Self.date(data.activity.from) ?? .distantPast, high = Self.date(data.activity.to) ?? .distantFuture
        return low <= high ? low...high : high...high
    }
    private var dayBinding: Binding<Date> {
        Binding(get: { day.flatMap(Self.date) ?? dayRange.upperBound }, set: { value in
            let c = Self.utc.dateComponents([.year, .month, .day], from: value)
            pickedDay = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
            pickedMonth = nil
        })
    }
}
