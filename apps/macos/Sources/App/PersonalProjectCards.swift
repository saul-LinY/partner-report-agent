import SwiftUI
import WeeklyReportCore

/// 「负责的项目」: one card per project in an adaptive grid, collapsed to two rows like the Web page.
struct PersonalProjectCards: View {
    let projects: [MemberProject]
    @State private var open = false
    @State private var width: CGFloat = 0
    private let spacing: CGFloat = 14
    private let minimumCardWidth: CGFloat = 300
    private static let collapsedRows = 2

    private var columns: Int { max(1, min(3, Int((width + spacing) / (minimumCardWidth + spacing)))) }
    private var limit: Int { columns * Self.collapsedRows }
    private var hidden: Int { max(0, projects.count - limit) }
    private var shown: [MemberProject] { open || hidden == 0 ? projects : Array(projects.prefix(limit)) }

    var body: some View {
        PersonalSection(title: "负责的项目") {
            VStack(alignment: .leading, spacing: 12) {
                if projects.isEmpty {
                    Text("暂无已审核的项目进展").font(.app(size: 13)).foregroundStyle(Palette.secondary).accessibilityIdentifier("personal-projects-empty")
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: spacing, alignment: .top), count: columns), alignment: .leading, spacing: spacing) {
                    ForEach(shown) { ProjectCard(item: $0) }
                }
                if hidden > 0 {
                    Button(open ? "收起" : "展开其余 \(hidden) 个项目") { open.toggle() }
                        .buttonStyle(QuietButtonStyle(compact: true)).accessibilityIdentifier("personal-projects-toggle")
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

private struct ProjectCard: View {
    let item: MemberProject
    private var note: ProjectProfileNote? { item.profile?.note }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.project.projectName).font(.app(size: 15, weight: .semibold)).lineLimit(2)
                Spacer(minLength: 4)
                StateBadge(state: item.state)
            }
            if let line = note?.oneLine?.text, !line.isEmpty {
                Text(line).font(.app(size: 13)).fixedSize(horizontal: false, vertical: true)
            }
            if !item.steps.isEmpty { stage }
            if let note {
                VStack(alignment: .leading, spacing: 8) {
                    if let intro = note.intro?.text, !intro.isEmpty {
                        Text(intro).font(.app(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    bullets("能做什么", note.features)
                    bullets("待解决", note.openIssues)
                }
            }
            Text(item.focus).font(.app(size: 12)).fixedSize(horizontal: false, vertical: true)
            if let blocker = item.blocker {
                Text("当前卡点：\(blocker.title)").font(.app(size: 12, weight: .medium)).foregroundStyle(WebTone.danger).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Text("已开发 \(item.project.contributionDays) 天").font(.app(size: 11)).foregroundStyle(Palette.secondary)
        }
        .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.white, in: RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
        .accessibilityElement(children: .contain).accessibilityIdentifier("personal-project-card-\(item.id)")
    }

    private var stage: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 3) {
                ForEach(Array(item.steps.enumerated()), id: \.offset) { _, step in
                    Capsule().fill(color(step.state)).frame(height: 5)
                }
            }.accessibilityHidden(true)
            Text("\(item.done)/\(item.steps.count) 阶段" + (item.current.map { " · 当前：\($0.name)" } ?? "")).font(.app(size: 11)).foregroundStyle(Palette.secondary)
        }
    }

    private func color(_ state: StepState) -> Color {
        switch state {
        case .done: WebTone.success
        case .current: WebTone.blue.opacity(0.6)
        case .todo: Palette.line
        }
    }

    @ViewBuilder private func bullets(_ title: String, _ claims: [ProfileClaim]) -> some View {
        if !claims.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.app(size: 12, weight: .semibold))
                ForEach(Array(claims.enumerated()), id: \.offset) { _, claim in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").font(.app(size: 12)).foregroundStyle(Palette.secondary)
                        Text(claim.text).font(.app(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}
