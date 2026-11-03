import SwiftUI
import WeeklyReportCore

struct ApprovalsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var cards = false
    var body: some View {
        VStack(spacing: 0) {
            PageHeading(title: "待审批项") {
                if cards {
                    IconButton(symbol: "arrow.clockwise", help: "刷新工作卡片") {
                        Task { await store.refreshReviews() }
                    }.disabled(store.isRefreshingReviews)
                }
            }
            HStack(spacing: 16) {
                FilterTab(title: "工作卡片", count: store.pendingCards.count, selected: cards) { cards = true }
                    .accessibilityIdentifier("approval-cards-tab")
                FilterTab(title: "项目审批", count: store.newProjectCount, selected: !cards) { cards = false }
                    .accessibilityIdentifier("approval-projects-tab")
                Spacer()
            }.padding(.horizontal, 28)
            Rule()
            if cards { WorkCardsView() }
            else { ProjectApprovalsView() }
        }
        .onAppear { followSelection() }
        .onChange(of: store.selectedApproval) { _, _ in followSelection() }
    }
    private func followSelection() {
        if case .card = store.selectedApproval { cards = true }
        else if case .project = store.selectedApproval { cards = false }
    }
}

private struct ProjectApprovalsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var addingProject = false
    @State private var error: String?
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Text("\(store.projects.count) 个项目").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                Spacer()
                Button { addingProject = true } label: { Label("添加项目", systemImage: "plus") }
                    .buttonStyle(YellowButtonStyle()).accessibilityIdentifier("add-project")
            }.padding(.horizontal, 28).padding(.vertical, 16)
            ScrollView {
                VStack(spacing: 0) {
                    columns {
                        Text("项目").frame(minWidth: 80, idealWidth: 125, maxWidth: 125, alignment: .leading)
                        Text("文件夹").frame(minWidth: 34, maxWidth: .infinity, alignment: .leading)
                        Text("会话来源").frame(width: 118, alignment: .trailing)
                        Text("发现时间").frame(width: 86, alignment: .leading)
                        Text("操作").frame(width: 204)
                    }.font(.system(size: 12)).foregroundStyle(Palette.secondary).frame(height: 38).background(Palette.quiet)
                    ForEach([ProjectPermission.pending, .allowed, .denied], id: \.self) { permission in
                        let group = store.projects.filter { $0.permission == permission }
                        HStack(spacing: 9) {
                            Circle().fill(permission == .pending ? Palette.yellow : permission == .allowed ? Palette.green : Palette.secondary).frame(width: 6, height: 6)
                            Text(groupTitle(permission)).font(.system(size: 13, weight: .semibold))
                            Text("\(group.count)").font(.system(size: 11)).monospacedDigit().foregroundStyle(Palette.secondary)
                            Spacer()
                        }.padding(.horizontal, 10).frame(height: 44).padding(.top, 12)
                            .accessibilityIdentifier("project-group-\(permission.rawValue)")
                        Rule()
                        ForEach(group) { project in projectRow(project); Rule() }
                        if group.isEmpty {
                            Text("暂无\(groupTitle(permission))项目").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).padding(.vertical, 18)
                        }
                    }
                }.padding(.horizontal, 28)
            }
            HStack(spacing: 8) {
                Image(systemName: "checkmark.shield")
                Text("允许后才读取会话正文；已归档内容不扫描、不上传。")
            }.font(.system(size: 11)).foregroundStyle(Palette.secondary).padding(.vertical, 24).frame(maxWidth: .infinity)
        }
        .sheet(isPresented: $addingProject) { ProjectRegistrationSheet().environmentObject(store) }
        .alert("无法更改文件夹", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("关闭", role: .cancel) {}
        } message: { Text(error ?? "") }
    }
    private func groupTitle(_ permission: ProjectPermission) -> String {
        switch permission {
        case .pending: "待审批"
        case .allowed: "已允许"
        case .denied: "已拒绝"
        }
    }
    private func projectRow(_ project: Project) -> some View {
        columns {
            Label { Text(project.name).fontWeight(.medium).lineLimit(2) } icon: { Image(systemName: "folder").font(.system(size: 17)) }
                .frame(minWidth: 80, idealWidth: 125, maxWidth: 125, alignment: .leading).help(project.name)
            HStack(spacing: 8) {
                Text(displayPath(project.folder)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.secondary)
                    .lineLimit(1).truncationMode(.middle).help(project.folder)
                IconButton(symbol: "folder", help: "选择 \(project.name) 的项目文件夹") { changeFolder(project) }
                    .accessibilityIdentifier("choose-project-folder-\(project.id)")
                Spacer(minLength: 0)
            }.frame(minWidth: 34, maxWidth: .infinity, alignment: .leading)
            AgentStack(agents: store.agents(for: project)).frame(width: 118, alignment: .trailing)
            Text(project.discoveredAt.map { $0.formatted(.dateTime.month().day().hour().minute()) } ?? (store.isLive ? "已登记" : "今天 14:32"))
                .font(.system(size: 11)).foregroundStyle(Palette.secondary).frame(width: 86, alignment: .leading)
            HStack(spacing: 8) {
                if project.permission != .allowed {
                    Button { decide(project, .allowed) } label: { Text("允许采集").frame(width: 72) }
                        .buttonStyle(YellowButtonStyle(compact: true)).accessibilityIdentifier("allow-project-\(project.id)")
                        .disabled(store.collectionProgress != nil || store.isConnecting || store.isUploading || (store.hasCollectorService && project.folder.isEmpty))
                }
                if project.permission != .denied {
                    Button { decide(project, .denied) } label: { Text("禁止采集").frame(width: 72) }
                        .buttonStyle(QuietButtonStyle(compact: true)).accessibilityIdentifier("deny-project-\(project.id)")
                        .disabled(store.isConnecting || store.isUploading)
                }
            }.frame(width: 204, alignment: .leading)
        }.font(.system(size: 13)).frame(minHeight: 80)
    }
    private func columns<Content: View>(@ViewBuilder _ content: () -> Content) -> some View { HStack(spacing: 10, content: content).padding(.horizontal, 10) }
    private func changeFolder(_ project: Project) {
        guard let folder = chooseDirectory(title: "选择项目文件夹", current: project.folder) else { return }
        do { try store.changeProjectFolder(project.id, to: folder) }
        catch { self.error = error.localizedDescription }
    }
    private func decide(_ project: Project, _ permission: ProjectPermission) {
        if permission == .allowed { Task { await store.collectProject(project.id) } }
        else { store.decideProject(project.id, permission: permission) }
    }
}

struct ProjectRegistrationSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var folder = ""
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SectionTitle(title: "添加项目")
            VStack(alignment: .leading, spacing: 8) {
                Text("项目名称").font(.system(size: 13))
                TextField("例如：客户资料整理", text: $name).modifier(FieldStyle()).accessibilityIdentifier("project-name")
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("项目文件夹").font(.system(size: 13))
                HStack {
                    Text(folder.isEmpty ? "尚未选择文件夹" : displayPath(folder)).font(.system(size: 12, design: .monospaced)).lineLimit(2).foregroundStyle(Palette.secondary)
                    Spacer()
                    IconButton(symbol: "folder", help: "选择项目文件夹") {
                        if let selected = chooseDirectory(title: "选择项目文件夹") {
                            folder = selected
                            if name.isEmpty { name = URL(fileURLWithPath: selected).lastPathComponent }
                        }
                    }
                }.padding(10).background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6))
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Palette.red) }
            HStack {
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(QuietButtonStyle()).keyboardShortcut(.cancelAction)
                Button("添加") {
                    do { try store.registerProject(name: name, folder: folder); dismiss() }
                    catch { self.error = error.localizedDescription }
                }.buttonStyle(YellowButtonStyle()).disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || folder.isEmpty).keyboardShortcut(.defaultAction)
            }
        }.padding(28).frame(width: 470).foregroundStyle(Palette.ink).background(.white)
    }
}
