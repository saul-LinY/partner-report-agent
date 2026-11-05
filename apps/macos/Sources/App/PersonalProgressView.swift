import SwiftUI
import WeeklyReportCore

/// 「项目详细进展」: pick one of the member's projects, then its goal, roadmap, focus, key events and the
/// month calendar of reviewed daily progress. Read-only: no participation editing and no weekly-card links.
struct PersonalProgressView: View {
    @EnvironmentObject private var store: AppStore
    let data: PersonalData
    @State private var selectedID: String?
    @State private var aboutOpen = false

    private var ordered: [MemberProject] { data.projectsByRecency }
    private var selected: MemberProject? { ordered.first { $0.id == selectedID } ?? ordered.first }

    var body: some View {
        PersonalSection(title: "项目详细进展") {
            if let selected {
                VStack(alignment: .leading, spacing: 16) {
                    picker(selected)
                    ProjectOverview(project: selected.project, aboutOpen: $aboutOpen)
                    ProjectCalendar(data: data, project: selected.project, colorIndex: data.projects.firstIndex { $0.id == selected.id } ?? 0)
                }
                .id(selected.id)
            } else {
                Text("暂无已审核的项目进展").font(.app(size: 13)).foregroundStyle(Palette.secondary).accessibilityIdentifier("personal-progress-empty")
            }
        }
        .onChange(of: selected?.id) { _, _ in aboutOpen = false }
    }

    private func picker(_ current: MemberProject) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ordered) { item in
                    let on = item.id == current.id
                    Button { selectedID = item.id } label: {
                        Text(item.project.projectName).font(.app(size: 13, weight: on ? .semibold : .regular)).padding(.horizontal, 12).frame(height: 30)
                            .background(on ? Palette.selected : .white, in: RoundedRectangle(cornerRadius: 6))
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(on ? Palette.yellow : Palette.line))
                    }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
                        .accessibilityLabel("查看 \(data.member.name) 的 \(item.project.projectName)")
                        .accessibilityIdentifier("personal-project-choice-\(item.id)")
                }
            }
        }
    }
}

private struct ProjectOverview: View {
    let project: ProgressProject
    @Binding var aboutOpen: Bool
    private var description: String { project.projectDescription?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(project.projectName).font(.app(size: 16, weight: .semibold))
                Spacer()
                Text("已开发 \(project.contributionDays) 天").font(.app(size: 12)).foregroundStyle(Palette.secondary)
                    .accessibilityIdentifier("personal-progress-days")
            }
            if let outlook = project.outlook {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("项目目标").font(.app(size: 13, weight: .semibold))
                        Spacer()
                        if !description.isEmpty {
                            Button { aboutOpen.toggle() } label: {
                                Label("产品介绍", systemImage: aboutOpen ? "chevron.up" : "chevron.down").labelStyle(TrailingIconLabelStyle())
                            }.buttonStyle(QuietButtonStyle(compact: true)).accessibilityIdentifier("personal-about-toggle")
                        }
                    }
                    Text(outlook.goal).font(.app(size: 13)).fixedSize(horizontal: false, vertical: true)
                    if aboutOpen, !description.isEmpty {
                        Text(description).font(.app(size: 12)).foregroundStyle(Palette.secondary).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6)).fixedSize(horizontal: false, vertical: true)
                    }
                    roadmap(outlook.roadmap)
                    Text(outlook.position).font(.app(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(description.isEmpty ? "暂无项目说明" : description).font(.app(size: 13)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("当前重点").font(.app(size: 13, weight: .semibold))
                Text(project.focusText).font(.app(size: 13)).fixedSize(horizontal: false, vertical: true)
            }.accessibilityIdentifier("personal-progress-focus")
            if !project.keyEvents.isEmpty { keyEvents }
            Text("研发天数按已审核工作内容的日期统计，同一天多条记录计 1 天。").font(.app(size: 11)).foregroundStyle(Palette.secondary)
            if project.undatedCount > 0 {
                Text("另有 \(project.undatedCount) 条记录缺少有效日期，未计入研发天数。").font(.app(size: 11)).foregroundStyle(Palette.secondary)
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
    }

    private func roadmap(_ steps: [ProjectStep]) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                VStack(alignment: .leading, spacing: 3) {
                    Text(step.state.label).font(.app(size: 10, weight: .medium)).foregroundStyle(tint(step.state))
                    Text(step.name).font(.app(size: 12, weight: step.state == .current ? .semibold : .regular))
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(step.state == .current ? WebTone.blueSoft : Palette.quiet, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(step.state == .current ? WebTone.blue.opacity(0.5) : Palette.line))
                .accessibilityElement(children: .combine)
            }
        }.accessibilityIdentifier("personal-roadmap")
    }

    private func tint(_ state: StepState) -> Color {
        switch state {
        case .done: WebTone.success
        case .current: WebTone.blue
        case .todo: Palette.secondary
        }
    }

    private var keyEvents: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("项目进展").font(.app(size: 13, weight: .semibold))
            ForEach(project.keyEvents) { event in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(event.date).font(.app(size: 12)).monospacedDigit().foregroundStyle(Palette.secondary)
                        Text(event.typeLabel).font(.app(size: 11, weight: .medium)).padding(.horizontal, 7).padding(.vertical, 1)
                            .background(event.type == "blocker" ? WebTone.dangerSoft : Palette.bubble, in: Capsule())
                            .foregroundStyle(event.type == "blocker" ? WebTone.danger : Palette.ink)
                        Text(event.title).font(.app(size: 13, weight: .semibold))
                    }
                    if let step = event.step, !step.isEmpty { Text("所属阶段：\(step)").font(.app(size: 11)).foregroundStyle(Palette.secondary) }
                    if !event.detail.isEmpty { Text(event.detail).font(.app(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true) }
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .leading) { Rectangle().fill(event.type == "blocker" ? WebTone.danger : Palette.line).frame(width: 3) }
                .background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6))
            }
        }.accessibilityIdentifier("personal-key-events")
    }
}

private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) { configuration.title; configuration.icon.font(.app(size: 11)) }
    }
}
