import SwiftUI
import WeeklyReportCore

struct AppEntryView: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        Group {
            if let progress = store.collectionProgress { SessionCollectionView(progress: progress) }
            else if store.startupStage == .ready { RootView() }
            else if store.startupStage == .binding { CollectorBindingView() }
            else if store.startupStage == .permissions { CollectorPermissionsView() }
            else { OnboardingView() }
        }.frame(minWidth: 960, minHeight: 680)
    }
}

struct CollectorBindingView: View {
    @EnvironmentObject private var store: AppStore
    @State private var binding = LocalBinding()
    @State private var code = ""
    var body: some View {
        VStack(spacing: 20) {
            Image("WeeklyReportMark").resizable().scaledToFit().frame(width: 60, height: 66).accessibilityHidden(true)
            Text("绑定 weekly report").font(.system(size: 26, weight: .bold))
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("名字").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    TextField("名字", text: $binding.name).modifier(FieldStyle()).accessibilityIdentifier("onboarding-name")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("绑定码").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    SecureField("绑定码", text: $code).modifier(FieldStyle()).accessibilityIdentifier("onboarding-binding-code")
                }
                if let error = store.connectionError { Text(error).font(.system(size: 12)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true) }
                Button {
                    Task { await store.bindCollector(binding, code: code); if store.binding.isBound { code = "" } }
                } label: {
                    Label(store.isConnecting ? "正在绑定" : "绑定并继续", systemImage: "link").frame(maxWidth: .infinity)
                }.buttonStyle(YellowButtonStyle()).disabled(!binding.isValid || code.trimmingCharacters(in: .whitespacesAndNewlines).count < 8 || store.isConnecting)
                    .accessibilityIdentifier("onboarding-bind")
            }.frame(width: 400)
        }.padding(40).frame(maxWidth: .infinity, maxHeight: .infinity).background(.white)
            .onAppear { binding = store.binding }
    }
}

struct CollectorPermissionsView: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("项目采集权限").font(.system(size: 24, weight: .bold))
                Spacer()
                Text(store.binding.name).foregroundStyle(Palette.secondary)
                Button { Task { await store.prepareCollectorPermissions() } } label: {
                    if store.isPreparingProjects { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.clockwise") }
                }.frame(width: 32, height: 28).help("重新发现本机项目并刷新权限")
                    .disabled(store.isConnecting || store.isPreparingProjects)
                    .accessibilityLabel("刷新本机项目与权限").accessibilityIdentifier("refresh-project-permissions")
            }
            if store.isPreparingProjects {
                Text("正在发现本机项目…").font(.system(size: 13)).foregroundStyle(Palette.secondary).accessibilityIdentifier("project-discovery-status")
            } else if let date = store.lastProjectPreparationAt {
                HStack {
                    Text("\(store.projects.filter { !$0.folder.isEmpty }.count) 个本机项目")
                    Spacer()
                    Text("更新于 \(date.formatted(date: .omitted, time: .standard))")
                }.font(.system(size: 12)).foregroundStyle(Palette.secondary).accessibilityIdentifier("project-discovery-status")
            }
            if let error = store.connectionError { Text(error).font(.system(size: 13)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true) }
            if !store.discoveryIssues.isEmpty {
                Text(store.discoveryIssues.joined(separator: "\n")).font(.system(size: 12)).foregroundStyle(Palette.secondary).lineLimit(3)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if store.projects.isEmpty && !store.isPreparingProjects { ContentUnavailableView("未发现本机项目", systemImage: "folder") }
                    ForEach([ProjectPermission.allowed, .denied, .pending], id: \.rawValue) { permission in
                        let projects = store.projects.filter { $0.permission == permission }
                        if !projects.isEmpty {
                            Text(permission.label).font(.system(size: 14, weight: .semibold))
                            ForEach(projects) { project in
                                HStack(spacing: 16) {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(project.name).font(.system(size: 14, weight: .medium))
                                        Text(project.folder.isEmpty ? "本机未发现，暂不扫描" : project.folder).font(.system(size: 12)).foregroundStyle(Palette.secondary).lineLimit(2)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    Toggle("允许采集 \(project.name)", isOn: Binding(get: { project.permission == .allowed }, set: { value in
                                        Task { await store.synchronizePermission(project.id, permission: value ? .allowed : .denied) }
                                    })).labelsHidden().toggleStyle(.switch).tint(Palette.green).disabled(store.isConnecting || store.isPreparingProjects)
                                }.padding(.vertical, 10)
                                Rule()
                            }
                        }
                    }
                }
            }
            HStack {
                Spacer()
                Button { store.confirmCollectorPermissions() } label: { Label("继续", systemImage: "arrow.right") }.buttonStyle(YellowButtonStyle())
                    .disabled(store.isLive && !store.canConfirmCollectorPermissions)
                    .accessibilityIdentifier("confirm-project-permissions")
            }
        }.padding(40).frame(maxWidth: 860).frame(maxWidth: .infinity, maxHeight: .infinity).background(.white)
            .task { await store.prepareCollectorPermissions() }
    }
}

struct SessionCollectionView: View {
    @EnvironmentObject private var store: AppStore
    var progress: SessionCollectionProgress
    private var failed: Bool { !store.isLoadingSessionContents && !progress.failures.isEmpty }
    var body: some View {
        VStack(spacing: 0) {
            Image("WeeklyReportMark").resizable().scaledToFit().frame(width: 60, height: 66)
            Text("weekly report").font(.system(size: 26, weight: .bold)).padding(.top, 20)
            Text(failed ? "有 \(progress.failures.count) 个会话未能加载" : progress.message)
                .font(.system(size: 15)).foregroundStyle(Palette.secondary).padding(.top, 16)
            VStack(spacing: 16) {
                HStack {
                    Text(progress.total == 0 ? "正在识别会话" : "已处理 \(progress.processed) / \(progress.total) 个会话")
                    Spacer()
                    Text("\(Int(progress.fraction * 100))%").monospacedDigit()
                }.font(.system(size: 13))
                ProgressView(value: progress.total == 0 ? nil : progress.fraction).progressViewStyle(.linear).tint(Palette.yellow)
                    .accessibilityLabel("会话内容加载进度")
                Text(store.hasCollectorService ? "已导入 \(progress.completed) 个会话" : "已过滤 \(progress.excluded) 个无模型回复的会话")
                    .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                if failed {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(progress.failures) { failure in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(failure.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                    Text(failure.message).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }.frame(maxHeight: 130)
                    HStack(spacing: 12) {
                        Button { store.cancelCollection() } label: { Text("返回").frame(maxWidth: .infinity) }
                            .buttonStyle(QuietButtonStyle()).accessibilityIdentifier("collection-back")
                        Button { Task { await store.retryCollection() } } label: {
                            Label("重试未完成的会话", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
                        }.buttonStyle(YellowButtonStyle()).accessibilityIdentifier("collection-retry")
                    }
                } else {
                    Text("全部加载完成后将自动进入").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                }
            }.frame(width: 420).padding(.top, 36)
        }.padding(.vertical, 40).frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(Palette.ink).background(.white)
            .accessibilityIdentifier("session-collection-screen")
    }
}

struct OnboardingView: View {
    @EnvironmentObject private var store: AppStore
    private var scanning: Bool { store.startupStage == .scanning }
    var body: some View {
        VStack(spacing: 0) {
            Image("WeeklyReportMark").resizable().scaledToFit().frame(width: 60, height: 66)
                .accessibilityHidden(true)
            Text("weekly report").font(.system(size: 26, weight: .bold)).padding(.top, 20)
            Text(scanning ? "正在扫描最近一个月的会话" : "导入最近一个月的 AI 会话，整理每周工作进展。")
                .font(.system(size: 15)).foregroundStyle(Palette.secondary).padding(.top, 16)
            Group {
                if scanning {
                    VStack(spacing: 15) {
                        HStack {
                            Text(store.startupProgress.message)
                            Spacer()
                            Text("\(Int(store.startupProgress.fraction * 100))%")
                                .monospacedDigit().frame(width: 42, alignment: .trailing)
                        }.font(.system(size: 13))
                        ProgressView(value: store.startupProgress.fraction)
                            .progressViewStyle(.linear).tint(Palette.yellow)
                            .accessibilityLabel("扫描进度")
                            .accessibilityIdentifier("initial-scan-progress")
                        Text("已发现 \(store.startupProgress.toolsFound) 个工具 · \(store.startupProgress.projectsFound) 个项目")
                            .font(.system(size: 13)).foregroundStyle(Palette.secondary)
                        Text("扫描完成后将自动进入").font(.system(size: 12))
                            .foregroundStyle(Palette.secondary).padding(.top, 10)
                    }.frame(width: 360).accessibilityIdentifier("startup-scanning")
                } else {
                    VStack(spacing: 16) {
                        Button { Task { await store.startInitialScan() } } label: {
                            Label("开始扫描会话", systemImage: "magnifyingglass")
                                .frame(width: 278, height: 26)
                        }.buttonStyle(YellowButtonStyle()).accessibilityIdentifier("start-initial-scan")
                        if store.hasCollectorService {
                            Button { store.revisitCollectorPermissions() } label: { Label("项目权限", systemImage: "arrow.left") }.buttonStyle(.plain)
                            if let error = store.connectionError { Text(error).font(.system(size: 12)).foregroundStyle(Palette.red).fixedSize(horizontal: false, vertical: true).frame(width: 400) }
                        }
                    }
                }
            }.frame(height: 155, alignment: .top).padding(.top, 36)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(Palette.ink).background(.white)
            .accessibilityIdentifier("startup-screen")
    }
}
