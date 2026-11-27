import SwiftUI
import WeeklyReportCore

/// 负责的项目: the leadership page's project cards for the member, read live; projects that are stalled, shelved, or no
/// longer allowed to be uploaded are left out.
struct PersonalOwnedProjects: View {
    let data: PersonalData

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("负责的项目").font(.app(size: 17, weight: .semibold))
            if data.owned.isEmpty {
                Text("没有在推进的项目").font(.app(size: 13)).foregroundStyle(Palette.secondary)
                    .frame(maxWidth: .infinity, minHeight: 80).accessibilityIdentifier("personal-owned-empty")
            } else {
                Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                    ForEach(Array(stride(from: 0, to: data.owned.count, by: 2)), id: \.self) { start in
                        GridRow {
                            ForEach(start..<min(start + 2, data.owned.count), id: \.self) { index in
                                card(data.owned[index])
                            }
                            if start + 1 >= data.owned.count { Color.clear.frame(maxWidth: .infinity) }
                        }
                    }
                }
            }
        }.accessibilityIdentifier("personal-owned")
    }

    private func card(_ project: PersonalOwnedProject) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(project.name).font(.app(size: 16, weight: .semibold))
                if let oneLine = project.oneLine { Text(oneLine).font(.app(size: 12)).foregroundStyle(Palette.secondary) }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("当前重点").font(.app(size: 11)).foregroundStyle(Palette.secondary)
                Text(project.focus ?? "暂无当前重点").font(.app(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6))
            if let intro = project.intro { section("项目简介") { Text(intro).font(.app(size: 13)).fixedSize(horizontal: false, vertical: true) } }
            section("已开发") { Text("\(project.contributionDays) 天").font(.app(size: 13)) }
            if !project.features.isEmpty { section("主要功能") { bullets(project.features) } }
            if !project.openIssues.isEmpty {
                section("待验证的风险", tone: WebTone.warning) {
                    bullets(project.openIssues)
                    Text("风险是还没验证的假设，不等于卡点。").font(.app(size: 11)).foregroundStyle(Palette.secondary)
                }
            }
        }
        .padding(18).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
        .accessibilityElement(children: .contain).accessibilityIdentifier("personal-owned-\(project.name)")
    }

    private func section(_ title: String, tone: Color = Palette.secondary, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.app(size: 12, weight: .semibold)).foregroundStyle(tone)
            content()
        }
    }

    private func bullets(_ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").font(.app(size: 13))
                    Text(item).font(.app(size: 13)).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
