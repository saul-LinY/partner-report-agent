import SwiftUI
import WeeklyReportCore

/// 研发日历: Monday-first month grid of one project's reviewed daily progress; paging re-fetches `?month=`.
struct ProjectCalendar: View {
    @EnvironmentObject private var store: AppStore
    let data: PersonalData
    let project: ProgressProject
    let colorIndex: Int
    @State private var pickedDay: String?

    private var month: String { data.calendar.month }
    private var currentMonth: String { String(data.today.prefix(7)) }
    private let weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("研发日历").font(.app(size: 15, weight: .semibold))
                Text(PersonalActivity.longMonth(month)).font(.app(size: 13)).foregroundStyle(Palette.secondary).accessibilityIdentifier("personal-calendar-month")
                Spacer()
                IconButton(symbol: "chevron.left", help: "上个月") { go(PersonalActivity.shiftMonth(month, by: -1)) }
                    .disabled(store.isLoadingPersonalData).accessibilityIdentifier("personal-calendar-prev")
                Button("本月") { go(nil) }.buttonStyle(QuietButtonStyle(compact: true))
                    .disabled(store.isLoadingPersonalData || month == currentMonth).accessibilityIdentifier("personal-calendar-current")
                IconButton(symbol: "chevron.right", help: "下个月") { go(PersonalActivity.shiftMonth(month, by: 1)) }
                    .disabled(store.isLoadingPersonalData || month >= currentMonth).accessibilityIdentifier("personal-calendar-next")
            }
            let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 7)
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(weekdays, id: \.self) { Text($0).font(.app(size: 11)).foregroundStyle(Palette.secondary).frame(maxWidth: .infinity) }
            }.accessibilityHidden(true)
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(PersonalActivity.calendarGrid(month: month), id: \.self) { cell($0) }
            }
            if let day = pickedDay { dayDetail(day) }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
        .accessibilityIdentifier("personal-calendar")
        .onChange(of: month) { _, _ in pickedDay = nil }
    }

    private func go(_ target: String?) {
        Task { await store.loadPersonalData(month: target) }
    }

    @ViewBuilder private func cell(_ date: String) -> some View {
        let inside = date.hasPrefix(month)
        let (entries, events) = inside ? project.activity(on: date) : ([], [])
        let tone = WebTone.series(colorIndex)
        Button { pickedDay = date } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Text("\(Int(date.suffix(2)) ?? 0)").font(.app(size: 12, weight: date == data.today ? .semibold : .regular)).monospacedDigit()
                    if date == data.today { Text("今天").font(.app(size: 10)).foregroundStyle(Palette.secondary) }
                    Spacer(minLength: 0)
                }
                if !entries.isEmpty || !events.isEmpty {
                    Text(entries.isEmpty ? "时间记录" : project.projectName).font(.app(size: 10, weight: .medium)).lineLimit(1)
                        .padding(.horizontal, 5).padding(.vertical, 2).frame(maxWidth: .infinity, alignment: .leading)
                        .background(tone.opacity(0.14), in: RoundedRectangle(cornerRadius: 4)).foregroundStyle(tone)
                }
                Spacer(minLength: 0)
            }
            .padding(6).frame(maxWidth: .infinity, minHeight: 66, alignment: .topLeading)
            .background(date == pickedDay ? Palette.selected : inside ? Palette.quiet : .clear, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(date == data.today ? Palette.yellow : Palette.line.opacity(inside ? 1 : 0.5)))
            .opacity(inside ? 1 : 0.4).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!inside || date > data.today)
        .accessibilityLabel("查看 \(date) 的进展").accessibilityIdentifier("personal-calendar-day-\(date)")
    }

    private func dayDetail(_ day: String) -> some View {
        let (entries, events) = project.activity(on: day)
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(day) · 项目进展").font(.app(size: 14, weight: .semibold))
                Spacer()
                Button("关闭") { pickedDay = nil }.buttonStyle(QuietButtonStyle(compact: true))
            }
            Text(project.projectName).font(.app(size: 13, weight: .medium))
            if entries.isEmpty, events.isEmpty {
                Text("这一天暂无已审核的每日进展").font(.app(size: 12)).foregroundStyle(Palette.secondary)
            }
            ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "flag").font(.app(size: 11))
                    Text(event.label).font(.app(size: 12, weight: .semibold))
                    Text(event.reason).font(.app(size: 12)).foregroundStyle(Palette.secondary)
                }
            }
            ForEach(entries) { entry in
                Text(entry.summary).font(.app(size: 12)).fixedSize(horizontal: false, vertical: true)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(14).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
        .accessibilityIdentifier("personal-calendar-day-detail")
    }
}
