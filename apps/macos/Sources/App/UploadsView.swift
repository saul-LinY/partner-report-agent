import SwiftUI
import WeeklyReportCore

struct UploadsView: View {
    private enum ResultFilter: String, CaseIterable { case all = "全部", success = "成功", failure = "失败" }
    @EnvironmentObject private var store: AppStore
    @State private var result: ResultFilter = .all
    @State private var days = 7
    @State private var localResult = false
    private var datedRecords: [UploadRecord] {
        store.uploadRecords.filter { record in
            guard let date = record.createdAt, days > 0 else { return true }
            return date >= Calendar.current.date(byAdding: .day, value: -days, to: .now)!
        }
    }
    /// What an upload started now would carry, so the button is not a blind action.
    private var queueSummary: String {
        let waiting = store.pendingSessions.count
        let excluded = store.excludedSessionCount
        let base = waiting == 0 ? "没有待上传的会话" : "待上传 \(waiting) 个会话"
        return excluded == 0 ? base : "\(base) · \(excluded) 个不上传"
    }
    private var records: [UploadRecord] {
        datedRecords.filter { result == .all || (result == .failure ? $0.status == .failed : [.complete, .backfilled].contains($0.status)) }
    }
    var body: some View {
        VStack(spacing: 0) {
            PageHeading(title: "上传记录") {
                if !store.isLive { Text("示例记录").font(.app(size: 11)).foregroundStyle(Palette.secondary) }
            }
            HStack(spacing: 10) {
                ForEach(ResultFilter.allCases, id: \.self) { filter in
                    FilterTab(title: filter.rawValue, count: count(filter), selected: result == filter) { result = filter }
                }
                Spacer()
                Menu {
                    Button("最近 7 天") { days = 7 }
                    Button("最近 30 天") { days = 30 }
                    Button("全部时间") { days = 0 }
                } label: {
                    Label(days == 0 ? "全部时间" : "最近 \(days) 天", systemImage: "calendar").font(.app(size: 12))
                }.menuStyle(.borderlessButton).menuIndicator(.visible).modifier(ScheduleFieldStyle())
                    .accessibilityLabel("上传记录时间范围").accessibilityIdentifier("upload-date-range")
                Text(queueSummary).font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    .accessibilityIdentifier("upload-queue-summary")
                Button {
                    Task {
                        await store.runLocalUpload()
                        localResult = true
                    }
                } label: { Label(store.isUploading ? "上传中…" : store.isPreparingUpload ? "准备上传…" : "立即上传", systemImage: "icloud.and.arrow.up") }
                    .buttonStyle(YellowButtonStyle()).disabled(store.isUploading || store.isPreparingUpload || store.isConnecting || (!store.hasCollectorService && store.pendingSessions.isEmpty))
                    .help(store.hasCollectorService ? "上传距离上次上传后新增或更新的会话" : "仅在本机模拟上传")
                    .accessibilityIdentifier("upload-now")
            }.padding(.horizontal, 28).padding(.bottom, 10)
            Rule().padding(.horizontal, 28)
            if let notice = store.uploadNotice {
                Text(notice).font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 28).padding(.top, 12)
                    .accessibilityIdentifier("upload-notice")
            }
            if let error = store.processingError {
                Text(error).font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 28).padding(.top, 12)
            }
            ScrollView {
                VStack(spacing: 0) {
                    columns {
                        Text("上传时间").frame(width: AppFont.width(122), alignment: .leading)
                        Text("上传方式").frame(width: AppFont.width(80), alignment: .leading)
                        Text("上传范围").frame(maxWidth: .infinity, alignment: .leading)
                        Text("上传内容").frame(width: AppFont.width(105), alignment: .leading)
                        Text("状态").frame(width: AppFont.width(62), alignment: .leading)
                        Text("操作").frame(width: AppFont.width(64))
                    }.font(.app(size: 12)).foregroundStyle(Palette.secondary).frame(height: 38).background(Palette.quiet)
                    ForEach(records) { record in
                        columns {
                            Text(record.createdAt.map { $0.formatted(.dateTime.month().day().hour().minute()) } ?? record.time).font(.app(size: 12)).frame(width: AppFont.width(122), alignment: .leading)
                            Text(record.kind).frame(width: AppFont.width(80), alignment: .leading)
                            Text(record.projects.map { "\($0.count) 个项目 · \(record.sessionCount) 个会话" } ?? record.projectsAndAgents).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                            Text(record.projects == nil ? record.content : "\(record.messageCount) 条对话消息").font(.app(size: 12)).frame(width: AppFont.width(105), alignment: .leading)
                            VStack(alignment: .leading, spacing: 4) {
                                StatusLabel(text: record.status.label, color: color(record.status), size: 6)
                                if let processing = store.processingSummary(for: record.id) {
                                    Text(processing.label).font(.app(size: 10)).foregroundStyle(Palette.secondary).lineLimit(2)
                                }
                            }.frame(width: AppFont.width(62), alignment: .leading)
                            Button("详情") { store.selectedUploadRecordID = record.id }.buttonStyle(QuietButtonStyle(compact: true)).frame(width: AppFont.width(64)).accessibilityIdentifier("upload-detail-\(record.id)")
                        }.font(.app(size: 13)).frame(minHeight: 76)
                        Rule()
                    }
                    if records.isEmpty {
                        EmptyMessage(symbol: "tray", title: "暂无上传记录", subtitle: "").frame(height: 260)
                    }
                }.padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 24)
            }
        }
        .sheet(item: Binding(get: { store.uploadRecords.first { $0.id == store.selectedUploadRecordID } }, set: { store.selectedUploadRecordID = $0?.id })) { record in
            UploadDetailSheet(record: record, processing: store.processingSummary(for: record.id))
        }
        .alert(store.hasCollectorService ? "会话包上传" : store.isLive ? "本地待传数据" : "本地演示", isPresented: $localResult) {
            Button("关闭", role: .cancel) {}
        } message: { Text(store.connectionError ?? store.storageError ?? store.uploadNotice ?? (store.hasCollectorService ? "系统已确认接收本次新增或更新的完整会话。" : store.isLive ? "已准备本地待传数据。" : "已在本机模拟完成，没有发送任何数据。")) }
    }
    private func columns<Content: View>(@ViewBuilder _ content: () -> Content) -> some View { HStack(spacing: 12, content: content).padding(.horizontal, 10) }
    private func count(_ filter: ResultFilter) -> Int {
        datedRecords.filter { filter == .all || (filter == .failure ? $0.status == .failed : [.complete, .backfilled].contains($0.status)) }.count
    }
    private func color(_ status: UploadStatus) -> Color {
        switch status { case .complete, .backfilled: Palette.green; case .failed: Palette.red; case .queued: Palette.yellow }
    }
}

struct UploadDetailSheet: View {
    let record: UploadRecord
    var processing: CollectorProcessingSummary? = nil
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                SectionTitle(title: "上传详情")
                Spacer()
                Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 24, height: 24) }.buttonStyle(.plain).help("关闭")
            }
            Text("\(record.time) · \(record.kind)\(record.projects == nil ? "" : " · \(record.messageCount) 条对话消息")")
                .font(.app(size: 12)).foregroundStyle(Palette.secondary)
            Rule()
            if let processing {
                HStack {
                    Text(processing.label).font(.app(size: 13, weight: .medium))
                    Spacer()
                    Text("已分析 \(processing.analysis_completed)/\(processing.analysis_total) · 待审核 \(processing.pending_cards)")
                        .font(.app(size: 12)).foregroundStyle(Palette.secondary)
                }
                if let error = processing.error_code ?? processing.card_error_code {
                    Text(error).font(.app(size: 12)).foregroundStyle(Palette.red)
                }
            }
            if let projects = record.projects {
                HStack { Text("涉及项目").font(.app(size: 14, weight: .medium)); Spacer(); Text("\(projects.count) 个项目 · \(record.sessionCount) 个会话").font(.app(size: 12)).foregroundStyle(Palette.secondary) }
                ScrollView {
                    VStack(spacing: 0) {
                        HStack { Text("项目").frame(maxWidth: .infinity, alignment: .leading); Text("会话").frame(width: AppFont.width(90)); Text("对话消息").frame(width: AppFont.width(90)) }
                            .font(.app(size: 12)).foregroundStyle(Palette.secondary).padding(10).background(Palette.quiet)
                        ForEach(projects) { project in
                            HStack {
                                Label(project.name, systemImage: "folder").frame(maxWidth: .infinity, alignment: .leading).lineLimit(2)
                                Text("\(project.sessionCount) 个会话").frame(width: AppFont.width(90))
                                Text("\(project.messageCount) 条").frame(width: AppFont.width(90))
                            }.font(.app(size: 13)).padding(.horizontal, 10).frame(minHeight: 64)
                            Rule()
                        }
                    }
                }.frame(height: min(300, CGFloat(projects.count * 65 + 40)))
            } else {
                ScrollView { VStack(alignment: .leading, spacing: 12) { ForEach(record.details, id: \.self) { Text($0).font(.app(size: 13)).textSelection(.enabled) } }.frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 170)
            }
            if record.status == .failed {
                Label(record.errorMessage ?? "连接失败，新增内容保留在待上传队列。", systemImage: "exclamationmark.circle").font(.app(size: 12)).foregroundStyle(Palette.red)
            }
            if record.status == .queued {
                Text("已准备本地待传数据，未发送到系统。").font(.app(size: 12)).foregroundStyle(Palette.secondary)
            }
            HStack { Spacer(); Button { dismiss() } label: { Text("关闭").frame(width: AppFont.width(280)) }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction); Spacer() }
        }.padding(28).frame(width: AppFont.width(580)).foregroundStyle(Palette.ink).background(.white)
    }
}
