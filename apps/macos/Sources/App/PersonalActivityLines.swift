import SwiftUI
import Charts
import WeeklyReportCore

/// What the x axis stands for: the days of a month (clickable) or the 24 hours of one day.
enum ActivityAxis: Equatable {
    case days([String])
    case hours

    var title: String {
        switch self {
        case .days: "日期（日）"
        case .hours: "时间（小时）"
        }
    }
    /// Tick label of bucket `index`.
    func label(_ index: Int) -> String {
        switch self {
        case .days(let days): days.indices.contains(index) ? "\(Int(days[index].suffix(2)) ?? 0)" : ""
        case .hours: "\(index)"
        }
    }
    /// Heading of the hover card of bucket `index`.
    func tip(_ index: Int) -> String {
        switch self {
        case .days(let days): days.indices.contains(index) ? "\(PersonalActivity.monthDay(days[index])) \(PersonalActivity.weekday(days[index]))" : ""
        case .hours: "\(index):00–\(index):59"
        }
    }
    var tickStride: Int { if case .hours = self { 3 } else { 1 } }
}

/// The line chart itself: one line per series, the 总计 line dashed. Only the first `drawn` buckets are drawn;
/// later days of the month are shaded "还没到". Hovering shows the bucket's figures; in the month view a click on a day
/// opens it. Legend entries toggle lines.
struct ActivityLines: View {
    let series: [ActivitySeries]
    let axis: ActivityAxis
    let drawn: Int
    var select: (Int) -> Void = { _ in }
    @State private var hovered: Int?
    @State private var hidden: Set<String> = []

    private var buckets: Int { series.first?.values.count ?? 0 }
    private var isDays: Bool { if case .days = axis { true } else { false } }
    /// Lines still shown; the y axis rescales to these.
    private var shown: [ActivitySeries] { series.filter { !hidden.contains($0.name) } }
    /// Colours follow a project's own slot, so hiding one never recolours the others.
    private func color(_ line: ActivitySeries) -> Color { line.isTotal ? Palette.ink : WebTone.series(line.colorIndex) }
    /// The y axis tops out at four "nice" steps above the highest drawn value.
    private var yStep: Int {
        let peak = max(1, shown.flatMap { $0.values.prefix(drawn) }.max() ?? 1)
        return [1, 2, 5, 10, 15, 20, 25, 50, 100].first { $0 * 4 >= peak } ?? Int((Double(peak) / 4).rounded(.up))
    }

    private func toggle(_ name: String) {
        if hidden.contains(name) { hidden.remove(name) }
        // Keep at least one line visible so the chart is never blank.
        else if shown.count > 1 { hidden.insert(name) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            chart
            if series.count > 1 { legend }
        }
    }

    private var legend: some View {
        LegendFlow(spacing: 14, lineSpacing: 6) {
            ForEach(series) { line in
                let off = hidden.contains(line.name)
                Button { toggle(line.name) } label: {
                    HStack(spacing: 6) {
                        Circle().fill(off ? Palette.line : color(line)).frame(width: 8, height: 8)
                        Text(line.name).font(.app(size: 11)).strikethrough(off)
                            .foregroundStyle(off ? Palette.secondary : Palette.ink)
                    }.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(off ? "点击显示" : "点击隐藏")
                .accessibilityLabel(line.name)
                .accessibilityValue(off ? "已隐藏" : "已显示")
                .accessibilityAddTraits(off ? [] : .isSelected)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("图例（点击显示或隐藏）")
    }

    private var chart: some View {
        let top = Double(yStep * 4)
        return Chart {
            ForEach(shown) { line in
                ForEach(Array(line.values.prefix(drawn).enumerated()), id: \.offset) { index, value in
                    LineMark(x: .value(axis.title, Double(index)), y: .value("交互轮数（轮）", value), series: .value("系列", line.name))
                        .foregroundStyle(by: .value("系列", line.name))
                        .lineStyle(StrokeStyle(lineWidth: 2, dash: line.isTotal ? [5, 4] : []))
                    // Days are few enough to mark each point; the 24-hour view stays a plain line.
                    if isDays {
                        PointMark(x: .value(axis.title, Double(index)), y: .value("交互轮数（轮）", value))
                            .foregroundStyle(by: .value("系列", line.name)).symbolSize(28)
                    }
                }
            }
            if let hovered, hovered < drawn {
                RuleMark(x: .value("位置", Double(hovered))).foregroundStyle(Palette.secondary.opacity(0.4))
                    .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) { tip(hovered) }
            }
        }
        .chartForegroundStyleScale(domain: shown.map(\.name), range: shown.map(color))
        .chartLegend(.hidden)
        .chartXScale(domain: 0...Double(max(1, buckets - 1)), range: .plotDimension(startPadding: 44, endPadding: 70))
        .chartYScale(domain: 0...top)
        .chartXAxis {
            AxisMarks(values: Array(stride(from: 0, to: max(buckets, 1), by: axis.tickStride)).map(Double.init)) { value in
                AxisGridLine(); AxisTick()
                // Charts attaches a label by its leading edge here; a fixed-width frame shifted by half centres the text on its tick.
                AxisValueLabel(collisionResolution: .disabled) {
                    if let index = value.as(Double.self) { Text(axis.label(Int(index))).lineLimit(1).frame(width: 90).offset(x: -45) }
                }
            }
        }
        .chartXAxisLabel(axis.title, alignment: .center)
        .chartYAxisLabel("交互轮数（轮）", position: .leading)
        .chartYAxis { AxisMarks(position: .leading, values: Array(stride(from: 0, through: yStep * 4, by: yStep))) }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                if isDays, drawn < buckets, let frame = proxy.plotFrame,
                   let from = proxy.position(forX: Double(max(drawn - 1, 0)) + 0.12), let to = proxy.position(forX: Double(buckets - 1)) {
                    let plot = geometry[frame]
                    ZStack(alignment: .top) {
                        Rectangle().fill(Palette.quiet)
                        Text("还没到").font(.app(size: 11)).foregroundStyle(Palette.secondary).padding(.top, 8)
                    }
                    .frame(width: max(0, to - from), height: plot.height)
                    .offset(x: plot.minX + from, y: plot.minY).allowsHitTesting(false)
                }
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let point): hovered = bucket(at: point, proxy: proxy, geometry: geometry)
                        case .ended: hovered = nil
                        }
                    }
                    .onTapGesture { point in
                        if isDays, let index = bucket(at: point, proxy: proxy, geometry: geometry) { select(index) }
                    }
            }
        }
        .accessibilityLabel(isDays ? "每日交互轮数折线图" : "每小时交互轮数折线图")
        .help(isDays ? "移动到图上查看当天的交互轮数，点击可查看这一天每小时的情况" : "移动到图上查看该小时的交互轮数")
    }

    /// The drawn bucket under the pointer, if any.
    private func bucket(at point: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> Int? {
        guard let frame = proxy.plotFrame, let value = proxy.value(atX: point.x - geometry[frame].origin.x, as: Double.self) else { return nil }
        let index = Int(value.rounded())
        return (0..<min(drawn, buckets)).contains(index) ? index : nil
    }

    private func tip(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(axis.tip(index)).font(.app(size: 11, weight: .semibold))
            ForEach(shown) { line in
                HStack(spacing: 5) {
                    Circle().fill(color(line)).frame(width: 6, height: 6)
                    Text("\(line.name)：\(line.values[index])").font(.app(size: 11)).monospacedDigit()
                }
            }
        }.padding(8).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
    }
}

/// Lays legend entries left to right and wraps them onto new rows, so many projects never overflow.
struct LegendFlow: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = place(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: frames.map(\.maxX).max() ?? 0, height: frames.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, place(subviews, width: bounds.width)) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func place(_ subviews: Subviews, width: CGFloat) -> [CGRect] {
        var frames: [CGRect] = []
        var origin = CGPoint.zero
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if origin.x > 0, origin.x + size.width > width {
                origin = CGPoint(x: 0, y: origin.y + rowHeight + lineSpacing)
                rowHeight = 0
            }
            frames.append(CGRect(origin: origin, size: size))
            origin.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return frames
    }
}
