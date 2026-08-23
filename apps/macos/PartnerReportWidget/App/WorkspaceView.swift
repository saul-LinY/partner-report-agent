import SwiftUI
import WidgetKit

enum WorkspaceSection: String, CaseIterable, Identifiable {
    case permissions = "采集权限"
    case cards = "工作卡片"
    case settings = "设置"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .permissions: return "folder.badge.gearshape"
        case .cards: return "rectangle.stack"
        case .settings: return "gearshape"
        }
    }
}

@MainActor
final class WorkspaceModel: ObservableObject {
    @Published var section: WorkspaceSection = .permissions
    @Published var queue = SharedStore.shared.cachedQueue
    @Published var selectedCardID: String?
    @Published var stagedPermissions: [String: String] = [:]
    @Published var instruction = ""
    @Published var isLoading = false
    @Published var isSubmitting = false
    @Published var errorMessage: String?

    var selectedCard: WorkCard? {
        let cards = queue.workCards ?? []
        return cards.first(where: { $0.id == selectedCardID }) ?? cards.first
    }

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            queue = try await WidgetAPIClient().fetchQueue()
            if selectedCard == nil { selectedCardID = queue.workCards?.first?.id }
            WidgetCenter.shared.reloadAllTimelines()
        } catch { errorMessage = error.localizedDescription }
    }

    func savePermissions() async {
        guard let collection = queue.permissions else { return }
        await perform {
            try await WidgetAPIClient().updatePermissions(stagedPermissions, collection: collection)
            stagedPermissions.removeAll()
        }
    }

    func decide(_ value: String) async {
        guard let card = selectedCard else { return }
        await perform { try await WidgetAPIClient().decide(card: card, decision: value) }
    }

    func regenerate() async {
        guard let card = selectedCard, instruction.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else { return }
        await perform {
            try await WidgetAPIClient().regenerate(card: card, instruction: instruction)
            instruction = ""
        }
    }

    private func perform(_ operation: () async throws -> Void) async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await operation()
            queue = SharedStore.shared.cachedQueue
            selectedCardID = selectedCard?.id ?? queue.workCards?.first?.id
            WidgetCenter.shared.reloadAllTimelines()
        } catch { errorMessage = error.localizedDescription }
    }
}

struct WorkspaceView: View {
    @StateObject private var model = WorkspaceModel()
    let onDisconnect: () -> Void

    var body: some View {
        NavigationSplitView {
            List(selection: $model.section) {
                Section {
                    ForEach(WorkspaceSection.allCases) { item in
                        Label(item.rawValue, systemImage: item.icon).tag(item)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 210)
            .safeAreaInset(edge: .top) {
                HStack(spacing: 10) {
                    Image("WorkDashboardIcon").resizable().scaledToFit().frame(width: 34, height: 34)
                    Text("工作看板").font(.headline)
                    Spacer()
                }.padding(14)
            }
        } detail: {
            VStack(spacing: 0) {
                pageHeader
                Divider()
                if let error = model.errorMessage, model.section != .settings {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.red).padding(.horizontal, 24).padding(.top, 12)
                }
                Group {
                    switch model.section {
                    case .permissions: PermissionsView(model: model)
                    case .cards: WorkCardsView(model: model)
                    case .settings: SettingsView(onDisconnect: onDisconnect)
                    }
                }
            }
        }
        .task { await model.load() }
        .onOpenURL { url in
            if url.scheme == "workdashboard" { model.section = url.host == "permissions" ? .permissions : .cards }
        }
    }

    private var pageHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(model.section.rawValue).font(.title2.weight(.semibold))
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            if model.section != .settings {
                Button { Task { await model.load() } } label: {
                    if model.isLoading { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.clockwise") }
                }
                .buttonStyle(.borderless).help("刷新")
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 17)
    }

    private var subtitle: String {
        switch model.section {
        case .permissions: return "决定哪些项目可以采集，也可以随时修改旧项目"
        case .cards: return "查看并调整最新一周的项目工作卡片"
        case .settings: return "更新 Codex 插件，或解除这台 Mac 的绑定"
        }
    }
}

struct PermissionsView: View {
    @ObservedObject var model: WorkspaceModel
    private var items: [ProjectPermission] { model.queue.permissions?.items ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                let pending = items.filter { $0.status == "pending" }.count
                Label(pending == 0 ? "权限已同步" : "\(pending) 个新项目需要选择", systemImage: pending == 0 ? "checkmark.circle.fill" : "sparkles")
                    .foregroundStyle(pending == 0 ? .green : .orange)
                Spacer()
                Button("保存修改") { Task { await model.savePermissions() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.stagedPermissions.isEmpty || model.isSubmitting)
            }
            .padding(20)
            Divider()
            if items.isEmpty {
                ContentUnavailableView("还没有项目", systemImage: "folder", description: Text("插件发现项目后会显示在这里。"))
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            HStack(spacing: 16) {
                                Image(systemName: item.status == "pending" ? "folder.badge.questionmark" : "folder.fill")
                                    .foregroundStyle(item.status == "pending" ? Color.orange : Color.accentColor)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 7) {
                                        Text(item.displayName).font(.body.weight(.medium))
                                        if item.status == "pending" { Text("新项目").font(.caption2.weight(.semibold)).foregroundStyle(.orange) }
                                    }
                                    Text("发现 \(item.sessionCount) 个相关 Session · 最近更新 \(shortDate(item.lastSeenAt))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Picker("权限", selection: permissionBinding(item)) {
                                    Text("允许采集").tag("allow")
                                    Text("不采集").tag("deny")
                                }
                                .labelsHidden().frame(width: 120)
                            }
                            .padding(.horizontal, 24).padding(.vertical, 14)
                            Divider().padding(.leading, 64)
                        }
                    }
                }
            }
        }
    }

    private func permissionBinding(_ item: ProjectPermission) -> Binding<String> {
        Binding(
            get: { model.stagedPermissions[item.scopeKey] ?? (item.status == "denied" ? "deny" : "allow") },
            set: { model.stagedPermissions[item.scopeKey] = $0 }
        )
    }
}

struct WorkCardsView: View {
    @ObservedObject var model: WorkspaceModel
    private var cards: [WorkCard] { model.queue.workCards ?? [] }

    var body: some View {
        HSplitView {
            List(cards, selection: $model.selectedCardID) { card in
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(card.projectName).font(.body.weight(.semibold)).lineLimit(1)
                        Spacer()
                        Circle().fill(reviewColor(card.reviewStatus)).frame(width: 7, height: 7)
                    }
                    Text("\(card.sourceCount) 条有效记录 · \(reviewLabel(card.reviewStatus))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 5).tag(card.id)
            }
            .frame(minWidth: 230, idealWidth: 260, maxWidth: 310)

            if let card = model.selectedCard {
                WorkCardDetail(model: model, card: card)
            } else {
                ContentUnavailableView("暂无工作卡片", systemImage: "rectangle.stack", description: Text("每周会为有有效记录的项目生成一张新卡片。"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct WorkCardDetail: View {
    @ObservedObject var model: WorkspaceModel
    let card: WorkCard
    @State private var selectedVersion: Int?

    private var currentVersion: WorkCardVersion? {
        let version = selectedVersion ?? card.versions.first?.version
        return card.versions.first(where: { $0.version == version })
    }
    private var previousVersion: WorkCardVersion? {
        guard let currentVersion else { return nil }
        return card.versions.first(where: { $0.version == currentVersion.version - 1 })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(card.projectName).font(.title2.weight(.semibold))
                        Text("\(card.periodKey) · \(card.sourceCount) 条有效 Session")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(reviewLabel(card.reviewStatus)).font(.caption.weight(.semibold))
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(reviewColor(card.reviewStatus).opacity(0.12), in: Capsule())
                        .foregroundStyle(reviewColor(card.reviewStatus))
                }

                if card.versions.count > 1 {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("版本记录").font(.headline)
                        Picker("版本", selection: Binding(get: { selectedVersion ?? card.versions.first?.version }, set: { selectedVersion = $0 })) {
                            ForEach(card.versions) { version in Text("v\(version.version)").tag(Optional(version.version)) }
                        }.pickerStyle(.segmented)
                        HStack(alignment: .top, spacing: 12) {
                            VersionPane(title: "修改前", version: previousVersion, tint: .red)
                            VersionPane(title: "修改后", version: currentVersion, tint: .green)
                        }
                    }
                } else {
                    VersionPane(title: "卡片内容", version: card.versions.first, tint: .accentColor)
                }

                if card.reviewStatus == "pending" {
                    Divider()
                    VStack(alignment: .leading, spacing: 9) {
                        Text("告诉工作看板怎么修改").font(.headline)
                        TextEditor(text: $model.instruction)
                            .frame(minHeight: 88).padding(8)
                            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                        HStack {
                            Text("可以补充遗漏、纠正事实、调整表达或项目状态。")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("按描述修改") { Task { await model.regenerate() } }
                                .disabled(model.instruction.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 || card.busy || model.isSubmitting)
                        }
                    }
                    HStack {
                        Button("忽略", role: .destructive) { Task { await model.decide("exclude") } }
                        Spacer()
                        if card.busy { ProgressView("正在生成新版本").controlSize(.small) }
                        Button("确认卡片") { Task { await model.decide("approve") } }
                            .buttonStyle(.borderedProminent)
                            .disabled(card.busy || model.isSubmitting)
                    }
                }
            }
            .padding(24)
        }
        .onChange(of: card.id) {
            selectedVersion = nil
            model.instruction = ""
        }
    }
}

struct VersionPane: View {
    let title: String
    let version: WorkCardVersion?
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(tint)
                Spacer()
                if let version { Text("v\(version.version)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            if let version {
                Text(version.title).font(.headline)
                Text(version.payload.overview ?? version.payload.summary ?? "暂无摘要").font(.callout)
                itemList("结果", version.payload.outcomes)
                itemList("风险", version.payload.blockers)
                itemList("下一步", version.payload.nextSteps)
                if let instruction = version.instruction {
                    Label(instruction, systemImage: "quote.bubble").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text("这是第一个版本").font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .topLeading)
        .background(tint.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(tint.opacity(0.18)))
    }

    @ViewBuilder private func itemList(_ title: String, _ values: [String]?) -> some View {
        if let values, !values.isEmpty {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(values, id: \.self) { Label($0, systemImage: "circle.fill").font(.caption).labelStyle(BulletLabelStyle()) }
        }
    }
}

struct BulletLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            configuration.icon.font(.system(size: 4)); configuration.title
        }
    }
}

struct SettingsView: View {
    let onDisconnect: () -> Void
    @State private var showsUnbindConfirmation = false
    @State private var isUpdating = false
    @State private var updateMessage: String?
    @State private var updateSucceeded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Button {
                Task { await updatePlugin() }
            } label: {
                if isUpdating {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("正在更新插件")
                    }
                } else {
                    Label("更新插件", systemImage: "arrow.down.circle")
                }
            }
            .buttonStyle(.bordered)
            .disabled(isUpdating)

            if let updateMessage {
                Label(updateMessage, systemImage: updateSucceeded ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(updateSucceeded ? .green : .red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider().frame(maxWidth: 520)

            Button("解除绑定", role: .destructive) {
                showsUnbindConfirmation = true
            }
            .buttonStyle(.plain)
            .foregroundStyle(.red)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
        .sheet(isPresented: $showsUnbindConfirmation) {
            UnbindConfirmationView {
                showsUnbindConfirmation = false
                onDisconnect()
            }
        }
    }

    @MainActor private func updatePlugin() async {
        isUpdating = true
        updateMessage = nil
        updateSucceeded = false
        defer { isUpdating = false }
        do {
            let result = try await PluginUpdater.shared.update()
            updateSucceeded = true
            updateMessage = "插件已更新到 \(result.version)。请新建 Codex 任务使用新版本。"
        } catch {
            updateMessage = error.localizedDescription
        }
    }
}

struct UnbindConfirmationView: View {
    let onCompleted: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var bindingCode = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("解除绑定并清除本地数据", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.red)
            Text("将清除这台 Mac 上的插件凭证、采集记录和本地设置。已上传数据和 Codex 定时任务会保留。")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            SecureField("输入绑定插件时使用的绑定码", text: $bindingCode)
                .textFieldStyle(.roundedBorder)
            if let errorMessage {
                Label(errorMessage, systemImage: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            HStack {
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("解除绑定并清除", role: .destructive) {
                    Task { await submit() }
                }
                .disabled(bindingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
            }
        }
        .padding(24)
        .frame(width: 420)
        .interactiveDismissDisabled(isSubmitting)
    }

    @MainActor private func submit() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            try await WidgetAPIClient().unbind(bindingCode: bindingCode)
            try SharedStore.shared.clearAllLocalData()
            WidgetCenter.shared.reloadAllTimelines()
            onCompleted()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private func reviewLabel(_ status: String) -> String {
    switch status { case "approved": return "已确认"; case "excluded": return "已忽略"; default: return "待确认" }
}
private func reviewColor(_ status: String) -> Color {
    switch status { case "approved": return .green; case "excluded": return .secondary; default: return .orange }
}
private func shortDate(_ value: String) -> String { String(value.prefix(10)) }
