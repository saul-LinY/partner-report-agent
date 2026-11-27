import AppKit
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
    static let successSoft = Color(hex: 0xE8F4EC)
    static let series: [Color] = [0x2563EB, 0xC026D3, 0xF08C00, 0x0EA5B7, 0x9B6250, 0x80608E, 0x376B58, 0x866830].map { Color(hex: $0) }
    static func series(_ index: Int) -> Color { series[index % series.count] }
}

/// 本周进展: what the system has already recorded about the member's current weekly period.
struct PersonalDataView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            header
            Rule()
            if let data = store.personalData {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let error = store.personalDataError { errorBanner(error) }
                        PersonalWeekBar(data: data)
                        PersonalKPIs(data: data)
                        PersonalInvestment(data: data)
                        PersonalOwnedProjects(data: data)
                    }.padding(.horizontal, 28).padding(.vertical, 22).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let error = store.personalDataError {
                VStack(spacing: 14) {
                    EmptyMessage(symbol: "exclamationmark.circle", title: "本周进展暂不可用", subtitle: error)
                    Button("重试") { reload() }.buttonStyle(YellowButtonStyle()).accessibilityIdentifier("personal-data-retry")
                }.frame(maxHeight: .infinity)
            } else {
                VStack { ProgressView().controlSize(.small); Text("加载本周进展…").font(.app(size: 13)).foregroundStyle(Palette.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("personal-data-loading")
            }
        }
        .accessibilityIdentifier("personal-data-page")
        // The open page follows the system instead of keeping the first answer: on open, every minute, and when the App
        // comes to the front (uploads trigger a reload from the store).
        .task {
            while !Task.isCancelled {
                await store.loadPersonalData()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in reload() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text("本周进展").font(.app(size: 23, weight: .semibold)).accessibilityIdentifier("personal-page-title")
                Text("本周记录进度，以及与leader面板相同的工作投入和负责的项目，实时读取")
                    .font(.app(size: 13)).foregroundStyle(Palette.secondary).accessibilityIdentifier("personal-page-subtitle")
            }
            Spacer()
            if store.isLoadingPersonalData { ProgressView().controlSize(.small) }
            IconButton(symbol: "arrow.clockwise", help: "刷新本周进展") { reload() }
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

    private func reload() {
        Task { await store.loadPersonalData() }
    }
}

/// "W47 · 11月17日 11:10 – 11月20日（周五）16:00", the four steps of the week, and the countdown to the cutoff.
private struct PersonalWeekBar: View {
    let data: PersonalData

    private struct Step { var title: String; var note: String }
    private var steps: [Step] {
        let zone = data.timezone
        return [
            Step(title: "本周记录中", note: "每次上传后更新这页"),
            Step(title: PersonalActivity.stamp(data.period.cutoffAt, timezone: zone), note: "截止，生成工作卡给你审核"),
            Step(title: "\(PersonalActivity.stamp(data.period.autoApproveAt, timezone: zone)) 前", note: "审核，逾期自动通过"),
            Step(title: PersonalActivity.stamp(data.period.publishAt, timezone: zone), note: "发布到leader面板"),
        ]
    }

    var body: some View {
        // Re-evaluated every half minute so the countdown and the current step follow the clock.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let current = data.currentStep(now: context.date)
            HStack(alignment: .center, spacing: 18) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("\(data.weekLabel) · \(data.rangeLabel)").font(.app(size: 16, weight: .semibold))
                        .accessibilityIdentifier("personal-week-range")
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                            stepView(step, on: index == current, last: index == steps.count - 1)
                        }
                    }
                }
                VStack(alignment: .trailing, spacing: 2) {
                    Text("距本周截止").font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    Text(PersonalActivity.countdown(to: data.period.cutoffAt, now: context.date)).font(.app(size: 22, weight: .semibold)).monospacedDigit()
                        .accessibilityIdentifier("personal-week-countdown")
                }.fixedSize()
            }
            .padding(.horizontal, 20).padding(.vertical, 16).background(Palette.quiet, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
        }
    }

    private func stepView(_ step: Step, on: Bool, last: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            ZStack(alignment: .leading) {
                if !last { Rectangle().fill(Palette.line).frame(height: 2).padding(.leading, 14).padding(.trailing, 4) }
                Circle().fill(on ? Palette.yellow : .white).frame(width: 10, height: 10)
                    .overlay(Circle().stroke(on ? Palette.ink : Palette.line, lineWidth: 2))
            }.frame(height: 10).padding(.bottom, 6)
            Text(step.title).font(.app(size: 12, weight: on ? .semibold : .regular)).foregroundStyle(on ? Palette.ink : Palette.secondary)
            Text(step.note).font(.app(size: 11)).foregroundStyle(Palette.secondary)
        }
        .padding(.trailing, 8).frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine).accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// 本周会话 / 本周交互 / 活跃天数 / 上次上传.
private struct PersonalKPIs: View {
    let data: PersonalData

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            tile("本周会话", "\(data.totals.sessions)", note: "涉及 \(data.activeProjectCount) 个项目", id: "sessions")
            tile("本周交互", "\(data.totals.turns) 轮", note: "已剔除测试、闲聊", id: "turns")
            tile("活跃天数", "\(data.totals.activeDays) / \(data.totals.elapsedDays) 天", note: "本周已过 \(data.totals.elapsedDays) 天", id: "active-days")
            uploadTile
        }.fixedSize(horizontal: false, vertical: true)
    }

    private var uploadTile: some View {
        let value = data.lastUpload.map { "\(PersonalActivity.stamp($0.at, timezone: data.timezone)) · \($0.label)" } ?? "还没有上传"
        return card(id: "last-upload") {
            Text("上次上传").font(.app(size: 12)).foregroundStyle(Palette.secondary)
            Text(value).font(.app(size: 15, weight: .semibold)).foregroundStyle(data.todayNotUploaded ? WebTone.warning : Palette.ink)
                .padding(.top, 6).fixedSize(horizontal: false, vertical: true)
            if data.todayNotUploaded { Text("今天的会话还没上传").font(.app(size: 12)).foregroundStyle(WebTone.warning) }
        }
    }

    private func tile(_ title: String, _ value: String, note: String, id: String) -> some View {
        card(id: id) {
            Text(title).font(.app(size: 12)).foregroundStyle(Palette.secondary)
            Text(value).font(.app(size: 22, weight: .semibold)).monospacedDigit()
            Text(note).font(.app(size: 12)).foregroundStyle(Palette.secondary)
        }
    }

    private func card<Content: View>(id: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) { content() }
            .padding(.horizontal, 16).padding(.vertical, 14).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
            .accessibilityElement(children: .combine).accessibilityIdentifier("personal-kpi-\(id)")
    }
}
