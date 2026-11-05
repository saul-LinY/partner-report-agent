import SwiftUI
import WeeklyReportCore

/// The colours of the Web leadership pages (styles.css / charts.tsx), so the App's copy reads as the same page.
enum WebTone {
    static let blue = Color(hex: 0x2B6FD6)
    static let blueSoft = Color(hex: 0xE8F0FC)
    static let success = Color(hex: 0x3A8A5C)
    static let danger = Color(hex: 0xC4443A)
    static let dangerSoft = Color(hex: 0xFBEBE8)
    static let warning = Color(hex: 0xB87510)
    static let warningSoft = Color(hex: 0xFBF1DC)
    static let series: [Color] = [0x376B58, 0x48658E, 0x866830, 0x80608E, 0x9B6250, 0x5F7F86].map { Color(hex: $0) }
    static func series(_ index: Int) -> Color { series[index % series.count] }
}

extension ProjectState {
    var foreground: Color {
        switch self {
        case .ok: WebTone.blue
        case .stalled: WebTone.warning
        case .blocked: WebTone.danger
        }
    }
    var background: Color {
        switch self {
        case .ok: WebTone.blueSoft
        case .stalled: WebTone.warningSoft
        case .blocked: WebTone.dangerSoft
        }
    }
}

struct StateBadge: View {
    let state: ProjectState
    var body: some View {
        Text(state.label).font(.app(size: 11, weight: .medium)).foregroundStyle(state.foreground)
            .padding(.horizontal, 9).padding(.vertical, 2).background(state.background, in: Capsule())
            .accessibilityLabel("状态：\(state.label)")
    }
}

/// 个人数据: the member's own, read-only copy of the Web member detail page.
struct PersonalDataView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            header
            Rule()
            if let data = store.personalData {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if let error = store.personalDataError { errorBanner(error) }
                        PersonalKPIs(headline: data.headline)
                        PersonalProjectCards(projects: data.projects)
                        PersonalActivityChart(data: data)
                        PersonalProgressView(data: data)
                    }.padding(.horizontal, 28).padding(.vertical, 22).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let error = store.personalDataError {
                VStack(spacing: 14) {
                    EmptyMessage(symbol: "exclamationmark.circle", title: "个人数据暂不可用", subtitle: error)
                    Button("重试") { reload() }.buttonStyle(YellowButtonStyle()).accessibilityIdentifier("personal-data-retry")
                }.frame(maxHeight: .infinity)
            } else {
                VStack { ProgressView().controlSize(.small); Text("加载成员…").font(.app(size: 13)).foregroundStyle(Palette.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("personal-data-loading")
            }
        }
        .accessibilityIdentifier("personal-data-page")
        .task { await store.loadPersonalData() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(store.personalData?.member.name ?? "个人数据").font(.app(size: 23, weight: .semibold)).accessibilityIdentifier("personal-member-name")
                Text("该成员负责的项目进展与工作活跃度").font(.app(size: 13)).foregroundStyle(Palette.secondary)
                Text("数据更新周期：会话活跃度和项目简介随本 App 的每次上传（每天或每周定时，也可手动）与分析更新；项目状态、阶段和进展在每期截止后生成工作卡片，经你审核确认后更新。打开本页或点右上角刷新时重新读取。")
                    .font(.app(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("personal-update-cycle")
            }
            Spacer()
            if store.isLoadingPersonalData { ProgressView().controlSize(.small) }
            IconButton(symbol: "arrow.clockwise", help: "刷新个人数据") { reload() }
                .disabled(store.isLoadingPersonalData).accessibilityIdentifier("personal-data-refresh")
        }.frame(minHeight: 72).padding(.horizontal, 28).padding(.vertical, 8)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 12) {
            Text(message).font(.app(size: 12)).foregroundStyle(Palette.red)
            Spacer()
            Button("重试") { reload() }.buttonStyle(QuietButtonStyle(compact: true))
        }.padding(14).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.red.opacity(0.4)))
    }

    /// Reloads the month the member is looking at, so a refresh does not jump the calendar back.
    private func reload() {
        let month = store.personalData?.calendar.month
        Task { await store.loadPersonalData(month: month) }
    }
}

private struct PersonalKPIs: View {
    let headline: MemberHeadline
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            tile("负责的项目", "\(headline.projectCount)", id: "projects")
            tile("需要关注", "\(headline.attention)", note: "有卡点或停滞的项目", warn: headline.attention > 0, id: "attention")
            tile("近 28 天活跃", "\(headline.activeDays28)", note: "天", id: "active-days")
            tile("最近活跃", headline.lastActiveDate.map { String($0.dropFirst(5)) } ?? "--", note: headline.lastActiveDate.map { String($0.prefix(4)) } ?? "", id: "last-active")
        }
    }
    private func tile(_ title: String, _ value: String, note: String = "", warn: Bool = false, id: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.app(size: 12)).foregroundStyle(Palette.secondary)
            Text(value).font(.app(size: 26, weight: .semibold)).monospacedDigit().foregroundStyle(warn ? WebTone.warning : Palette.ink)
            Text(note.isEmpty ? " " : note).font(.app(size: 11)).foregroundStyle(Palette.secondary)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(.white, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
            .accessibilityElement(children: .combine).accessibilityIdentifier("personal-kpi-\(id)")
    }
}

/// Section frame shared by the page's blocks.
struct PersonalSection<Content: View, Controls: View>: View {
    let title: String
    @ViewBuilder var controls: Controls
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Text(title).font(.app(size: 17, weight: .semibold))
                Spacer(minLength: 8)
                controls
            }
            content
        }
    }
}

extension PersonalSection where Controls == EmptyView {
    init(title: String, @ViewBuilder content: () -> Content) {
        self.init(title: title, controls: { EmptyView() }, content: content)
    }
}
