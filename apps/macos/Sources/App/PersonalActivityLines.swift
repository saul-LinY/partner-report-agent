import SwiftUI
import Charts
import WeeklyReportCore

/// The line chart itself: one line per series, the 总计 line dashed. Hovering shows the bucket's figures; in
/// month view a click on a day opens that day.
struct ActivityLines: View {
    let series: [ActivitySeries]
    let monthly: Bool
    let month: String
    var select: (String) -> Void
    @State private var hovered: Int?

    /// x of bucket `index`: the hour 0…23, or the day of the month 1…n.
    private func x(_ index: Int) -> Double { Double(monthly ? index + 1 : index) }
    private var buckets: Int { series.first?.values.count ?? 0 }
    private var colors: [Color] { series.enumerated().map { $0.element.isTotal ? Palette.ink : WebTone.series($0.offset) } }

    private func label(_ index: Int) -> String {
        monthly ? "\(Int(month.dropFirst(5)) ?? 0)月\(index + 1)日" : "\(index):00–\(index):59"
    }

    var body: some View {
        Chart {
            ForEach(series) { line in
                ForEach(Array(line.values.enumerated()), id: \.offset) { index, value in
                    LineMark(x: .value(monthly ? "日期（日）" : "时间（小时）", x(index)), y: .value("交互轮数（轮）", value), series: .value("系列", line.name))
                        .foregroundStyle(by: .value("系列", line.name))
                        .lineStyle(StrokeStyle(lineWidth: 2, dash: line.isTotal ? [5, 4] : []))
                        
                }
            }
            if let hovered, hovered < buckets {
                RuleMark(x: .value("位置", x(hovered))).foregroundStyle(Palette.secondary.opacity(0.4))
                    .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) { tip(hovered) }
            }
        }
        .chartForegroundStyleScale(domain: series.map(\.name), range: colors)
        .chartLegend(series.count > 1 ? .visible : .hidden)
        .chartXScale(domain: x(0)...max(x(0) + 1, x(buckets - 1)))
        .chartXAxis { AxisMarks(values: .stride(by: 2)) { AxisGridLine(); AxisTick(); AxisValueLabel() } }
        .chartXAxisLabel(monthly ? "日期（日）" : "时间（小时）", alignment: .center)
        .chartYAxisLabel("交互轮数（轮）", position: .leading)
        .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 5)) }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let point): hovered = bucket(at: point, proxy: proxy, geometry: geometry)
                        case .ended: hovered = nil
                        }
                    }
                    .onTapGesture { point in
                        if monthly, let index = bucket(at: point, proxy: proxy, geometry: geometry) { select(String(format: "%02d", index + 1)) }
                    }
            }
        }
        .accessibilityLabel(monthly ? "\(month) 每日交互轮数折线图" : "每小时交互轮数折线图")
        .help(monthly ? "移动到图上查看当天的交互轮数，点击可查看这一天每小时的情况" : "移动到图上查看该小时的交互轮数")
    }

    private func bucket(at point: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> Int? {
        guard let frame = proxy.plotFrame, let value = proxy.value(atX: point.x - geometry[frame].origin.x, as: Double.self) else { return nil }
        let index = Int(value.rounded()) - (monthly ? 1 : 0)
        return (0..<buckets).contains(index) ? index : nil
    }

    private func tip(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label(index)).font(.app(size: 11, weight: .semibold))
            ForEach(Array(series.enumerated()), id: \.offset) { offset, line in
                HStack(spacing: 5) {
                    Circle().fill(colors[offset]).frame(width: 6, height: 6)
                    Text("\(line.name)：\(line.values[index])").font(.app(size: 11)).monospacedDigit()
                }
            }
        }.padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
    }
}
