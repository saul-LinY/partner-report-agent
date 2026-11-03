import SwiftUI
import WeeklyReportCore

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var notifications: ApprovalNotifications
    @EnvironmentObject private var background: BackgroundService
    @State private var binding = LocalBinding()
    @State private var showBindingResult = false
    @State private var bindingCode = ""
    @State private var expanded: Set<Agent> = []
    @State private var directoryError: String?
    var body: some View {
        VStack(spacing: 0) {
            PageHeading(title: "系统设置") { EmptyView() }
            HStack(spacing: 18) {
                ForEach(SettingsTab.allCases) { tab in
                    FilterTab(title: tab.title, selected: store.settingsTab == tab) { store.settingsTab = tab }.accessibilityIdentifier("settings-tab-\(tab.rawValue)")
                }
                Spacer()
            }.padding(.horizontal, 28).padding(.bottom, 4)
            Rule().padding(.horizontal, 28)
            ScrollView {
                VStack(spacing: 0) {
                    switch store.settingsTab {
                    case .account: account
                    case .sources: sources
                    case .upload: upload
                    }
                }.padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 24)
            }
        }
        .onAppear { binding = store.binding }
        .alert("账户绑定", isPresented: $showBindingResult) {
            Button("关闭", role: .cancel) {}
        } message: { Text(store.connectionError ?? store.storageError ?? "绑定成功。") }
        .alert("无法选择聊天记录位置", isPresented: Binding(get: { directoryError != nil }, set: { if !$0 { directoryError = nil } })) {
            Button("关闭", role: .cancel) {}
        } message: { Text(directoryError ?? "") }
    }
    private var account: some View {
        Group {
            settingRow("当前成员") { Text(store.binding.name.isEmpty ? "未绑定" : store.binding.name).foregroundStyle(Palette.secondary) }
            settingRow("连接状态") { StatusLabel(text: store.binding.isBound ? "已绑定" : "未绑定", color: store.binding.isBound ? Palette.green : Palette.secondary) }
            settingRow("后台运行") {
                HStack(spacing: 12) {
                    Toggle("后台运行", isOn: Binding(get: { background.isEnabled }, set: { enabled in
                        if enabled { background.enable() } else { background.disable() }
                    })).labelsHidden().toggleStyle(.switch).tint(Palette.yellow)
                        .disabled(!store.binding.isBound || background.isChanging).accessibilityIdentifier("background-service-toggle")
                    Text(background.label).foregroundStyle(Palette.secondary).accessibilityIdentifier("background-service-status")
                    Button("系统后台设置") { background.openSettings() }
                }
            }
            if let error = background.error { Text(error).font(.system(size: 12)).foregroundStyle(Palette.red) }
            settingRow("系统通知") {
                HStack(spacing: 12) {
                    Text(notifications.authorization == .allowed ? (notifications.alertsEnabled ? "已允许" : "已允许，横幅未开启") : notifications.authorization == .denied ? "未允许" : "未设置").foregroundStyle(Palette.secondary)
                    Button {
                        if notifications.authorization == .unknown { Task { await notifications.requestPermission(store) } }
                        else { notifications.openSettings() }
                    } label: { Label(notifications.authorization == .unknown ? "开启通知" : "通知设置", systemImage: "bell") }
                    Button { Task { await notifications.testSystemBanner(store) } } label: {
                        Label("测试系统横幅", systemImage: "bell.badge")
                    }.disabled(notifications.isTesting).accessibilityIdentifier("test-system-banner")
                }
            }
            if let error = notifications.error ?? store.notificationError { Text(error).font(.system(size: 12)).foregroundStyle(.red) }
            if let result = notifications.testResult { Text(result).font(.system(size: 12)).foregroundStyle(Palette.secondary).accessibilityIdentifier("system-banner-test-result") }
            settingRow("名字") {
                TextField("名字", text: $binding.name).modifier(FieldStyle()).frame(maxWidth: 360).accessibilityIdentifier("binding-name")
            }
            settingRow("绑定码") {
                SecureField("绑定码", text: $bindingCode).modifier(FieldStyle()).frame(maxWidth: 360).accessibilityIdentifier("binding-code")
            }
            if let error = store.connectionError ?? store.logUploadError { Text(error).font(.system(size: 12)).foregroundStyle(.red).padding(.top, 12) }
            HStack {
                Spacer()
                Button {
                    Task {
                        if store.hasCollectorService { await store.bindCollector(binding, code: bindingCode); bindingCode = "" }
                        else { _ = store.saveBinding(binding) }
                        showBindingResult = true
                    }
                } label: {
                    Label(store.isConnecting ? "正在绑定" : "绑定", systemImage: "link").frame(width: 208)
                }.buttonStyle(YellowButtonStyle()).disabled(!binding.isValid || store.isConnecting || (store.hasCollectorService && bindingCode.count < 8))
                    .accessibilityIdentifier("bind-account")
                Spacer()
            }.frame(height: 92)
        }
    }
    private var bindingSaved: Bool { store.binding.matchesSavedConfiguration(binding) }
    private var upload: some View {
        Group {
            settingRow("自动上传") {
                Toggle("自动上传", isOn: store.preferenceBinding(\.autoUpload)).labelsHidden().toggleStyle(.switch).tint(Palette.yellow).accessibilityIdentifier("auto-upload")
            }
            settingRow("上传频率") {
                HStack(spacing: 0) {
                    ForEach(UploadFrequency.allCases, id: \.self) { frequency in
                        Button { store.updatePreferences { $0.frequency = frequency } } label: {
                            Text(frequency == .daily ? "每天" : "每周").frame(width: 116, height: 30)
                                .background(store.preferences.frequency == frequency ? .white : .clear, in: RoundedRectangle(cornerRadius: 4))
                        }.buttonStyle(.plain).accessibilityAddTraits(store.preferences.frequency == frequency ? .isSelected : [])
                    }
                }.padding(3).background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6)).overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
                    .disabled(!store.preferences.autoUpload).accessibilityIdentifier("upload-frequency")
            }
            settingRow("上传时间") {
                HStack(spacing: 10) {
                    if store.preferences.frequency == .weekly {
                        Menu {
                            ForEach([2, 3, 4, 5, 6, 7, 1], id: \.self) { day in
                                Button(weekdayLabel(day)) { weekday.wrappedValue = day }
                            }
                        } label: { Text(weekdayLabel(weekday.wrappedValue)).font(.system(size: 13)) }
                            .menuStyle(.borderlessButton).menuIndicator(.visible)
                            .modifier(ScheduleFieldStyle()).accessibilityLabel("上传星期").accessibilityIdentifier("upload-weekday")
                    }
                    HStack(spacing: 10) {
                        Image(systemName: "clock").foregroundStyle(Palette.secondary)
                        TimePickerField(selection: uploadTime).frame(width: 56, height: 22).accessibilityIdentifier("upload-time")
                    }.modifier(ScheduleFieldStyle())
                }.disabled(!store.preferences.autoUpload)
            }
        }
    }
    private var sources: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(Agent.allCases.count) 个工具").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                Spacer()
            }.padding(.bottom, 16)
            HStack(spacing: 12) {
                Text("工具").frame(width: 145, alignment: .leading)
                Text("聊天记录位置").frame(maxWidth: .infinity, alignment: .leading)
                Text("状态").frame(width: 88, alignment: .leading)
                Text("操作").frame(width: 40)
            }.font(.system(size: 12)).foregroundStyle(Palette.secondary).padding(.horizontal, 10).frame(height: 38).background(Palette.quiet)
            ForEach(Agent.allCases) { agent in sourceRow(agent) }
            if !store.discoveryIssues.isEmpty {
                DisclosureGroup("定位提示") {
                    ForEach(store.discoveryIssues, id: \.self) { Text($0).font(.system(size: 11)).foregroundStyle(Palette.secondary).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
                }.font(.system(size: 12)).padding(.top, 16)
            }
        }
    }
    private func sourceRow(_ agent: Agent) -> some View {
        let paths = store.detectedPaths(for: agent)
        let path = paths.first ?? store.preferences.agentPaths[agent.id] ?? agent.defaultPath
        let discovered = !store.isLive || !paths.isEmpty
        return VStack(spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 10) { AgentIcon(agent: agent, size: 22); Text(agent.name).lineLimit(1) }.frame(width: 145, alignment: .leading)
                HStack(spacing: 8) {
                    Text(displayPath(path)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle).help(path).textSelection(.enabled)
                    if paths.count > 1 {
                        Button { if expanded.contains(agent) { expanded.remove(agent) } else { expanded.insert(agent) } } label: { Image(systemName: expanded.contains(agent) ? "chevron.up" : "chevron.down").font(.system(size: 10)) }
                            .buttonStyle(.plain).help("展开聊天记录位置").accessibilityLabel("展开 \(agent.name) 聊天记录位置")
                    }
                    Spacer(minLength: 0)
                }.frame(maxWidth: .infinity, alignment: .leading)
                StatusLabel(text: store.isDiscovering ? "检查中" : discovered ? (store.isLive ? "已发现" : "示例") : "未发现", color: discovered ? Palette.green : Palette.secondary).frame(width: 88, alignment: .leading)
                IconButton(symbol: "folder", help: "选择 \(agent.name) 聊天记录位置") { chooseSource(agent, current: path) }.frame(width: 40).accessibilityIdentifier("choose-source-\(agent.id)")
            }.font(.system(size: 13)).padding(.horizontal, 10).frame(height: 62)
            if expanded.contains(agent) {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(paths, id: \.self) { path in Text(displayPath(path)).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                }.foregroundStyle(Palette.secondary).padding(.leading, 167).padding(.vertical, 12).background(Palette.quiet.opacity(0.5))
            }
            Rule()
        }
    }
    private func chooseSource(_ agent: Agent, current: String) {
        guard let path = chooseDirectory(title: "选择 \(agent.name) 聊天记录位置", current: current) else { return }
        guard !SessionSourcePolicy.isArchived(path) else { directoryError = "已归档的聊天记录不参与采集，请选择未归档的记录位置。"; return }
        store.updatePreferences { $0.agentPaths[agent.id] = path }
    }
    private func settingRow<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 24) { Text(title).font(.system(size: 14, weight: .medium)).fixedSize(); Spacer(minLength: 16); content().font(.system(size: 13)) }
                .padding(.horizontal, 10).frame(height: 76)
            Rule()
        }
    }
    private var weekday: Binding<Int> { Binding(get: { store.preferences.uploadWeekday ?? 6 }, set: { day in store.updatePreferences { $0.uploadWeekday = day } }) }
    private var uploadTime: Binding<Date> {
        Binding(get: { Calendar.current.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: store.preferences.uploadHour, minute: store.preferences.uploadMinute)) ?? .now }, set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            store.updatePreferences { $0.uploadHour = parts.hour ?? 16; $0.uploadMinute = parts.minute ?? 0 }
        })
    }
    private func weekdayLabel(_ day: Int) -> String { [1: "周日", 2: "周一", 3: "周二", 4: "周三", 5: "周四", 6: "周五", 7: "周六"][day] ?? "周五" }
}
