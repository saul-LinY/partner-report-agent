import SwiftUI
import WeeklyReportCore

struct WorkCardsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selectedID: String?
    @State private var scope: PeriodScope = .latest
    @State private var instruction = ""
    @State private var confirmExclude = false
    private enum PeriodScope: Equatable { case latest, all, key(String) }
    private var periods: [String] { Array(Set(store.reviewBatches.compactMap { $0.review.period_key })).sorted(by: >) }
    /// The current period unless the member picked another one or all of them: far fewer rows to read.
    private var period: String? {
        switch scope {
        case .latest: periods.first
        case .all: nil
        case .key(let key): key
        }
    }
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
                Text("\(visible.count) 张工作卡片").font(.app(size: 12)).foregroundStyle(Palette.secondary)
                Spacer()
                Menu {
                    Button("全部周期") { scope = .all }
                    ForEach(periods, id: \.self) { value in Button(PeriodLabel.text(value)) { scope = .key(value) } }
                } label: {
                    Label(period.map(PeriodLabel.text) ?? "全部周期", systemImage: "calendar")
                }.menuStyle(.borderlessButton).fixedSize().frame(minWidth: 116)
                    .accessibilityIdentifier("review-period")
            }.padding(.horizontal, 28).frame(height: 44)
            Rule()
            if let error = store.reviewError {
                HStack(spacing: 12) {
                    Text(error).font(.app(size: 12)).foregroundStyle(Palette.red)
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
                }.frame(width: AppFont.width(278))
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
    private func projectGroups(_ cards: [ReviewCard]) -> [(name: String, cards: [ReviewCard])] {
        Dictionary(grouping: cards, by: \.displayName)
            .map { name, values in
                (name: name, cards: values.sorted { (batch($0)?.review.period_key ?? "") > (batch($1)?.review.period_key ?? "") })
            }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private func cardGroup(_ title: String, cards: [ReviewCard], identifier: String) -> some View {
        Section {
            ForEach(projectGroups(cards), id: \.name) { group in
                // A project appears once; its periods are single short lines beneath the name.
                Text(group.name).font(.app(size: 13, weight: .semibold)).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 4)
                ForEach(group.cards) { card in
                    Button { selectedID = card.id } label: {
                        HStack(spacing: 8) {
                            Text(PeriodLabel.text(batch(card)?.review.period_key)).font(.app(size: 12)).monospacedDigit()
                                .foregroundStyle(Palette.secondary).lineLimit(1)
                            Spacer(minLength: 8)
                            if pendingIDs.contains(card.id) { StatusLabel(text: status(card), color: Palette.yellow, size: 6) }
                            else { Text(status(card)).font(.app(size: 12)).foregroundStyle(Palette.secondary) }
                        }.padding(.leading, 32).padding(.trailing, 20).frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                            .background(selectedID == card.id ? Palette.selected : .white)
                            .overlay(alignment: .leading) { if selectedID == card.id { Rectangle().fill(Palette.yellow).frame(width: 3) } }
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("review-card-\(card.id)")
                        .id("\(identifier):\(card.id):\(card.review_status):\(selectedID == card.id)")
                }
                Rule().padding(.top, 8)
            }
            if cards.isEmpty {
                Text("暂无\(title)卡片").font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 12)
            }
        } header: {
            HStack(spacing: 6) {
                Text(title).fontWeight(.semibold)
                Text("\(cards.count)").monospacedDigit().foregroundStyle(Palette.secondary)
                Spacer()
            }.font(.app(size: 12)).padding(.horizontal, 20).frame(height: 30).background(Palette.quiet)
                .accessibilityIdentifier("review-group-\(identifier)")
        }.id(identifier)
    }
    private func detail(_ card: ReviewCard) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                Text(card.displayName).font(.app(size: 20, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                Text(PeriodLabel.text(batch(card)?.review.period_key)).font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    .help(batch(card)?.review.period_key ?? "")
            }.padding(26).frame(maxWidth: .infinity, alignment: .leading)
            Rule()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("本周进展总览").font(.app(size: 14, weight: .semibold))
                        MarkdownBody(text: card.payload.overview ?? card.payload.summary ?? "暂无内容")
                    }
                    if let progress = card.payload.dailyProgress, !progress.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("每日进展").font(.app(size: 14, weight: .semibold))
                            ForEach(Array(progress.enumerated()), id: \.offset) { _, entry in
                                HStack(alignment: .top, spacing: 16) {
                                    Text(entry.date).font(.app(size: 12)).monospacedDigit().foregroundStyle(Palette.secondary).frame(width: AppFont.width(82), alignment: .leading)
                                    Text(entry.summary).font(.app(size: 13)).lineSpacing(5).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                                }
                            }
                        }
                    }
                    if let job = batch(card)?.job(for: card.id), let error = job.error_message, !error.isEmpty {
                        Text(error).font(.app(size: 12)).foregroundStyle(Palette.red)
                    }
                }.padding(26).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: .infinity)
            if pendingIDs.contains(card.id) {
                Rule()
                VStack(alignment: .leading, spacing: 12) {
                    Text("修改意见").font(.app(size: 13, weight: .semibold))
                    ZStack(alignment: .topLeading) {
                        if instruction.isEmpty {
                            Text("填写需要调整的内容").font(.app(size: 13)).foregroundStyle(Palette.secondary)
                                .padding(.horizontal, 12).padding(.top, 8).allowsHitTesting(false)
                        }
                        TextEditor(text: $instruction).font(.app(size: 13)).scrollContentBackground(.hidden)
                            .padding(7).frame(height: 60)
                            .accessibilityLabel("修改意见").accessibilityIdentifier("review-instruction")
                    }.overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
                    HStack {
                        if batch(card)?.isRegenerating(card.id) == true {
                            ProgressView().controlSize(.small)
                            Text("正在重新生成").font(.app(size: 12)).foregroundStyle(Palette.secondary)
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
                    Button { confirmExclude = true } label: { Text("忽略").frame(width: AppFont.width(70)) }
                        .buttonStyle(QuietButtonStyle()).accessibilityIdentifier("review-exclude")
                    Button { Task { await store.performCardAction(.approve, cardID: card.id) } } label: { Label("通过", systemImage: "checkmark").frame(width: 78) }
                        .buttonStyle(YellowButtonStyle()).accessibilityIdentifier("review-approve")
                }.disabled(busy(card)).padding(.horizontal, 26).padding(.vertical, 18)
            } else {
                Rule()
                Text(status(card)).font(.app(size: 13)).foregroundStyle(Palette.secondary).padding(26)
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
            scope = .all
            selectedID = visible.first(where: { $0.id == id })?.id
        }
    }
}

/// "2026-W45" reads as "第45周". A key with a start-time suffix is a second period for the same week; that start
/// date tells the two apart. Anything unrecognised is shown as written.
enum PeriodLabel {
    private static let pattern = try! NSRegularExpression(pattern: #"^[0-9]{4}-W([0-9]{1,2})(?:-([0-9]{8})T[0-9]{6}Z)?$"#)

    static func text(_ key: String?) -> String {
        guard let key else { return "工作卡片" }
        let source = key as NSString
        guard let match = pattern.firstMatch(in: key, range: NSRange(location: 0, length: source.length)),
              let week = Int(source.substring(with: match.range(at: 1))) else { return key }
        guard match.range(at: 2).location != NSNotFound else { return "第\(week)周" }
        let day = source.substring(with: match.range(at: 2))
        return "第\(week)周 · \(day.dropFirst(4).prefix(2))-\(day.suffix(2)) 起"
    }
}
