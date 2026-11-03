import AppKit
import Combine
import UserNotifications
import WeeklyReportCore

@MainActor
final class ApprovalNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    enum Authorization { case unknown, allowed, denied }
    @Published private(set) var authorization: Authorization = .unknown
    @Published private(set) var alertsEnabled = false
    @Published private(set) var error: String?
    @Published private(set) var banners: [AppMessage] = []
    @Published private(set) var isTesting = false
    @Published private(set) var testResult: String?
    func dismissBanner(_ id: String) { banners.removeAll { $0.id == id } }
    func previewBanner() {
        guard ProcessInfo.processInfo.arguments.contains("--demo") else { return }
        banners = [DemoRepository.notification]
    }
    func openBanner(_ message: AppMessage) {
        dismissBanner(message.id)
        onMessage?(message.targetType, message.targetId)
    }
    var onOpen: ((ApprovalTarget?) -> Void)?
    var onMessage: ((String, String?) -> Void)?
    private let center = UNUserNotificationCenter.current()
    private var synchronizing = false
    private var synchronizeAgain = false
    private var queuedTarget: ApprovalTarget?
    private var hasQueuedOpen = false
    private var queuedMessage: (String, String?)?

    func install() { center.delegate = self }
    func deliverQueuedOpen() {
        if let queuedMessage, let onMessage { onMessage(queuedMessage.0, queuedMessage.1); self.queuedMessage = nil }
        guard hasQueuedOpen, let onOpen else { return }
        onOpen(queuedTarget)
        hasQueuedOpen = false
        queuedTarget = nil
    }
    func openSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
    }
    func requestPermission(_ store: AppStore) async {
        guard store.isLive, !ProcessInfo.processInfo.arguments.contains("--capture") else { return }
        do {
            authorization = try await center.requestAuthorization(options: [.alert, .sound, .badge]) ? .allowed : .denied
            error = nil
            await synchronize(store)
        } catch { self.error = "无法开启系统通知" }
    }
    func testSystemBanner(_ store: AppStore) async {
        guard store.isLive, !isTesting else { return }
        isTesting = true
        testResult = nil
        defer { isTesting = false }
        await requestPermission(store)
        guard authorization == .allowed, alertsEnabled else {
            error = "请在 macOS 通知设置中允许 weekly report 通知，并将提示样式设为横幅或提醒。"
            return
        }
        let content = UNMutableNotificationContent()
        content.title = "weekly report · 系统横幅测试"
        content.body = "这是 macOS 原生通知。工作卡片待审核时也会在这里提醒你。"
        content.sound = .default
        content.threadIdentifier = "weekly-report-test"
        content.userInfo = ["messageType": "review", "targetID": ""]
        let requestID = "weekly-report-banner-test:" + UUID().uuidString
        do {
            try await center.add(UNNotificationRequest(identifier: requestID, content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3, repeats: false)))
            error = nil
            testResult = "测试通知将在 3 秒后出现在 macOS 通知中心。"
            for _ in 0..<8 {
                try await Task.sleep(for: .seconds(1))
                if await center.deliveredNotifications().contains(where: { $0.request.identifier == requestID }) {
                    testResult = "测试通知已投递到 macOS 通知中心。未看到横幅时，请检查通知样式与专注模式。"
                    break
                }
            }
        } catch { self.error = "系统横幅测试未能发送，请重试。" }
    }
    func synchronize(_ store: AppStore) async {
        guard store.isLive, !ProcessInfo.processInfo.arguments.contains("--capture") else { return }
        guard !synchronizing else { synchronizeAgain = true; return }
        synchronizing = true
        defer { synchronizing = false }
        repeat {
            synchronizeAgain = false
            await synchronizeOnce(store)
        } while synchronizeAgain
    }
    private func synchronizeOnce(_ store: AppStore) async {
        NSApp.dockTile.badgeLabel = store.approvalCount == 0 ? nil : "\(store.approvalCount)"
        let settings = await center.notificationSettings()
        alertsEnabled = settings.alertSetting == .enabled && settings.alertStyle != .none
        switch settings.authorizationStatus {
        case .authorized, .provisional: authorization = .allowed
        case .denied: authorization = .denied
        default: authorization = .unknown
        }
        await store.reportNotificationPermission(authorization == .allowed ? .allowed : authorization == .denied ? .denied : .notConfigured)
        if authorization == .unknown, !store.approvalTargets.isEmpty || !store.appMessages.isEmpty {
            do { authorization = try await center.requestAuthorization(options: [.alert, .sound, .badge]) ? .allowed : .denied }
            catch { self.error = "无法开启系统通知"; return }
        }
        await store.reportNotificationPermission(authorization == .allowed ? .allowed : authorization == .denied ? .denied : .notConfigured)
        if authorization == .denied {
            error = "macOS 未允许 weekly report 发送通知，请在系统通知设置中开启。"
        } else if authorization == .allowed {
            error = alertsEnabled ? nil : "macOS 已允许通知，但提示样式未开启。请在通知设置中选择横幅或提醒。"
        }
        let targets = store.hasCollectorService ? store.pendingProjects.filter { $0.scopeKey == nil }.map { ApprovalTarget.project($0.id) } : store.approvalTargets
        let groups = ApprovalReminderGroup.groups(targets: targets, notified: store.notifiedApprovalKeys)
        for group in groups where group.keys.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: [group.identifier])
            center.removePendingNotificationRequests(withIdentifiers: [group.identifier])
        }
        guard authorization == .allowed else { return }
        for message in store.appMessages {
            let content = UNMutableNotificationContent()
            content.title = message.title
            content.body = message.body
            content.sound = .default
            content.threadIdentifier = "weekly-report-messages"
            content.userInfo = ["messageType": message.targetType, "targetID": message.targetId ?? ""]
            do {
                try await center.add(UNNotificationRequest(identifier: "app-message:" + message.id, content: content, trigger: nil))
                store.markAppMessageDelivered(message)
                error = nil
            } catch { self.error = "系统通知未能投递，将自动重试。" }
        }
        await store.refreshAppNotifications()
        for group in groups {
            guard let key = group.freshKeys.sorted().first else { continue }
            let content = UNMutableNotificationContent()
            content.title = group.isProject ? "项目待审批" : "卡片待审核"
            content.body = group.isProject ? "\(group.keys.count) 个项目等待审批" : "\(group.keys.count) 张卡片等待审核"
            content.sound = .default
            content.threadIdentifier = "weekly-report-approvals"
            content.userInfo = ["approvalTarget": key]
            do {
                try await center.add(UNNotificationRequest(identifier: group.identifier, content: content, trigger: nil))
                store.markApprovalsNotified(group.freshKeys)
                error = nil
                // An item may be handled while the system accepts the notification.
                if Set(store.approvalTargets.map(\.key)) != Set(targets.map(\.key)) { synchronizeAgain = true }
            } catch { self.error = "通知发送失败" }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let key = response.notification.request.content.userInfo["approvalTarget"] as? String
        let messageType = response.notification.request.content.userInfo["messageType"] as? String
        let targetID = response.notification.request.content.userInfo["targetID"] as? String
        let isDefault = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        if isDefault {
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let messageType {
                    if let onMessage { onMessage(messageType, targetID) }
                    else { queuedMessage = (messageType, targetID) }
                    return
                }
                let target = key.flatMap(ApprovalTarget.init(key:))
                if let onOpen { onOpen(target) }
                else { queuedTarget = target; hasQueuedOpen = true }
            }
        }
        completionHandler()
    }
}
