import SwiftUI
import WeeklyReportCore

struct WorkCardsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selectedID: String?
    @State private var period: String?
    @State private var instruction = ""
    @State private var confirmExclude = false
    private var periods: [String] { Array(Set(store.reviewBatches.compactMap { $0.review.period_key })).sorted(by: >) }
    private var scopedBatches: [ReviewBatch] { store.reviewBatches.filter { period == nil || $0.review.period_key == period } }
    private var allCards: [ReviewCard] { scopedBatches.flatMap(\.items) }
    private var pendingIDs: Set<String> { Set(scopedBatches.flatMap(\.pendingCards).map(\.id)) }
    private var pending: [ReviewCard] { allCards.filter { pendingIDs.contains($0.id) } }
    private var handled: [ReviewCard] { allCards.filter { ["approved", "excluded"].contains($0.review_status) } }
    private var visible: [ReviewCard] { pending + handled }
    private var selected: ReviewCard? { visible.first { $0.id == selectedID } }
    private func batch(_ card: ReviewCard) -> ReviewBatch? { scopedBatches.first { $0.items.contains { $0.id == card.id } } }
    private func busy(_ card: ReviewCard) -> Bool { store.isPerformingReviewAction || store.isRefreshingReviews || batch(card)?.isRegenerating(card.id) == true }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(visible.count) 张工作卡片").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                Spacer()
                Menu {
                    Button("全部周期") { period = nil }
                    ForEach(periods, id: \.self) { value in Button(value) { period = value } }
                } label: {
                    Label(period ?? "全部周期", systemImage: "calendar")
                }.menuStyle(.borderlessButton).fixedSize().frame(minWidth: 116)
                    .accessibilityIdentifier("review-period")
            }.padding(.horizontal, 28).frame(height: 44)
            Rule()
            if let error = store.reviewError {
                HStack(spacing: 12) {
                    Text(error).font(.system(size: 12)).foregroundStyle(Palette.red)
                    Spacer()
                    Button("重试") { Task { await store.refreshReviews() } }.buttonStyle(QuietButtonStyle(compact: true))
                }.padding(14)
                Rule()
            }
            HStack(spacing: 0) {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        cardGroup("待审核", cards: pending, identifier: "pending")
                        cardGroup("已处理", cards: handled, identifier: "handled")
                    }
                }.frame(width: 278)
                Rectangle().fill(Palette.line).frame(width: 1)
                if let selected { detail(selected).id(selected.id) }
                else {
                    EmptyMessage(symbol: nil, title: "暂无工作卡片", subtitle: store.isLive && !store.hasReviewService ? "未连接系统" : "")
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { followSelection(); reconcile() }
        .onChange(of: visible.map(\.id)) { _, _ in reconcile() }
        .onChange(of: store.selectedApproval) { _, _ in followSelection() }
        .onChange(of: selectedID) { _, _ in instruction = "" }
        .alert("确认忽略这张工作卡片？", isPresented: $confirmExclude) {
            Button("取消", role: .cancel) {}
            Button("忽略", role: .destructive) { if let selected { Task { await store.performCardAction(.exclude, cardID: selected.id) } } }
        } message: { Text("这张卡片不会进入本期团队报告。") }
    }
    private func cardGroup(_ title: String, cards: [ReviewCard], identifier: String) -> some View {
        Section {
            ForEach(cards) { card in
                Button { selectedID = card.id } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "doc.text").font(.system(size: 20)).frame(width: 22)
                        VStack(alignment: .leading, spacing: 9) {
                            Text(card.displayName).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                            Text(batch(card)?.review.period_key ?? "工作卡片").font(.system(size: 11)).foregroundStyle(Palette.secondary)
                            StatusLabel(text: status(card), color: card.review_status == "approved" ? Palette.green : card.review_status == "excluded" ? Palette.secondary : Palette.yellow, size: 6)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(20).frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
                        .background(selectedID == card.id ? Palette.selected : .white)
                        .overlay(alignment: .leading) { if selectedID == card.id { Rectangle().fill(Palette.yellow).frame(width: 3) } }
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("review-card-\(card.id)")
                    .id("\(identifier):\(card.id):\(card.review_status):\(selectedID == card.id)")
                Rule()
            }
            if cards.isEmpty {
                Text("暂无\(title)卡片").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(20)
                Rule()
            }
        } header: {
            HStack(spacing: 8) {
                Text(title).fontWeight(.semibold)
                Text("\(cards.count)").monospacedDigit().foregroundStyle(Palette.secondary)
                Spacer()
            }.font(.system(size: 12)).padding(.horizontal, 20).frame(height: 38).background(Palette.quiet)
                .accessibilityIdentifier("review-group-\(identifier)")
        }.id(identifier)
    }
    private func detail(_ card: ReviewCard) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                Text(card.displayName).font(.system(size: 20, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                Text(batch(card)?.review.period_key ?? "工作卡片").font(.system(size: 12)).foregroundStyle(Palette.secondary)
            }.padding(26).frame(maxWidth: .infinity, alignment: .leading)
            Rule()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("本周进展总览").font(.system(size: 14, weight: .semibold))
                        MarkdownBody(text: card.payload.overview ?? card.payload.summary ?? "暂无内容")
                    }
                    if let progress = card.payload.dailyProgress, !progress.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("每日进展").font(.system(size: 14, weight: .semibold))
                            ForEach(Array(progress.enumerated()), id: \.offset) { _, entry in
                                HStack(alignment: .top, spacing: 16) {
                                    Text(entry.date).font(.system(size: 12)).monospacedDigit().foregroundStyle(Palette.secondary).frame(width: 82, alignment: .leading)
                                    Text(entry.summary).font(.system(size: 13)).lineSpacing(5).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                                }
                            }
                        }
                    }
                    if let job = batch(card)?.job(for: card.id), let error = job.error_message, !error.isEmpty {
                        Text(error).font(.system(size: 12)).foregroundStyle(Palette.red)
                    }
                }.padding(26).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: .infinity)
            if pendingIDs.contains(card.id) {
                Rule()
                VStack(alignment: .leading, spacing: 12) {
                    Text("修改意见").font(.system(size: 13, weight: .semibold))
                    ZStack(alignment: .topLeading) {
                        if instruction.isEmpty {
                            Text("填写需要调整的内容").font(.system(size: 13)).foregroundStyle(Palette.secondary)
                                .padding(.horizontal, 12).padding(.top, 8).allowsHitTesting(false)
                        }
                        TextEditor(text: $instruction).font(.system(size: 13)).scrollContentBackground(.hidden)
                            .padding(7).frame(height: 60)
                            .accessibilityLabel("修改意见").accessibilityIdentifier("review-instruction")
                    }.overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
                    HStack {
                        if batch(card)?.isRegenerating(card.id) == true {
                            ProgressView().controlSize(.small)
                            Text("正在重新生成").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                        }
                        Spacer()
                        Button { Task { await store.performCardAction(.regenerate(instruction), cardID: card.id) } } label: {
                            Label("按修改意见重新生成", systemImage: "arrow.clockwise")
                        }.buttonStyle(QuietButtonStyle(compact: true))
                            .disabled(busy(card) || !(2...1000).contains(instruction.trimmingCharacters(in: .whitespacesAndNewlines).count))
                            .accessibilityIdentifier("review-regenerate")
                    }
                }.padding(.horizontal, 26).padding(.vertical, 18)
                Rule()
                HStack(spacing: 12) {
                    Spacer()
                    Button { confirmExclude = true } label: { Text("忽略").frame(width: 70) }
                        .buttonStyle(QuietButtonStyle()).accessibilityIdentifier("review-exclude")
                    Button { Task { await store.performCardAction(.approve, cardID: card.id) } } label: { Label("通过", systemImage: "checkmark").frame(width: 78) }
                        .buttonStyle(YellowButtonStyle()).accessibilityIdentifier("review-approve")
                }.disabled(busy(card)).padding(.horizontal, 26).padding(.vertical, 18)
            } else {
                Rule()
                Text(status(card)).font(.system(size: 13)).foregroundStyle(Palette.secondary).padding(26)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    private func status(_ card: ReviewCard) -> String {
        if batch(card)?.isRegenerating(card.id) == true { return "重新生成中" }
        switch card.review_status {
        case "approved": return "已通过"
        case "excluded": return "已忽略"
        default: return "待审核"
        }
    }
    private func reconcile() { if !visible.contains(where: { $0.id == selectedID }) { selectedID = visible.first?.id } }
    private func followSelection() {
        if case .card(let id) = store.selectedApproval {
            period = nil
            selectedID = visible.first(where: { $0.id == id })?.id
        }
    }
}
