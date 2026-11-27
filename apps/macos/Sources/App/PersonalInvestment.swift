import SwiftUI
import WeeklyReportCore

/// 工作投入: the leadership page's figures for the member, read live: last 28 days, project shares, and the
/// day / month activity chart. Only projects the member allows to be uploaded are in `history`.
struct PersonalInvestment: View {
    let data: PersonalData
    private enum Mode: Hashable { case day, month }
    @State private var mode: Mode = .day
    @State private var pickedDay: String?
    @State private var pickedMonth: String?

    private var first: String { data.history.from.isEmpty ? data.today : data.history.from }
    private var last: String { data.history.to.isEmpty ? data.today : data.history.to }
    /// The day the hour view shows: the one picked, else the latest with turns.
    private var day: String { pickedDay ?? data.lastActiveDay ?? last }
    private var month: String { pickedMonth ?? String(day.prefix(7)) }
    private var monthDays: [String] { PersonalData.days(ofMonth: month) }
    private var series: [ActivitySeries] { mode == .day ? data.investmentHourly(day: day) : data.investmentDaily(month: month) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("工作投入").font(.app(size: 17, weight: .semibold))
                Spacer(minLength: 8)
                Text("辅助参考，不代表进展 · 随每次上传更新").font(.app(size: 12)).foregroundStyle(Palette.secondary)
            }
            stats
            chartCard
        }.accessibilityIdentifier("personal-investment")
    }

    private var stats: some View {
        HStack(alignment: .top, spacing: 28) {
            figure("近 28 天活跃", "\(data.activeDays28) 天")
            figure("最近活跃", data.lastActiveDay.map(PersonalActivity.monthDay) ?? "—")
            figure("近 28 天交互", "\(data.turns28) 轮")
            shareBar
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
    }

    private func figure(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.app(size: 12)).foregroundStyle(Palette.secondary)
            Text(value).font(.app(size: 20, weight: .semibold)).monospacedDigit()
        }.fixedSize()
    }

    private var shareBar: some View {
        let shares = data.shares
        let sum = max(1, shares.reduce(0) { $0 + $1.turns })
        return VStack(alignment: .leading, spacing: 8) {
            Text("各项目投入占比（截至今天的近 28 天）").font(.app(size: 12)).foregroundStyle(Palette.secondary)
            if shares.isEmpty {
                Text("近 28 天没有交互").font(.app(size: 12)).foregroundStyle(Palette.secondary)
            } else {
                GeometryReader { geometry in
                    HStack(spacing: 0) {
                        ForEach(shares, id: \.name) { share in
                            Rectangle().fill(WebTone.series(share.colorIndex))
                                .frame(width: geometry.size.width * CGFloat(share.turns) / CGFloat(sum))
                        }
                    }.clipShape(Capsule())
                }.frame(height: 10).accessibilityHidden(true)
                LegendFlow(spacing: 12, lineSpacing: 4) {
                    ForEach(shares, id: \.name) { share in
                        HStack(spacing: 5) {
                            Circle().fill(WebTone.series(share.colorIndex)).frame(width: 7, height: 7)
                            Text("\(share.name) \(Int((Double(share.turns) / Double(sum) * 100).rounded()))%").font(.app(size: 11))
                        }
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var chartCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                Text(title).font(.app(size: 14, weight: .semibold))
                Spacer(minLength: 8)
                controls
            }
            if series.contains(where: { $0.sum > 0 }) {
                ActivityLines(series: series, axis: mode == .day ? .hours : .days(monthDays),
                              drawn: mode == .day ? 24 : max(1, monthDays.filter { $0 <= data.today }.count)) { index in
                    if monthDays.indices.contains(index) { pickedDay = monthDays[index]; mode = .day }
                }
                .frame(height: 260).accessibilityIdentifier("personal-investment-chart")
            } else {
                Text(mode == .day ? "这一天没有交互" : "这个月没有交互").font(.app(size: 13)).foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity, minHeight: 120).accessibilityIdentifier("personal-investment-empty")
            }
            Text("统计与 AI 的交互轮数（\(data.timezone)），已剔除测试、闲聊等无效会话，只含你同意上传的项目。")
                .font(.app(size: 11)).foregroundStyle(Palette.secondary)
        }
        .padding(16).background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
    }

    private var title: String {
        switch mode {
        case .day:
            let p = day.split(separator: "-")
            return p.count == 3 ? "\(p[0])年\(Int(p[1]) ?? 0)月\(Int(p[2]) ?? 0)日 会话活跃度" : "会话活跃度"
        case .month:
            return "\(month.prefix(4))年\(Int(month.suffix(2)) ?? 0)月 会话活跃度"
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
                        .accessibilityIdentifier("personal-investment-\(value == .day ? "day" : "month")")
                }
            }.padding(2).overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
            if mode == .day {
                stepper(PersonalActivity.monthDay(day), previous: day > first, next: day < last, label: "天") { offset in
                    pickedDay = PersonalActivity.shift(day, by: offset)
                }
            } else {
                stepper(month, previous: month > first.prefix(7), next: month < last.prefix(7), label: "月") { offset in
                    pickedMonth = String(PersonalActivity.shift("\(month)-01", by: offset > 0 ? 31 : -1).prefix(7))
                }
            }
        }
    }

    private func stepper(_ text: String, previous: Bool, next: Bool, label: String, move: @escaping (Int) -> Void) -> some View {
        HStack(spacing: 4) {
            Button { move(-1) } label: { Image(systemName: "chevron.left") }.disabled(!previous).accessibilityLabel("上一\(label)")
            Text(text).font(.app(size: 12)).monospacedDigit().frame(minWidth: 64)
            Button { move(1) } label: { Image(systemName: "chevron.right") }.disabled(!next).accessibilityLabel("下一\(label)")
        }.buttonStyle(.plain).frame(height: 28).padding(.horizontal, 6).overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
    }
}
