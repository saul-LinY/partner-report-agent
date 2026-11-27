import SwiftUI
import WeeklyReportCore

/// Every pending card is laid out in full on one scrolling page with its own actions, so reviewing a week is
/// reading top to bottom and pressing 通过 — no list to click through. Handled cards stay folded at the bottom.
struct WorkCardsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var scope: PeriodScope = .latest
    /// Draft 修改意见 per card; a card shows its editor only while it has an entry here.
    @State private var instructions: [String: String] = [:]
    @State private var excludeID: String?
    @State private var showHandled = false
    @State private var expandedHandled: Set<String> = []
    @State private var scrollTarget: String?
    private enum PeriodScope: Equatable { case latest, all, key(String) }
    private var periods: [String] { Array(Set(store.reviewBatches.compactMap { $0.review.period_key })).sorted(by: >) }
    /// The current period unless the member picked another one or all of them: far fewer cards to read.
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
    private func batch(_ card: ReviewCard) -> ReviewBatch? { scopedBatches.first { $0.items.contains { $0.id == card.id } } }
    private func busy(_ card: ReviewCard) -> Bool { store.isPerformingReviewAction || store.isRefreshingReviews || batch(card)?.isRegenerating(card.id) == true }
    var body: some View {
        VStack(spacing: 0) {
            header
            Rule()
            if let error = store.reviewError {
                HStack(spacing: 12) {
                    Text(error).font(.app(size: 12)).foregroundStyle(Palette.red)
                    Spacer()
                    Button("重试") { Task { await store.refreshReviews() } }.buttonStyle(QuietButtonStyle(compact: true))
                }.padding(.horizontal, 28).padding(.vertical, 10)
                Rule()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if pending.isEmpty {
                            EmptyMessage(symbol: nil, title: allCards.isEmpty ? "暂无工作卡片" : "本期卡片都已处理",
                                         subtitle: store.isLive && !store.hasReviewService ? "未连接系统" : "")
                                .frame(maxWidth: .infinity).padding(.vertical, 24)
                        }
                        // Two cards side by side so a week's review fits on far less scrolling.
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .top), count: 2), alignment: .leading, spacing: 16) {
                            ForEach(pending) { card in pendingCard(card).id(card.id) }
                        }
                        if !handled.isEmpty { handledSection }
                    }.padding(.horizontal, 24).padding(.vertical, 20).frame(maxWidth: .infinity)
                }
                .onChange(of: scrollTarget) { _, target in
                    guard let target else { return }
                    withAnimation { proxy.scrollTo(target, anchor: .top) }
                    scrollTarget = nil
                }
            }.background(Palette.quiet)
        }
        .onAppear { followSelection() }
        .onChange(of: store.selectedApproval) { _, _ in followSelection() }
        .alert("确认拒绝这张工作卡片？", isPresented: Binding(get: { excludeID != nil }, set: { if !$0 { excludeID = nil } }), presenting: excludeID) { id in
            Button("取消", role: .cancel) {}
            Button("拒绝", role: .destructive) { Task { await store.performCardAction(.exclude, cardID: id) } }
        } message: { _ in Text("这张卡片不会进入leader面板。") }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(pending.isEmpty ? "没有待审核的卡片" : "待审核 \(pending.count) 张").font(.app(size: 15, weight: .semibold))
                    .accessibilityIdentifier("review-group-pending")
                deadlineLine
            }
            Spacer()
            Menu {
                Button("全部周期") { scope = .all }
                ForEach(periods, id: \.self) { value in Button(PeriodLabel.text(value)) { scope = .key(value) } }
            } label: {
                Label(period.map(PeriodLabel.text) ?? "全部周期", systemImage: "calendar")
            }.menuStyle(.borderlessButton).fixedSize().frame(minWidth: 116)
                .accessibilityIdentifier("review-period")
        }.padding(.horizontal, 28).padding(.vertical, 12)
    }
    /// The deadline of the earliest review that still has pending cards.
    private var deadlinePeriod: ReviewBatch.Period? {
        scopedBatches.filter { !$0.pendingCards.isEmpty }.compactMap(\.period).min { ($0.autoApproveDate ?? .distantFuture) < ($1.autoApproveDate ?? .distantFuture) }
    }
    /// One quiet line instead of a banner: the countdown is the only part that needs to stand out.
    @ViewBuilder private var deadlineLine: some View {
        if let period = deadlinePeriod {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                HStack(spacing: 6) {
                    if let left = period.countdown(now: context.date) {
                        Text("还剩 \(left) 自动通过").font(.app(size: 12, weight: .semibold)).foregroundStyle(WebTone.blue)
                            .accessibilityIdentifier("review-countdown")
                    } else {
                        Text("已到自动通过时间").font(.app(size: 12, weight: .semibold)).foregroundStyle(WebTone.blue)
                            .accessibilityIdentifier("review-countdown")
                    }
                    Text("· \(period.autoApproveText) 前未处理的按当前内容通过，\(period.publishText) 进入leader面板")
                        .font(.app(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.tail)
                }
            }.accessibilityIdentifier("review-deadline")
        }
    }

    // MARK: Pending cards

    private func pendingCard(_ card: ReviewCard) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            cardTitle(card).padding(.horizontal, 22).padding(.top, 18).padding(.bottom, 12)
            cardContent(card).padding(.horizontal, 22).padding(.bottom, 16)
            // Cards sharing a row stretch to the taller one; keep 通过/拒绝 on the same line across the row.
            Spacer(minLength: 0)
            Rule()
            actions(card).padding(.horizontal, 22).padding(.vertical, 12)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(.white, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line))
        .accessibilityIdentifier("review-card-\(card.id)")
    }
    private func cardTitle(_ card: ReviewCard) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(card.displayName).font(.app(size: 17, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
            // Within one period every card shares the week; only label it when periods are mixed.
            if period == nil {
                Text(PeriodLabel.text(batch(card)?.review.period_key)).font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    .help(batch(card)?.review.period_key ?? "")
            }
            Spacer(minLength: 8)
            statusTag(card)
        }
    }
    /// Summary, focus and blockers in reading order; an empty focus or blocker list takes no space.
    private func cardContent(_ card: ReviewCard) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let focus = card.payload.currentFocus, !focus.isEmpty {
                (Text("当前重点  ").foregroundStyle(Palette.secondary) + Text(focus).fontWeight(.semibold))
                    .font(.app(size: 14)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            MarkdownBody(text: card.payload.overview ?? card.payload.summary ?? "暂无内容")
            blockers(card)
            if let job = batch(card)?.job(for: card.id), let error = job.error_message, !error.isEmpty {
                Text(error).font(.app(size: 12)).foregroundStyle(Palette.red)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private func actions(_ card: ReviewCard) -> some View {
        let draft = Binding(get: { instructions[card.id] ?? "" }, set: { instructions[card.id] = $0 })
        VStack(alignment: .leading, spacing: 10) {
            if instructions[card.id] != nil {
                ZStack(alignment: .topLeading) {
                    if draft.wrappedValue.isEmpty {
                        Text("哪里不对就写在这里，例如：这个不算卡点，已经决定先上架 20 部人工看过的作品").font(.app(size: 13)).foregroundStyle(Palette.secondary)
                            .padding(.horizontal, 12).padding(.top, 8).allowsHitTesting(false)
                    }
                    TextEditor(text: draft).font(.app(size: 13)).scrollContentBackground(.hidden)
                        .padding(7).frame(height: 60)
                        .accessibilityLabel("修改意见").accessibilityIdentifier("review-instruction")
                }.overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
            }
            HStack(spacing: 10) {
                if batch(card)?.isRegenerating(card.id) == true {
                    ProgressView().controlSize(.small)
                    Text("正在重新生成").font(.app(size: 12)).foregroundStyle(Palette.secondary)
                } else if instructions[card.id] != nil {
                    Button("取消") { instructions[card.id] = nil }.buttonStyle(QuietButtonStyle(compact: true))
                    Button { regenerate(card, instruction: draft.wrappedValue) } label: {
                        Label("按意见重新生成", systemImage: "arrow.clockwise")
                    }.buttonStyle(QuietButtonStyle(compact: true))
                        .disabled(busy(card) || !(2...1000).contains(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).count))
                        .accessibilityIdentifier("review-regenerate")
                } else {
                    Button { instructions[card.id] = "" } label: { Label("提修改意见", systemImage: "square.and.pencil") }
                        .buttonStyle(QuietButtonStyle(compact: true)).disabled(busy(card))
                        .accessibilityIdentifier("review-edit")
                }
                Spacer()
                Button { excludeID = card.id } label: { Text("拒绝").frame(width: AppFont.width(56)) }
                    .buttonStyle(QuietButtonStyle(compact: true)).disabled(busy(card)).accessibilityIdentifier("review-exclude")
                Button { Task { await store.performCardAction(.approve, cardID: card.id) } } label: { Label("通过", systemImage: "checkmark").frame(width: 70) }
                    .buttonStyle(YellowButtonStyle(compact: true)).disabled(busy(card)).accessibilityIdentifier("review-approve")
            }
        }
    }
    private func regenerate(_ card: ReviewCard, instruction: String) {
        Task {
            await store.performCardAction(.regenerate(instruction), cardID: card.id)
            if store.reviewError == nil { instructions[card.id] = nil }
        }
    }

    // MARK: Handled cards

    private var handledSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { showHandled.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(showHandled ? 90 : 0))
                    Text("已处理").fontWeight(.semibold)
                    Text("\(handled.count)").monospacedDigit()
                    Spacer()
                }.font(.app(size: 12)).foregroundStyle(Palette.secondary).padding(.vertical, 6).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("review-group-handled")
            if showHandled {
                VStack(spacing: 0) {
                    ForEach(handled) { card in
                        handledRow(card).id(card.id)
                        if card.id != handled.last?.id { Rule() }
                    }
                }
                .background(.white, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line))
            }
        }.padding(.top, pending.isEmpty ? 0 : 8)
    }
    private func handledRow(_ card: ReviewCard) -> some View {
        let expanded = expandedHandled.contains(card.id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if expanded { expandedHandled.remove(card.id) } else { expandedHandled.insert(card.id) }
            } label: {
                HStack(spacing: 10) {
                    Text(card.displayName).font(.app(size: 13, weight: .semibold)).lineLimit(1)
                    Text(PeriodLabel.text(batch(card)?.review.period_key)).font(.app(size: 12)).monospacedDigit()
                        .foregroundStyle(Palette.secondary).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(status(card)).font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.secondary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }.padding(.horizontal, 18).frame(minHeight: 36).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("review-card-\(card.id)")
            if expanded { cardContent(card).padding(.horizontal, 18).padding(.bottom, 14) }
        }
    }

    // MARK: Shared pieces

    @ViewBuilder private func blockers(_ card: ReviewCard) -> some View {
        let open = card.payload.blockers
        let resolved = card.payload.resolvedBlockers ?? []
        if !open.isEmpty || !resolved.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("卡点").font(.app(size: 13, weight: .bold))
                ForEach(Array(open.enumerated()), id: \.offset) { _, blocker in
                    blockerBlock(title: blocker.title, kind: "本周新发现", color: WebTone.danger, background: WebTone.dangerSoft, struck: false) {
                        if let detail = blocker.detail, !detail.isEmpty {
                            Text(detail).font(.app(size: 13)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        if let ask = blocker.neededSupport, !ask.isEmpty {
                            (Text("需要的支持  ").fontWeight(.bold).foregroundStyle(WebTone.danger) + Text(ask))
                                .font(.app(size: 13)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                ForEach(Array(resolved.enumerated()), id: \.offset) { _, blocker in
                    blockerBlock(title: blocker.title, kind: "上期遗留 · 本周已解决", color: WebTone.success, background: WebTone.successSoft, struck: true) {
                        if let evidence = blocker.evidence, !evidence.isEmpty {
                            Text("✓ \(evidence)").font(.app(size: 13)).foregroundStyle(WebTone.success).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }
    private func blockerBlock<Body: View>(title: String, kind: String, color: Color, background: Color, struck: Bool, @ViewBuilder body: () -> Body) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(.app(size: 14, weight: .semibold)).strikethrough(struck, color: Palette.line)
                    .foregroundStyle(struck ? Palette.secondary : Palette.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Text(kind).font(.app(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1)
            }
            body()
        }.padding(.vertical, 10).padding(.horizontal, 14).frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: UnevenRoundedRectangle(bottomTrailingRadius: 6, topTrailingRadius: 6))
            .overlay(alignment: .leading) { Rectangle().fill(color).frame(width: 3) }
            .accessibilityElement(children: .combine)
    }
    private func statusTag(_ card: ReviewCard) -> some View {
        let (foreground, background): (Color, Color) = switch card.review_status {
        case "approved": (WebTone.success, WebTone.successSoft)
        case "excluded": (Palette.secondary, Palette.quiet)
        default: (WebTone.warning, WebTone.warningSoft)
        }
        return Text(status(card)).font(.app(size: 12, weight: .semibold)).foregroundStyle(foreground)
            .padding(.horizontal, 9).padding(.vertical, 2).background(background, in: Capsule())
    }
    private func status(_ card: ReviewCard) -> String {
        if batch(card)?.isRegenerating(card.id) == true { return "重新生成中" }
        switch card.review_status {
        case "approved": return "已通过"
        case "excluded": return "已拒绝"
        default: return "待审核"
        }
    }
    /// A notification or deep link names one card: show every period, unfold it if handled, and scroll to it.
    private func followSelection() {
        guard case .card(let id) = store.selectedApproval else { return }
        scope = .all
        if handled.contains(where: { $0.id == id }) {
            showHandled = true
            expandedHandled.insert(id)
        }
        scrollTarget = id
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
