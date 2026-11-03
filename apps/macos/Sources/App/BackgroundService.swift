import AppKit
import Combine
import CryptoKit
import ServiceManagement
import WeeklyReportCore

@MainActor
final class BackgroundService: ObservableObject {
    @Published private(set) var status: SMAppService.Status = .notRegistered
    @Published private(set) var error: String?
    @Published private(set) var isChanging = false
    private let service = SMAppService.agent(plistName: BackgroundRuntime.plistName)
    private var lastAutomaticRegistrationAt: Date?
    private let defaults = UserDefaults.standard
    var isEnabled: Bool { status == .enabled || status == .requiresApproval }
    var label: String {
        if error != nil { return "启动失败" }
        switch status {
        case .enabled: return "已开启"
        case .requiresApproval: return "需要系统允许"
        case .notFound: return "后台服务缺失"
        default: return "未开启"
        }
    }

    func configure(bound: Bool) {
        guard !ProcessInfo.processInfo.arguments.contains("--demo"),
              !ProcessInfo.processInfo.arguments.contains("--capture") else { return }
        refresh()
        guard bound else { return }
        migrateLegacyLoginItem()
        guard lastAutomaticRegistrationAt.map({ Date.now.timeIntervalSince($0) >= 60 }) ?? true else { return }
        lastAutomaticRegistrationAt = .now
        guard !FileManager.default.fileExists(atPath: BackgroundRuntime.disabledFile.path) else { return }
        let changed = fingerprint != defaults.string(forKey: "backgroundServiceFingerprint")
        if !defaults.bool(forKey: "backgroundServiceRegistered") || (changed && status != .requiresApproval) { enable() }
    }

    func refresh() {
        status = service.status
    }

    private func migrateLegacyLoginItem() {
        if status == .enabled, SMAppService.mainApp.status == .enabled { try? SMAppService.mainApp.unregister() }
    }

    private lazy var fingerprint: String? = {
        let files = ["Contents/Helpers/weekly-report-background", "Contents/Frameworks/WeeklyReportCore.framework/WeeklyReportCore",
                     "Contents/Library/LaunchAgents/" + BackgroundRuntime.plistName]
        var digest = SHA256()
        for path in files {
            guard let data = try? Data(contentsOf: Bundle.main.bundleURL.appending(path: path)) else { return nil }
            digest.update(data: data)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }()

    func enable() {
        guard !isChanging else { return }
        isChanging = true
        Task {
            defer { isChanging = false }
            do {
                guard let fingerprint else { error = "后台服务文件不完整，请重新安装 App。"; return }
                if service.status == .enabled, fingerprint != defaults.string(forKey: "backgroundServiceFingerprint") {
                    // Await removal before re-registering a changed helper after an app update.
                    try await service.unregister()
                }
                if service.status == .notRegistered || service.status == .notFound { try service.register() }
                refresh()
                guard isEnabled else { error = "请在 macOS 登录项与扩展中允许 weekly report 后台运行。"; return }
                try BackgroundRuntime.setDisabled(false)
                defaults.set(true, forKey: "backgroundServiceRegistered")
                defaults.set(fingerprint, forKey: "backgroundServiceFingerprint")
                migrateLegacyLoginItem()
                error = nil
            } catch {
                refresh()
                self.error = "无法启用后台运行，请打开系统后台设置检查后重试。"
            }
        }
    }

    @discardableResult func disable() -> Bool {
        guard !isChanging else { return false }
        do {
            try BackgroundRuntime.setDisabled(true)
            if service.status != .notRegistered && service.status != .notFound { try service.unregister() }
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            error = nil
            refresh()
            return true
        } catch {
            self.error = "后台运行未能完全关闭，请在系统后台设置中关闭。"
            refresh()
            return false
        }
    }

    func openSettings() { SMAppService.openSystemSettingsLoginItems() }
    func stopAndQuit() { if disable() { NSApp.terminate(nil) } }
}
