import AppKit
import Combine
import Sparkle
import WeeklyReportCore

@MainActor
final class AppUpdater: ObservableObject {
    let policy: UpdatePolicy
    var available: PendingAppUpdate? { policy.available }
    var isInstalling: Bool { policy.isInstalling }
    private var updater: SPUUpdater?
    private var driver: UpdateUserDriver?
    private var observation: AnyCancellable?
    private var deadlineTask: Task<Void, Never>?
    private var requestedByUser = false

    init() {
        let args = ProcessInfo.processInfo.arguments
        let ephemeral = args.contains("--demo") || args.contains("--capture")
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appending(path: "WeeklyReportLocal")
        policy = UpdatePolicy(stateURL: ephemeral ? nil : folder.appending(path: "app-update.json"),
                              installedVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1")
        observation = policy.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
    }

    func startIfConfigured(enabled: Bool) {
        guard enabled, updater == nil,
              let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let url = URL(string: feed), url.scheme == "https", url.host?.isEmpty == false,
              let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: key)?.count == 32 else { return }
        let driver = UpdateUserDriver(policy: policy)
        driver.onOffer = { [weak self] in self?.scheduleInstallation() }
        driver.onEnd = { [weak self] in
            self?.deadlineTask?.cancel()
            self?.requestedByUser = false
        }
        let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: driver, delegate: nil)
        self.driver = driver
        self.updater = updater
        updater.automaticallyChecksForUpdates = true
        // The app's persisted 24-hour policy controls when installation begins.
        updater.automaticallyDownloadsUpdates = false
        updater.sendsSystemProfile = false
        do {
            try updater.start()
            updater.checkForUpdatesInBackground()
        } catch {
            self.updater = nil
            self.driver = nil
            NSLog("weekly report: update setup failed: %@", error.localizedDescription)
        }
    }

    func installNow() {
        guard !policy.isInstalling else { return }
        if !policy.requestInstall(), let updater, updater.canCheckForUpdates {
            requestedByUser = true
            updater.checkForUpdatesInBackground()
        }
    }

    func resume() {
        policy.installIfDue()
        if let updater, updater.canCheckForUpdates,
           updater.lastUpdateCheckDate.map({ Date().timeIntervalSince($0) >= 3_600 }) ?? true {
            updater.checkForUpdatesInBackground()
        }
    }

    private func scheduleInstallation() {
        deadlineTask?.cancel()
        if requestedByUser { requestedByUser = false; policy.requestInstall() }
        guard !policy.isInstalling, let notice = policy.available else { return }
        deadlineTask = Task { [weak self] in
            let delay = max(0, notice.automaticInstallAt.timeIntervalSinceNow)
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            self?.policy.installIfDue()
        }
    }
}

/// Keep Sparkle's download/error UI and verified installer; replace its update offer with New.
@MainActor
private final class UpdateUserDriver: NSObject, SPUUserDriver {
    let policy: UpdatePolicy
    private let standard = SPUStandardUserDriver(hostBundle: .main, delegate: nil)
    var onOffer: (() -> Void)?
    var onEnd: (() -> Void)?
    init(policy: UpdatePolicy) { self.policy = policy }

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        standard.showUserInitiatedUpdateCheck(cancellation: cancellation)
    }
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        guard !appcastItem.isInformationOnlyUpdate else { policy.clear(); reply(.dismiss); return }
        policy.offer(version: appcastItem.versionString) { reply(.install) }
        onOffer?()
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        policy.clear()
        acknowledgement()
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        policy.finishAttempt()
        standard.showUpdaterError(error, acknowledgement: acknowledgement)
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        standard.showDownloadInitiated(cancellation: cancellation)
    }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        standard.showDownloadDidReceiveExpectedContentLength(expectedContentLength)
    }
    func showDownloadDidReceiveData(ofLength length: UInt64) { standard.showDownloadDidReceiveData(ofLength: length) }
    func showDownloadDidStartExtractingUpdate() { standard.showDownloadDidStartExtractingUpdate() }
    func showExtractionReceivedProgress(_ progress: Double) { standard.showExtractionReceivedProgress(progress) }
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        // Give the verified installer time to replace the bundle before the supervisor restarts it.
        do { try BackgroundRuntime.pauseForUpdate(until: .now.addingTimeInterval(600)); reply(.install) }
        catch { policy.finishAttempt(); reply(.dismiss) }
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        standard.showInstallingUpdate(withApplicationTerminated: applicationTerminated, retryTerminatingApplication: retryTerminatingApplication)
    }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        BackgroundRuntime.clearUpdatePause()
        policy.clear()
        acknowledgement()
    }
    func dismissUpdateInstallation() {
        BackgroundRuntime.clearUpdatePause()
        standard.dismissUpdateInstallation()
        policy.finishAttempt()
        onEnd?()
    }
}
