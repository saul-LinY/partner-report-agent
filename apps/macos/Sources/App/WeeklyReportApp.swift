import SwiftUI
import AppKit
import Combine
import ServiceManagement
import WeeklyReportCore

struct WeeklyReportApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var store: AppStore
    @Environment(\.openWindow) private var openWindow
    init() {
        let args = ProcessInfo.processInfo.arguments
        let demo = args.contains("--demo")
        let ephemeral = demo && (args.contains("--preview-reset") || args.contains("--capture"))
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appending(path: demo ? "WeeklyReportPreview" : "WeeklyReportLocal")
        let stateURL = ephemeral ? nil : folder.appending(path: "state.json")
        let executable = Bundle.main.url(forResource: "cc-session-reader", withExtension: nil) ?? URL(fileURLWithPath: "/missing-reader")
        let reader = LocalReader(executable: executable, workingDirectory: folder.appending(path: "ReaderWork"))
        var roots: [String] = []
        for index in args.indices where args[index] == "--authorize-project" && args.indices.contains(index + 1) { roots.append(args[index + 1]) }
        let appStore = AppStore(stateURL: stateURL, live: !demo, reader: reader, authorizedRoots: roots, reviewService: nil, collectorService: demo ? nil : HTTPCollectorService(), serviceURL: demo ? nil : AppConfiguration.serviceURL)
        _store = StateObject(wrappedValue: appStore)
        delegate.prepare(store: appStore)
        if args.contains("--diagnose-startup") { NSLog("weekly report startup: state=%@ bound=%@", String(describing: appStore.startupStage), appStore.binding.isBound ? "yes" : "no") }
    }
    private var mainWindow: some Scene {
        Window("weekly report", id: "main") {
            AppEntryView().environmentObject(store)
                .environmentObject(delegate.notifications)
                .environmentObject(delegate.updates)
                .environmentObject(delegate.background)
                .preferredColorScheme(.light)
                .background(WindowSetup())
                .onAppear {
                    delegate.attach(store: store) { openWindow(id: "main") }
                    delegate.hideBackgroundWindowIfNeeded()
                    delegate.startCaptureIfRequested()
                }
                .onChange(of: store.startupStage) { _, stage in
                    if stage == .ready { delegate.attach(store: store) { openWindow(id: "main") } }
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 860)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("关于 weekly report") { delegate.showAbout() }
            }
            CommandGroup(replacing: .appSettings) {
                Button("系统设置…") { store.page = .settings; delegate.showWindow() }.keyboardShortcut(",").disabled(store.startupStage != .ready || store.collectionProgress != nil)
            }
            CommandMenu("导航") {
                ForEach(Array(AppPage.allCases.enumerated()), id: \.element.id) { index, page in
                    Button(page.title) { store.page = page; delegate.showWindow() }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))))
                        .disabled(store.startupStage != .ready || store.collectionProgress != nil)
                }
            }
        }
    }
    var body: some Scene {
        mainWindow
        MenuBarExtra {
            MenuBarContent(onOpen: { delegate.showWindow() }).environmentObject(store).environmentObject(delegate.background)
        } label: {
            Image(systemName: "calendar.badge.checkmark")
                .onAppear { delegate.attach(store: store) { openWindow(id: "main") } }
        }
    }
}

struct MenuBarContent: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var background: BackgroundService
    var onOpen: () -> Void
    var body: some View {
        Text(store.isLive ? "weekly report · 本机会话" : "weekly report · 本地预览")
        Button("打开主窗口") {
            onOpen()
        }
        if store.startupStage == .ready && store.collectionProgress == nil {
            Button("待审批项\(store.approvalCount > 0 ? " · \(store.approvalCount)" : "")") {
                store.page = .approvals
                onOpen()
            }
            Divider()
            Button(store.preferences.autoUpload ? "暂停自动上传" : "恢复自动上传") {
                store.updatePreferences { $0.autoUpload.toggle() }
            }
            Text(store.preferences.scheduleLabel)
        }
        Divider()
        Button("停止后台运行并退出") { background.stopAndQuit() }
        Button("退出 weekly report") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var store: AppStore?
    let notifications = ApprovalNotifications()
    let updates = AppUpdater()
    let background = BackgroundService()
    let backgroundLaunch = ProcessInfo.processInfo.arguments.contains("--background-service")
    private var mainWindowRequested = false
    private var openMainWindow: (() -> Void)?
    private var monitorTask: Task<Void, Never>?
    private var notificationMonitorTask: Task<Void, Never>?
    private var subscriptions: Set<AnyCancellable> = []
    private var captured = false
    func prepare(store: AppStore) { self.store = store }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if ProcessInfo.processInfo.arguments.contains("--diagnose-startup") { NSLog("weekly report startup: application launched") }
        notifications.install()
        if backgroundLaunch { NSApp.setActivationPolicy(.accessory) }
        else { NSApp.activate(ignoringOtherApps: true) }
        DistributedNotificationCenter.default().addObserver(self, selector: #selector(showRequestedWindow),
            name: .init(BackgroundRuntime.showWindowNotification), object: nil)
        if let store { attach(store: store) }
    }
    @objc private func showRequestedWindow() { showWindow() }
    func hideBackgroundWindowIfNeeded() {
        guard backgroundLaunch, !mainWindowRequested else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.mainWindowRequested else { return }
            NSApp.windows.filter { $0.canBecomeMain && !($0 is NSPanel) }.forEach { $0.orderOut(nil) }
        }
    }
    func attach(store: AppStore, openWindow: (() -> Void)? = nil) {
        if ProcessInfo.processInfo.arguments.contains("--diagnose-startup") { NSLog("weekly report startup: attached state=%@", String(describing: store.startupStage)) }
        self.store = store
        if let openWindow { openMainWindow = openWindow }
        notifications.onOpen = { [weak self] target in
            self?.store?.openApproval(target)
            self?.showWindow()
        }
        notifications.onMessage = { [weak self] type, id in
            Task { @MainActor [weak self] in
                guard let self, let store = self.store else { return }
                await store.refreshReviews()
                store.openAppMessage(type: type, targetID: id)
                self.showWindow()
            }
        }
        notifications.deliverQueuedOpen()
        guard store.isLive else { return }
        if notificationMonitorTask == nil {
            notificationMonitorTask = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refreshMessages()
                    await self?.store?.reportAppHeartbeat()
                    do { try await Task.sleep(for: .seconds(10)) } catch { break }
                }
            }
        }
        guard monitorTask == nil, store.isLive else { return }
        updates.startIfConfigured(enabled: !ProcessInfo.processInfo.arguments.contains("--capture"))
        store.$binding.map(\.isBound).removeDuplicates()
            .sink { [weak self] bound in self?.background.configure(bound: bound) }
            .store(in: &subscriptions)
        Publishers.CombineLatest(store.$projects, store.$reviewBatches)
            .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, let store = self.store else { return }
                    await self.notifications.synchronize(store)
                }
            }.store(in: &subscriptions)
        NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)
            .sink { [weak self] _ in Task { @MainActor [weak self] in await self?.refresh() } }
            .store(in: &subscriptions)
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.background.configure(bound: self?.store?.binding.isBound == true)
                if self?.backgroundLaunch == true { await self?.store?.resumeSavedCollection() }
                await self?.refresh()
                do { try await Task.sleep(for: .seconds(60)) } catch { break }
            }
        }
    }
    private func refresh() async {
        guard let store, store.startupStage == .ready, store.collectionProgress == nil else { return }
        updates.resume()
        await store.synchronizeCollector()
        await store.refreshReviews()
        await refreshMessages()
    }
    private func refreshMessages() async {
        guard let store, store.binding.isBound else { return }
        await store.refreshAppNotifications()
        await notifications.synchronize(store)
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        background.refresh()
        Task { await refreshMessages(); await refresh() }
    }
    func applicationWillTerminate(_ notification: Notification) { monitorTask?.cancel(); notificationMonitorTask?.cancel() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func showWindow() {
        mainWindowRequested = true
        BackgroundPresentation.allowsWindow = true
        NSApp.setActivationPolicy(.regular)
        if let window = NSApp.windows.first(where: { $0.canBecomeMain && !($0 is NSPanel) }) {
            window.alphaValue = 1
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
        } else { openMainWindow?() }
        NSApp.activate(ignoringOtherApps: true)
    }
    func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "weekly report", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.2.1", .credits: NSAttributedString(string: "weekly report · 原生会话采集客户端")])
    }
    /// Deterministic local visual QA; renders our own content view, never captures other apps.
    func startCaptureIfRequested() {
        let args = ProcessInfo.processInfo.arguments
        guard !captured, let index = args.firstIndex(of: "--capture"), args.indices.contains(index + 1) else { return }
        captured = true
        let folder = URL(fileURLWithPath: args[index + 1], isDirectory: true)
        Task { @MainActor in
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if let store, !store.isLive {
                store.previewCollectorOnboarding(permissions: false)
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("onboarding-binding", folder: folder)
                store.previewCollectorOnboarding(permissions: true)
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("onboarding-permissions", folder: folder)
                store.previewStartup()
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("startup-welcome", folder: folder)
                store.previewStartup(DiscoveryProgress(completedSteps: 3, message: "正在识别项目位置", toolsFound: 3, projectsFound: 12))
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("startup-scanning", folder: folder)
                store.previewStartup()
                await store.startInitialScan()
                store.previewCollection(SessionCollectionProgress(total: 32, processed: 14, completed: 14, excluded: 3))
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("collection-loading", folder: folder)
                store.previewCollection(SessionCollectionProgress(total: 32, processed: 32, completed: 30, excluded: 5, failures: [
                    .init(id: "preview-unreadable", title: "Claude Code 会话", message: "文件暂时不可读，请重试。"),
                    .init(id: "preview-partial", title: "Codex 会话", message: "一处来源未能完整加载。")
                ]))
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("collection-failed", folder: folder)
                store.previewCollection()
            }
            for _ in 0..<100 {
                if store?.lastDiscoveredAt != nil || store?.isLive != true { break }
                try? await Task.sleep(for: .milliseconds(200))
            }
            if let index = args.firstIndex(of: "--capture-agent"), args.indices.contains(index + 1),
               let agent = Agent(rawValue: args[index + 1]), let store,
               let session = store.sessions.first(where: { $0.agent == agent }) {
                store.selectProject(session.projectID)
                store.selectedAgent = agent
                store.reconcileSelection()
            }
            await store?.loadSelectedSession()
            for _ in 0..<100 {
                if store?.loadingSessionID == nil { break }
                try? await Task.sleep(for: .milliseconds(200))
            }
            if let store {
                let summary: [String: Any] = ["live": store.isLive, "projects": store.projects.map { ["name": $0.name, "permission": $0.permission.rawValue, "sessions": store.count(for: $0)] }, "allowedSessionCount": store.sessions.count, "selectedTurnCount": store.selectedSession?.turns.count ?? 0, "readerError": store.readerError ?? "", "discoveryIssues": store.discoveryIssues]
                if let bytes = try? JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]) { try? bytes.write(to: folder.appending(path: "runtime-summary.json")) }
            }
            for page in AppPage.allCases {
                store?.page = page
                try? await Task.sleep(for: .milliseconds(650))
                captureContent(page.rawValue, folder: folder)
                if page == .sessions { captureAgentMenuValidation(folder: folder) }
            }
            if let store, !store.isLive {
                store.page = .sessions
                notifications.previewBanner()
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("notification-banner", folder: folder)
                if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
                    window.setContentSize(NSSize(width: 960, height: 720))
                    try? await Task.sleep(for: .milliseconds(500))
                    captureContent("notification-banner-compact", folder: folder)
                    window.setContentSize(NSSize(width: 1280, height: 860))
                }
                notifications.dismissBanner(DemoRepository.notification.id)
                store.openApproval(.card("demo-card-website"))
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("approval-work-cards", folder: folder)
                await store.performCardAction(.approve, cardID: "demo-card-website")
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("approval-work-cards-processed", folder: folder)
                if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
                    window.setContentSize(NSSize(width: 960, height: 720))
                    try? await Task.sleep(for: .milliseconds(500))
                    captureContent("approval-work-cards-compact", folder: folder)
                    window.setContentSize(NSSize(width: 1280, height: 860))
                }
                store.selectedApproval = nil
                store.page = .sessions
                updates.policy.offer(version: "preview") {}
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("sessions-update-available", folder: folder)
                updates.policy.requestInstall()
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("sessions-update-installing", folder: folder)
                updates.policy.clear()
                store.page = .settings
                for tab in SettingsTab.allCases {
                    store.settingsTab = tab
                    try? await Task.sleep(for: .milliseconds(500))
                    captureContent("settings-\(tab.rawValue)", folder: folder)
                }
                store.openApproval(.project("mobile"))
                store.decideProject("mobile", permission: .denied)
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("approvals-empty", folder: folder)
                captureContent("approvals-grouped", folder: folder)
                captureAgentStackValidation(folder: folder)
                store.decideProject("mobile", permission: .pending)
                _ = store.saveBinding(LocalBinding(serviceAddress: "https://company.example", name: "预览用户"))
                store.settingsTab = .account
                store.page = .settings
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("settings-account-bound", folder: folder)
                store.settingsTab = .upload
                store.updatePreferences { $0.frequency = .weekly }
                try? await Task.sleep(for: .milliseconds(500))
                captureContent("settings-upload-weekly", folder: folder)
                store.page = .uploads
                store.selectedUploadRecordID = store.uploadRecords.first?.id
                try? await Task.sleep(for: .milliseconds(700))
                captureContent("upload-details", folder: folder)
                if let sheet = NSApp.windows.first(where: { $0.sheetParent != nil }), let view = sheet.contentView {
                    captureView(view, name: "upload-details-sheet", folder: folder)
                }
                store.selectedUploadRecordID = nil
                try? await Task.sleep(for: .milliseconds(500))
                if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
                    window.setContentSize(NSSize(width: 960, height: 720))
                    for page in AppPage.allCases {
                        if page == .approvals { store.openApproval(.project("mobile")) }
                        store.page = page
                        try? await Task.sleep(for: .milliseconds(500))
                        captureContent("\(page.rawValue)-compact", folder: folder)
                    }
                    window.setContentSize(NSSize(width: 1280, height: 860))
                }
            }
            store?.page = .sessions
            try? Data("complete".utf8).write(to: folder.appending(path: "capture-complete.txt"))
            if args.contains("--capture-exit") { NSApp.terminate(nil) }
        }
    }
    private func captureContent(_ name: String, folder: URL) {
        guard let window = NSApp.windows.first(where: { $0.canBecomeMain }), let view = window.contentView else { return }
        window.displayIfNeeded()
        captureView(view, name: name, folder: folder)
    }
    private func captureAgentStackValidation(folder: URL) {
        let view = NSHostingView(rootView: VStack(spacing: 0) {
            ForEach([1, 4, Agent.allCases.count], id: \.self) { count in
                HStack(spacing: 10) {
                    Text("\(count) 个来源").frame(maxWidth: .infinity, alignment: .leading)
                    AgentStack(agents: Array(Agent.allCases.prefix(count))).frame(width: 118, alignment: .trailing)
                    Text("已登记").frame(width: 86, alignment: .leading)
                }.padding(16).frame(height: 64)
                Rule()
            }
        }.foregroundStyle(Palette.ink).background(.white))
        view.frame = NSRect(x: 0, y: 0, width: 600, height: 195)
        view.layoutSubtreeIfNeeded()
        captureView(view, name: "agent-stack-coverage", folder: folder)
    }
    private func captureAgentMenuValidation(folder: URL) {
        func findMenu(in view: NSView) -> NSPopUpButton? {
            if let button = view as? NSPopUpButton, button.accessibilityIdentifier() == "agent-filter" { return button }
            return view.subviews.lazy.compactMap { findMenu(in: $0) }.first
        }
        guard let view = NSApp.windows.first(where: { $0.canBecomeMain })?.contentView,
              let button = findMenu(in: view) else { return }
        let items = button.itemArray.map { item -> [String: Any] in
            ["title": item.title, "hasImage": item.image != nil,
             "imageWidth": item.image?.size.width ?? 0, "count": item.badge?.itemCount ?? -1]
        }
        if let bytes = try? JSONSerialization.data(withJSONObject: items, options: [.prettyPrinted, .sortedKeys]) {
            try? bytes.write(to: folder.appending(path: "agent-menu-validation.json"))
        }
    }
    private func captureView(_ view: NSView, name: String, folder: URL) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: folder.appending(path: "\(name).png")) }
    }
}

@MainActor
private enum BackgroundPresentation {
    static var allowsWindow = !ProcessInfo.processInfo.arguments.contains("--background-service")
}

private final class AppWindowView: NSView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if !BackgroundPresentation.allowsWindow { window?.alphaValue = 0 }
    }
}

struct WindowSetup: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = AppWindowView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.title = "weekly report"
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = false
            window.minSize = NSSize(width: 960, height: 720)
            window.setContentSize(NSSize(width: 1280, height: 860))
            window.center()
        }
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
