import SwiftUI
import WidgetKit

struct ReviewEntry: TimelineEntry {
    let date: Date
    let queue: WidgetQueueResponse
    let errorMessage: String?
    let isConnected: Bool
}

struct ReviewTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> ReviewEntry { previewEntry }
    func getSnapshot(in context: Context, completion: @escaping (ReviewEntry) -> Void) { completion(entry()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ReviewEntry>) -> Void) {
        Task {
            if SharedStore.shared.credentials != nil { _ = try? await WidgetAPIClient().fetchQueue() }
            completion(Timeline(entries: [entry()], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }

    private func entry() -> ReviewEntry {
        ReviewEntry(
            date: Date(), queue: SharedStore.shared.cachedQueue,
            errorMessage: SharedStore.shared.lastError,
            isConnected: SharedStore.shared.credentials != nil
        )
    }

    private var previewEntry: ReviewEntry {
        let days = zip(["一", "二", "三", "四", "五", "六", "日"], [2, 4, 3, 6, 0, 0, 0]).enumerated().map {
            WidgetDaySummary(date: "2026-08-\(24 + $0.offset)", label: $0.element.0, useful: $0.element.1, status: $0.offset == 3 ? "today" : "success")
        }
        return ReviewEntry(
            date: Date(),
            queue: WidgetQueueResponse(
                generatedAt: ISO8601DateFormatter().string(from: Date()), totalCount: 3,
                items: [], permissions: nil, workCards: [], connectionRecoveries: [],
                dashboard: WidgetDashboardSummary(
                    status: "success", lastRunAt: ISO8601DateFormatter().string(from: Date()),
                    nextRunAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(86_400)),
                    errorCode: nil, errorMessage: nil,
                    today: WidgetTodaySummary(discovered: 8, useful: 6, uploaded: 6, unchanged: 2, failed: 0),
                    week: WidgetWeekSummary(periodKey: "2026-W35", totalUseful: 15, days: days)
                )
            ), errorMessage: nil, isConnected: true
        )
    }
}

struct ReviewWidgetView: View {
    let entry: ReviewEntry

    var body: some View {
        VStack(spacing: 9) {
            header
            Divider().opacity(0.5)
            HStack(spacing: 11) {
                statusPanel.frame(width: 106)
                Divider().opacity(0.5)
                chartPanel
            }
        }
        .padding(14)
        .containerBackground(for: .widget) {
            Color(nsColor: .windowBackgroundColor)
        }
        .widgetURL(URL(string: "workdashboard://cards"))
    }

    private var header: some View {
        HStack(spacing: 7) {
            Image("WorkDashboardIcon").resizable().scaledToFit().frame(width: 23, height: 23)
            Text("工作看板").font(.headline)
            Spacer(minLength: 8)
            if let total = entry.queue.dashboard?.week.totalUseful {
                Text("本周").font(.caption2).foregroundStyle(.secondary)
                Text("\(total)").font(.callout.weight(.bold).monospacedDigit()).foregroundStyle(.blue)
            }
            Button(intent: RefreshQueueIntent()) { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.plain).help("刷新")
        }
        .frame(height: 24)
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !entry.isConnected {
                Spacer()
                Label("尚未连接", systemImage: "link.badge.plus").font(.caption.weight(.semibold))
                Text("打开应用绑定").font(.caption2).foregroundStyle(.secondary)
                Spacer()
            } else if let dashboard = entry.queue.dashboard {
                HStack(spacing: 5) {
                    Image(systemName: statusIcon(dashboard.status)).foregroundStyle(statusColor(dashboard.status))
                    Text(statusTitle(dashboard.status)).font(.caption.weight(.semibold)).lineLimit(1)
                }
                compactMetric("最近", formatTime(dashboard.lastRunAt))
                compactMetric("上传", "\(dashboard.today.uploaded) 个")
                Spacer(minLength: 0)
                if entry.queue.totalCount > 0 {
                    Label("\(entry.queue.totalCount) 项待确认", systemImage: "tray.full.fill")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.orange).lineLimit(1)
                } else {
                    Label("无需处理", systemImage: "checkmark.circle.fill")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.green).lineLimit(1)
                }
            } else {
                Spacer(); ProgressView().controlSize(.small); Spacer()
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var chartPanel: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("每日有效 Session").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            if let week = entry.queue.dashboard?.week {
                weekChart(week)
            } else {
                Spacer(); Text("等待采集数据").font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity); Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func weekChart(_ week: WidgetWeekSummary) -> some View {
        let maximum = max(week.days.map(\.useful).max() ?? 0, 1)
        let today = localDateKey(entry.date)
        return HStack(alignment: .bottom, spacing: 4) {
            ForEach(week.days) { day in
                let isToday = day.date == today
                VStack(spacing: 3) {
                    Text("\(day.useful)")
                        .font(.caption2.weight(isToday ? .bold : .medium).monospacedDigit())
                        .foregroundStyle(isToday ? Color.teal : Color.secondary)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(isToday ? Color.teal : (day.useful > 0 ? Color.blue.opacity(0.65) : Color.secondary.opacity(0.16)))
                        .frame(height: day.useful > 0 ? 8 + 31 * CGFloat(day.useful) / CGFloat(maximum) : 4)
                    Text(day.label)
                        .font(.caption2.weight(isToday ? .bold : .regular))
                        .foregroundStyle(isToday ? Color.teal : Color.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(maxHeight: .infinity, alignment: .bottom)
    }

    private func compactMetric(_ label: String, _ value: String) -> some View {
        HStack { Text(label).foregroundStyle(.secondary); Spacer(); Text(value).monospacedDigit() }
            .font(.caption2).lineLimit(1)
    }

    private func localDateKey(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    private func formatTime(_ value: String?) -> String {
        guard let value, let date = ISO8601DateFormatter().date(from: value) else { return "尚未完成" }
        return date.formatted(date: .omitted, time: .shortened)
    }
    private func statusTitle(_ status: String) -> String {
        switch status { case "success": return "采集正常"; case "warning": return "采集有提醒"; case "running": return "正在采集"; case "failed": return "采集异常"; default: return "等待采集" }
    }
    private func statusIcon(_ status: String) -> String {
        switch status { case "success": return "checkmark.circle.fill"; case "warning": return "exclamationmark.circle.fill"; case "running": return "arrow.triangle.2.circlepath"; case "failed": return "xmark.circle.fill"; default: return "clock.fill" }
    }
    private func statusColor(_ status: String) -> Color {
        switch status { case "success": return .green; case "warning": return .orange; case "failed": return .red; case "running": return .blue; default: return .secondary }
    }
}

struct PartnerReportReviewWidget: Widget {
    let kind = "PartnerReportReviewWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ReviewTimelineProvider()) { entry in ReviewWidgetView(entry: entry) }
            .configurationDisplayName("工作看板")
            .description("查看这台 Mac 的采集状态和本周有效 Session。")
            .supportedFamilies([.systemMedium])
    }
}
