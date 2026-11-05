import Foundation
import Combine

private struct SavedState: Codable {
    var version = 1
    var preferences: AppPreferences
    var registeredProjects: [Project]
    var uploadedDemoIDs: Set<String>
    var localRecords: [UploadRecord]
    var liveProjects: [Project]?
    var preparedFingerprints: [String: String]?
    var notifiedApprovalKeys: Set<String>?
    var uploadCheckpoints: [String: UploadCheckpoint]?
    var binding: LocalBinding?
    var initialScanCompleted: Bool?
    var collectionNeedsCompletion: Bool?
    var scanWindow: SessionScanWindow?
    var discoveredSources: [LocalSessionSource]?
    var importedSessions: [AgentSession]?
    var loadedFingerprints: [String: String]?
    var excludedSessionFingerprints: [String: String]?
    var nativeTitles: [String: String]?
    var collectorPolicy: CollectorPolicy?
    var permissionsConfirmed: Bool?
    var collectorLogs: [CollectorLog]?
    var lastAutomaticUploadAt: Date?
    var pendingNotificationReceipts: Set<String>?
    var uploadExcludedSessionIDs: Set<String>?
    var hiddenTerms: [String]?
    var allowedTerms: [String]?
    var hiddenPatterns: [String]?
}
private struct DiscoveryReport: Codable {
    var version = 1
    var scannedAt: Date
    var locations: [AgentLocation]
    var status: [String: String]
    var issues: [String]
    var directoryEnvironment: [String: String]? = nil
}

@MainActor
public final class AppStore: ObservableObject {
    @Published public var page: AppPage = .sessions
    @Published public private(set) var startupStage: StartupStage = .welcome
    @Published public private(set) var startupProgress = DiscoveryProgress()
    @Published public private(set) var collectionProgress: SessionCollectionProgress?
    @Published public private(set) var isLoadingSessionContents = false
    public private(set) var scanWindow: SessionScanWindow?
    private var hasDiscoverySnapshot = false
    private enum CollectionContext { case initial, project(String, ProjectPermission) }
    private var collectionContext: CollectionContext?
    private var initialScanCompleted = false
    private var collectionNeedsCompletion = false
    @Published public private(set) var projects: [Project]
    @Published public private(set) var sessions: [AgentSession]
    @Published public private(set) var uploadRecords: [UploadRecord]
    @Published public private(set) var processingSummaries: [CollectorProcessingSummary] = []
    @Published public private(set) var processingError: String?
    /// Informational upload outcome that is not an error (e.g. nothing new since the last receipt).
    @Published public private(set) var uploadNotice: String?
    private var lastTelemetryAttempt: Date?
    public func processingSummary(for id: String) -> CollectorProcessingSummary? {
        processingSummaries.first { $0.id.lowercased() == id.lowercased() }
    }
    public func reportAppHeartbeat() async {
        guard let collectorService, binding.isBound,
              Date.now.timeIntervalSince(lastTelemetryAttempt ?? .distantPast) >= 30 else { return }
        lastTelemetryAttempt = .now
        recordCollectorLog("heartbeat", "ALIVE")
        await flushCollectorLogs()
        let identity = binding
        do {
            let summaries = try await collectorService.pipeline(binding: identity)
            guard binding == identity else { return }
            if processingSummaries != summaries { processingSummaries = summaries }
            processingError = nil
        } catch {
            if binding == identity {
                processingError = "处理进度暂时无法更新，将自动重试。"
                if (error as? CollectorError)?.status == 401 { handleCollectorError(error) }
            }
        }
    }
    @Published public private(set) var preferences: AppPreferences
    @Published public var selectedProjectID: String
    @Published public var selectedAgent: Agent?
    @Published public var query = ""
    @Published public var uploadFilter: SessionUploadFilter = .all
    /// Sessions the member chose not to upload; they are never packaged, even if already queued.
    @Published public private(set) var uploadExcludedSessionIDs: Set<String> = []
    /// Text the member marked to hide; replaced by "[已隐藏]" in every upload, in any session. Kept across re-binding.
    @Published public private(set) var hiddenTerms: [String] = []
    /// Automatic matches the member un-marked: shown normally and uploaded as written.
    @Published public private(set) var allowedTerms: [String] = []
    /// Regular expressions the member wrote; whatever they match is hidden like a marked term. Kept across re-binding.
    @Published public private(set) var hiddenPatterns: [String] = []
    public var hiding: SecretScrubber.Hiding { .init(terms: hiddenTerms, allowed: allowedTerms, patterns: hiddenPatterns) }
    @Published public var settingsTab: SettingsTab = .account
    @Published public var selectedUploadRecordID: String?
    @Published public private(set) var uploadCheckpoints: [String: UploadCheckpoint] = [:]
    @Published public private(set) var binding = LocalBinding()
    @Published public private(set) var collectorPolicy: CollectorPolicy?
    @Published public private(set) var connectionError: String?
    @Published public private(set) var isConnecting = false
    @Published public private(set) var isPreparingProjects = false
    @Published public private(set) var lastProjectPreparationAt: Date?
    private var projectsPrepared = false
    public var canConfirmCollectorPermissions: Bool {
        collectorPolicy != nil && binding.isBound && projectsPrepared && !isPreparingProjects && !isConnecting
    }
    @Published public private(set) var logUploadError: String?
    @Published public private(set) var appMessages: [AppMessage] = []
    @Published public private(set) var notificationError: String?
    private var pendingNotificationReceipts: Set<String> = []
    /// Failures that repeat on every sync tick are logged at most once per 5 minutes per code so they cannot evict the bounded offline queue.
    private var lastFailureLogAt: [String: Date] = [:]
    private var lastDiscoveryLog: (code: String, at: Date)?
    private var isRefreshingNotifications = false
    private var reportedNotificationPermission: SystemNotificationPermission?
    public func reportNotificationPermission(_ permission: SystemNotificationPermission) async {
        guard binding.isBound, reportedNotificationPermission != permission else { return }
        reportedNotificationPermission = permission
        recordCollectorLog("notification", permission.logCode, level: permission == .allowed ? "info" : "warning")
        await flushCollectorLogs()
    }
    private var permissionsConfirmed = false
    private var collectorLogs: [CollectorLog] = []
    private var lastAutomaticUploadAt: Date?
    private var lastUploadAttempt: Date?
    private var isFlushingLogs = false
    private var isSynchronizingCollector = false
    private let collectorService: (any CollectorServing)?
    public var hasCollectorService: Bool { collectorService != nil }
    @Published public var selectedSessionID: String?
    @Published public private(set) var isUploading = false
    @Published public private(set) var isPreparingUpload = false
    @Published public private(set) var uploadProgress = 0
    @Published public private(set) var uploadTotal = 0
    @Published public private(set) var storageError: String?
    @Published public private(set) var isDiscovering = false
    @Published private var loadingSessionIDs: Set<String> = []
    @Published public private(set) var readerError: String?
    @Published public private(set) var sessionReadErrors: [String: String] = [:]
    @Published public private(set) var agentStatus: [Agent: String] = [:]
    @Published public private(set) var agentLocations: [AgentLocation] = []
    @Published public private(set) var lastDiscoveredAt: Date?
    @Published public private(set) var discoveryIssues: [String] = []
    @Published public private(set) var ignoredTemporary = 0
    @Published public private(set) var sourceRevision = 0
    @Published public private(set) var reviewBatches: [ReviewBatch] = []
    @Published public private(set) var isReviewSignedIn = false
    @Published public private(set) var isRefreshingReviews = false
    @Published public private(set) var isPerformingReviewAction = false
    @Published public private(set) var reviewError: String?
    @Published public var selectedApproval: ApprovalTarget?
    /// The member's own member-detail page (个人数据); nil until the first load succeeds.
    @Published public private(set) var personalData: PersonalData?
    @Published public private(set) var isLoadingPersonalData = false
    @Published public private(set) var personalDataError: String?
    private var personalDataRequest = 0
    public private(set) var notifiedApprovalKeys: Set<String> = []
    public let isLive: Bool
    private var sourceGroups: [String: [LocalSessionSource]] = [:]
    private var loadedFingerprints: [String: String] = [:]
    private var excludedSessionFingerprints: [String: String] = [:]
    private var nativeTitles: [String: String] = [:]
    private var validatedClaudeTitleFingerprints: [String: String] = [:]
    private var preparedFingerprints: [String: String] = [:]
    private var sessionLoads: [String: (fingerprint: String, task: Task<Void, Never>)] = [:]
    private var discoveryTask: Task<Void, Never>?
    private let reader: (any LocalSessionReading)?
    private let discoveryHome: URL
    private let discoveryEnvironment: [String: String]
    private let metadataReader: URL?
    private var rememberedDirectoryEnvironment: [String: String] = [:]
    private static let directoryKeys: Set<String> = ["CODEX_HOME", "CODEX_SQLITE_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME", "OPENCODE_DB", "HERMES_HOME"]
    private let authorizedRoots: [String]
    private let stateURL: URL?
    private var localRecords: [UploadRecord] = []
    private let reviewService: (any ReviewServing)?
    private let serviceURL: URL?
    public var hasReviewService: Bool { reviewService != nil || collectorService != nil }

    public init(repository: any SessionRepository = DemoRepository(), stateURL: URL? = nil, live: Bool = false, reader: (any LocalSessionReading)? = nil, discoveryHome: URL = FileManager.default.homeDirectoryForCurrentUser, authorizedRoots: [String] = [], discoveryEnvironment: [String: String] = ProcessInfo.processInfo.environment, metadataReader: URL? = Bundle.main.url(forResource: "cc-session-reader", withExtension: nil), reviewService: (any ReviewServing)? = nil, collectorService: (any CollectorServing)? = nil, serviceURL: URL? = nil) {
        self.stateURL = stateURL
        self.collectorService = collectorService
        self.reviewService = reviewService
        self.serviceURL = serviceURL
        if !live { reviewBatches = DemoRepository.reviewBatches }
        self.isLive = live; self.reader = reader; self.discoveryHome = discoveryHome; self.authorizedRoots = authorizedRoots.map(Self.normalizedFolder)
        self.discoveryEnvironment = discoveryEnvironment; self.metadataReader = metadataReader
        let initialProjects = live ? [] : repository.projects()
        projects = initialProjects
        sessions = live ? [] : repository.sessions()
        preferences = AppPreferences()
        uploadRecords = live ? [] : DemoRepository.uploadRecords
        selectedProjectID = initialProjects.first(where: { $0.permission == .allowed })?.id ?? ""
        if !live {
            for session in sessions where session.uploaded { uploadCheckpoints[session.id] = UploadCheckpoint(turns: session.turns) }
            if let first = sessions.first, first.turns.count > 1 {
                let exampleTime = Calendar.current.date(bySettingHour: 15, minute: 40, second: 0, of: .now) ?? .now
                uploadCheckpoints[first.id] = UploadCheckpoint(turns: Array(first.turns.prefix(1)), uploadedAt: exampleTime)
            }
        }
        if let stateURL, FileManager.default.fileExists(atPath: stateURL.path) {
            do {
                let saved = try JSONDecoder().decode(SavedState.self, from: Data(contentsOf: stateURL))
                guard saved.version == 1 else { throw CocoaError(.coderReadCorrupt) }
                preferences = saved.preferences
                if live { projects = saved.liveProjects ?? saved.registeredProjects.filter { !$0.isDemo } }
                else { projects += saved.registeredProjects.filter { !$0.isDemo && $0.permission == .pending } }
                preparedFingerprints = saved.preparedFingerprints ?? [:]
                notifiedApprovalKeys = saved.notifiedApprovalKeys ?? []
                binding = saved.binding ?? LocalBinding()
                collectorPolicy = saved.collectorPolicy
                permissionsConfirmed = saved.permissionsConfirmed ?? false
                collectorLogs = saved.collectorLogs ?? []
                lastAutomaticUploadAt = saved.lastAutomaticUploadAt
                pendingNotificationReceipts = saved.pendingNotificationReceipts ?? []
                initialScanCompleted = saved.initialScanCompleted ?? false
                collectionNeedsCompletion = saved.collectionNeedsCompletion ?? false
                scanWindow = saved.scanWindow
                if let checkpoints = saved.uploadCheckpoints { uploadCheckpoints = checkpoints }
                for index in sessions.indices where saved.uploadedDemoIDs.contains(sessions[index].id) {
                    sessions[index].uploaded = true
                    if saved.uploadCheckpoints == nil { uploadCheckpoints[sessions[index].id] = UploadCheckpoint(turns: sessions[index].turns) }
                }
                localRecords = saved.localRecords
                uploadExcludedSessionIDs = saved.uploadExcludedSessionIDs ?? []
                hiddenTerms = saved.hiddenTerms ?? []
                allowedTerms = saved.allowedTerms ?? []
                hiddenPatterns = saved.hiddenPatterns ?? []
                uploadRecords = localRecords + (live ? [] : DemoRepository.uploadRecords)
                if live, let sources = saved.discoveredSources {
                    let active = sources.filter { !SessionSourcePolicy.isArchived($0.source) && (scanWindow?.contains($0.modifiedAt) ?? true) }
                    sourceGroups = Dictionary(grouping: active, by: \.groupID)
                    hasDiscoverySnapshot = true
                    let allowed = Set(projects.filter { $0.permission == .allowed }.map(\.folder))
                    let fingerprints = sourceGroups.filter { $0.value.first.map { allowed.contains($0.projectRoot) } == true }
                        .mapValues { $0.map(\.fingerprint).sorted().joined(separator: "|") }
                    loadedFingerprints = (saved.loadedFingerprints ?? [:]).filter { fingerprints[$0.key] == $0.value }
                    excludedSessionFingerprints = (saved.excludedSessionFingerprints ?? [:]).filter { loadedFingerprints[$0.key] == $0.value }
                    nativeTitles = (saved.nativeTitles ?? [:]).filter { loadedFingerprints[$0.key] != nil }
                    sessions = (saved.importedSessions ?? []).filter { session in
                        (session.hasModelReply || collectorService != nil) && loadedFingerprints[session.id] != nil &&
                        projects.contains { $0.id == session.projectID && $0.permission == .allowed && $0.folder == sourceGroups[session.id]?.first?.projectRoot }
                    }
                    let restored = Set(sessions.map(\.id)).union(excludedSessionFingerprints.keys)
                    if fingerprints.keys.contains(where: { !restored.contains($0) }) { collectionNeedsCompletion = true }
                    lastDiscoveredAt = scanWindow?.end
                    sourceRevision = 1
                }
            } catch {
                storageError = "无法读取本地设置，已使用默认配置。原设置文件未覆盖。"
            }
        }
        if let serviceURL, binding.serviceAddress != serviceURL.absoluteString {
            // Credentials and permissions belong to the deployment that issued them.
            binding = LocalBinding(serviceAddress: serviceURL.absoluteString, name: binding.name)
            collectorPolicy = nil
            permissionsConfirmed = false
        }
        if live {
            if hasDiscoverySnapshot { rebuildSessionList() }
            selectedProjectID = projects.first(where: { $0.permission == .allowed })?.id ?? ""
            if let stateURL, let data = try? Data(contentsOf: stateURL.deletingLastPathComponent().appending(path: "source-discovery.json")), let report = try? JSONDecoder().decode(DiscoveryReport.self, from: data), report.version == 1 {
                agentLocations = report.locations
                rememberedDirectoryEnvironment = (report.directoryEnvironment ?? [:]).filter { Self.directoryKeys.contains($0.key) }
            }
        }
        // These are product defaults, no longer user-facing preferences.
        preferences.launchAtLogin = true
        preferences.keepInMenuBar = true
        if !live {
            for index in sessions.indices { sessions[index].uploaded = uploadCheckpoints[sessions[index].id]?.pendingMessages(in: sessions[index].turns, hiding: hiding).isEmpty == true }
        }
        selectedSessionID = visibleSessions.first?.id
        startupStage = !live || (initialScanCompleted && !collectionNeedsCompletion && scanWindow != nil && hasDiscoverySnapshot) ? .ready : .welcome
        if live, collectorService != nil {
            isReviewSignedIn = binding.isBound
            if !binding.isBound { startupStage = .binding }
            else if !permissionsConfirmed { startupStage = .permissions }
        }
        if live { recordCollectorLog("app", "APP_LAUNCHED") }
    }

    public func resumeSavedCollection() async {
        guard isLive, binding.isBound, permissionsConfirmed, startupStage == .welcome,
              initialScanCompleted || scanWindow != nil, collectionProgress == nil else { return }
        await startInitialScan()
    }

    public func startInitialScan(at date: Date = .now) async {
        guard startupStage == .welcome, !isDiscovering else { return }
        if collectorService != nil {
            guard binding.isBound, permissionsConfirmed, await refreshCollectorPolicy() else { return }
            recordCollectorLog("scan", "SCAN_STARTED")
            await flushCollectorLogs()
            guard startupStage == .welcome, permissionsConfirmed else { return }
        }
        startupStage = .scanning
        startupProgress = DiscoveryProgress()
        if isLive {
            if scanWindow == nil {
                scanWindow = SessionScanWindow(endingAt: date)
                hasDiscoverySnapshot = false
                persist()
            }
            if !hasDiscoverySnapshot { await refreshDiscovery(includeAuthorizedContent: false) }
            collectionContext = .initial
            await completeCollection()
            return
        } else {
            for step in 1...5 {
                try? await Task.sleep(for: .milliseconds(160))
                startupProgress = DiscoveryProgress(completedSteps: step, message: "正在识别项目位置", toolsFound: step, projectsFound: projects.count)
            }
        }
        startupProgress = DiscoveryProgress(completedSteps: 6, message: "扫描完成", toolsFound: isLive ? Set(agentLocations.filter(\.exists).map(\.agent)).count : Agent.allCases.count, projectsFound: projects.count)
        initialScanCompleted = true
        persist()
        if !pendingProjects.isEmpty { page = .approvals }
        startupStage = .ready
    }

    public func previewStartup(_ progress: DiscoveryProgress? = nil) {
        guard !isLive else { return }
        startupProgress = progress ?? DiscoveryProgress()
        startupStage = progress == nil ? .welcome : .scanning
    }

    public func previewCollectorOnboarding(permissions: Bool) {
        guard !isLive else { return }
        binding = LocalBinding(serviceAddress: "https://company.example", name: "预览用户")
        startupStage = permissions ? .permissions : .binding
    }

    public func previewCollection(_ progress: SessionCollectionProgress? = nil) {
        guard !isLive else { return }
        collectionProgress = progress
    }

    public func collectProject(_ id: String) async {
        guard collectionProgress == nil,
              let project = projects.first(where: { $0.id == id }) else { return }
        collectionContext = .project(id, project.permission)
        collectionNeedsCompletion = isLive
        if isLive {
            collectionProgress = SessionCollectionProgress(message: discoveryTask == nil ? "正在导入项目会话" : "正在完成当前读取，随后导入项目会话")
            persist()
            // Accept the user's request immediately, but finish the in-flight read before changing its authorization snapshot.
            if let discoveryTask { await discoveryTask.value }
        }
        if collectorService != nil {
            guard await synchronizePermission(id, permission: .allowed) else { collectionProgress = nil; collectionContext = nil; return }
        } else { applyProjectPermission(id, permission: .allowed) }
        guard isLive else { collectionContext = nil; return }
        await completeCollection()
    }

    public func retryCollection() async {
        guard collectionContext != nil, collectionProgress != nil, !isLoadingSessionContents else { return }
        await completeCollection()
    }

    public func cancelCollection() {
        guard !isLoadingSessionContents, let context = collectionContext else { return }
        switch context {
        case .initial:
            initialScanCompleted = false
            startupStage = .welcome
        case .project(let id, let permission):
            if collectorService == nil { applyProjectPermission(id, permission: permission) }
            page = .approvals
        }
        collectionProgress = nil
        collectionContext = nil
        collectionNeedsCompletion = false
        persist()
    }

    private func completeCollection() async {
        let projectID: String?
        if case .project(let id, _) = collectionContext { projectID = id }
        else { projectID = nil }
        let successful = await loadAuthorizedSessionContents(showProgress: true, projectID: projectID)
        guard successful else { recordCollectorLog("scan", "SCAN_FAILED", level: "error", details: .readFailure); persist(); await flushCollectorLogs(); return }
        await refreshAuthorizedTitles(projectID: projectID)
        if case .initial = collectionContext {
            startupProgress = DiscoveryProgress(completedSteps: 6, message: "扫描完成", toolsFound: Set(agentLocations.filter(\.exists).map(\.agent)).count, projectsFound: projects.count)
            initialScanCompleted = true
            if !pendingProjects.isEmpty { page = .approvals }
            startupStage = .ready
        }
        collectionContext = nil
        collectionProgress = nil
        collectionNeedsCompletion = false
        recordCollectorLog("scan", "SCAN_COMPLETED")
        persist()
        await flushCollectorLogs()
    }

    @discardableResult
    private func loadAuthorizedSessionContents(showProgress: Bool, projectID: String? = nil) async -> Bool {
        guard !isLoadingSessionContents else { return false }
        isLoadingSessionContents = true
        defer { isLoadingSessionContents = false }
        let roots = Set(approvedProjects.filter { projectID == nil || $0.id == projectID }.map(\.folder))
        let ids = sourceGroups.keys.filter { key in sourceGroups[key]?.first.map { roots.contains($0.projectRoot) } == true }.sorted()
        var progress = SessionCollectionProgress(message: projectID == nil ? "正在加载会话内容" : "正在导入项目会话", total: ids.count)
        if showProgress { collectionProgress = progress }
        for id in ids {
            if !showProgress && collectionProgress != nil { break }
            let title = sessions.first(where: { $0.id == id })?.title ?? sourceGroups[id]?.first.map(fallbackTitle) ?? "会话"
            await loadSession(id)
            progress.processed += 1
            let fingerprint = sourceGroups[id]?.map(\.fingerprint).sorted().joined(separator: "|")
            if let fingerprint, loadedFingerprints[id] == fingerprint, sessionReadErrors[id] == nil {
                progress.completed += 1
                if excludedSessionFingerprints[id] == fingerprint { progress.excluded += 1 }
            } else if let source = sourceGroups[id]?.first, approvedProjects.contains(where: { $0.folder == source.projectRoot }) {
                progress.failures.append(.init(id: id, title: title, message: sessionReadErrors[id] ?? "会话内容未能完整加载，请重试。"))
            } else { progress.completed += 1 }
            if showProgress { collectionProgress = progress }
        }
        reconcileSelection()
        readerError = selectedSessionID.flatMap { sessionReadErrors[$0] }
        if !progress.failures.isEmpty {
            var details = CollectorLogDetails.readFailure
            details.failedSessionCount = progress.failures.count
            recordCollectorLogThrottled("scan", "SESSION_READ_FAILED", level: "warning", details: details)
        }
        return progress.failures.isEmpty
    }

    public var approvedProjects: [Project] { projects.filter { $0.permission == .allowed } }
    public var visibleSessions: [AgentSession] {
        sessions(matching: selectedAgent)
    }
    private func sessions(matching agent: Agent?) -> [AgentSession] {
        guard approvedProjects.contains(where: { $0.id == selectedProjectID }) else { return [] }
        return sessions.filter { session in
            session.projectID == selectedProjectID && (agent == nil || session.agent == agent) &&
            uploadFilter.includes(uploadState(of: session)) &&
            (query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
             ([session.title] + session.turns.flatMap { [$0.prompt, $0.answer ?? ""] }).joined(separator: " ").localizedCaseInsensitiveContains(query))
        }
    }
    public var selectedSession: AgentSession? { visibleSessions.first { $0.id == selectedSessionID } }
    public var loadingSessionID: String? {
        guard isLive, reader != nil, let id = selectedSessionID, let sources = sourceGroups[id], selectedSession != nil else { return nil }
        let fingerprint = sources.map(\.fingerprint).sorted().joined(separator: "|")
        return loadingSessionIDs.contains(id) || (loadedFingerprints[id] != fingerprint && sessionReadErrors[id] == nil) ? id : nil
    }
    public var pendingSessions: [AgentSession] {
        sessions.filter { session in
            !session.uploaded && !uploadExcludedSessionIDs.contains(session.id) && approvedProjects.contains { $0.id == session.projectID }
        }
    }
    public func uploadState(of session: AgentSession) -> SessionUploadState {
        uploadExcludedSessionIDs.contains(session.id) ? .excluded : session.uploaded ? .uploaded : .pending
    }
    /// Sessions of allowed projects that the member keeps out of uploads.
    public var excludedSessionCount: Int {
        sessions.filter { session in
            uploadExcludedSessionIDs.contains(session.id) && approvedProjects.contains { $0.id == session.projectID }
        }.count
    }
    /// Takes effect at the next upload. Content that was already uploaded stays in the company system.
    public func setUploadExcluded(_ excluded: Bool, for sessionID: String) {
        guard uploadExcludedSessionIDs.contains(sessionID) != excluded else { return }
        if excluded { uploadExcludedSessionIDs.insert(sessionID) } else { uploadExcludedSessionIDs.remove(sessionID) }
        persist()
        reconcileSelection()
    }
    public var newProjectCount: Int { projects.filter { $0.permission == .pending }.count }
    public var pendingProjects: [Project] { projects.filter { $0.permission == .pending } }
    public var pendingCards: [ReviewCard] { reviewBatches.flatMap(\.pendingCards) }
    public var approvalTargets: [ApprovalTarget] { pendingProjects.map { .project($0.id) } + pendingCards.map { .card($0.id) } }
    public var approvalCount: Int { newProjectCount + pendingCards.count }
    public func openApproval(_ target: ApprovalTarget? = nil) {
        page = .approvals
        switch target {
        case .project(let id): selectedApproval = .project(pendingProjects.first(where: { $0.id == id })?.id ?? pendingProjects.first?.id ?? "")
        case .card(let id): selectedApproval = .card(pendingCards.first(where: { $0.id == id })?.id ?? pendingCards.first?.id ?? "")
        case nil: selectedApproval = approvalTargets.first
        }
    }
    public func markApprovalsNotified(_ keys: Set<String>) {
        guard !keys.isSubset(of: notifiedApprovalKeys) else { return }
        notifiedApprovalKeys.formUnion(keys)
        persist()
    }
    public func batch(for cardID: String) -> ReviewBatch? { reviewBatches.first { $0.pendingCards.contains { $0.id == cardID } } }
    public func signInForReviews(email: String, password: String) async {
        guard let reviewService, !isRefreshingReviews, !isPerformingReviewAction else { return }
        isRefreshingReviews = true
        reviewError = nil
        do {
            try await reviewService.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
            isReviewSignedIn = true
        } catch { reviewError = error.localizedDescription }
        isRefreshingReviews = false
        if isReviewSignedIn { await refreshReviews() }
    }
    public func signOutForReviews() async {
        guard let reviewService, !isRefreshingReviews, !isPerformingReviewAction else { return }
        isRefreshingReviews = true
        defer { isRefreshingReviews = false }
        // Local access ends even when the server cannot be reached.
        isReviewSignedIn = false
        reviewBatches = []
        reviewError = nil
        try? await reviewService.logout()
    }
    /// Loads the member's own page. `month` ("YYYY-MM") pages the progress calendar; nil is the current month.
    /// Without a service (demo mode) the sample data stands in, so the page and its month controls still work.
    public func loadPersonalData(month: String? = nil) async {
        guard let collectorService else {
            if isLive { personalDataError = "未连接系统，暂时无法查看个人数据。" }
            else { personalData = DemoRepository.personalData(month: month); personalDataError = nil }
            return
        }
        guard binding.isBound else { personalDataError = "绑定后才能查看个人数据。"; return }
        // The newest request wins: a slow answer for a month the member has already left must not replace the page.
        personalDataRequest += 1
        let ticket = personalDataRequest, identity = binding
        isLoadingPersonalData = true
        defer { if ticket == personalDataRequest { isLoadingPersonalData = false } }
        do {
            let data = try await collectorService.personalData(binding: identity, month: month)
            guard ticket == personalDataRequest, binding == identity else { return }
            personalData = data
            personalDataError = nil
        } catch {
            guard ticket == personalDataRequest, binding == identity else { return }
            if (error as? CollectorError)?.status == 401 { handleCollectorError(error) }
            personalDataError = (error as? CollectorError)?.message ?? "个人数据暂时无法加载，请检查网络后重试。"
        }
    }
    public func refreshReviews() async {
        guard hasReviewService, isReviewSignedIn, !isRefreshingReviews, !isPerformingReviewAction else { return }
        isRefreshingReviews = true
        defer { isRefreshingReviews = false }
        let identity = binding
        do {
            let batches = try await loadBoundReviews()
            guard binding == identity else { return }
            reviewBatches = batches
            reviewError = nil
            reconcileApprovalSelection()
        } catch { if binding == identity { handleReviewError(error) } }
    }
    public func performCardAction(_ action: CardAction, cardID: String) async {
        guard !isPerformingReviewAction, !isRefreshingReviews, let batch = batch(for: cardID), !batch.isRegenerating(cardID) else { return }
        if case .regenerate(let instruction) = action {
            guard (2...1000).contains(instruction.trimmingCharacters(in: .whitespacesAndNewlines).count) else { return }
        }
        if !isLive {
            guard let index = reviewBatches.firstIndex(where: { $0.id == batch.id }), let card = reviewBatches[index].items.firstIndex(where: { $0.id == cardID }) else { return }
            switch action {
            case .approve: reviewBatches[index].items[card].review_status = "approved"
            case .exclude: reviewBatches[index].items[card].review_status = "excluded"
            case .status(let status): reviewBatches[index].items[card].payload.projectStatus = status
            case .regenerate(let instruction):
                isPerformingReviewAction = true
                reviewBatches[index].regenerationJobs = [.init(work_item_id: cardID, status: "PENDING", error_message: nil)]
                try? await Task.sleep(for: .milliseconds(600))
                reviewBatches[index].items[card].payload.overview = "本地示例修改意见：\(instruction.trimmingCharacters(in: .whitespacesAndNewlines))"
                reviewBatches[index].regenerationJobs = []
                reviewBatches[index].review.version += 1
                isPerformingReviewAction = false
            }
            reconcileApprovalSelection()
            return
        }
        guard hasReviewService, isReviewSignedIn else { return }
        isPerformingReviewAction = true
        reviewError = nil
        do {
            if let collectorService, binding.isBound {
                try await collectorService.perform(binding: binding, action: action, cardID: cardID, reviewID: batch.id, version: batch.review.version)
            } else { try await reviewService?.perform(action, cardID: cardID, reviewID: batch.id, version: batch.review.version) }
            reviewBatches = try await loadBoundReviews()
            reconcileApprovalSelection()
        } catch {
            recordCollectorLog("review", "REVIEW_ACTION_FAILED", level: "error", details: .failure(error))
            handleReviewError(error)
            // Refresh conflicts without silently reapplying an action against newer content.
            if ((error as? ReviewServiceError)?.status ?? (error as? CollectorError)?.status) == 409, let batches = try? await loadBoundReviews() {
                reviewBatches = batches
                reconcileApprovalSelection()
            }
        }
        isPerformingReviewAction = false
    }
    private func handleReviewError(_ error: any Error) {
        if error is CollectorError { handleCollectorError(error) }
        reviewError = error.localizedDescription
        if (error as? ReviewServiceError)?.status == 401 {
            isReviewSignedIn = false
            reviewBatches = []
        }
    }

    private func loadBoundReviews() async throws -> [ReviewBatch] {
        if let collectorService, binding.isBound { return try await collectorService.reviews(binding: binding) }
        return try await reviewService?.loadReviews() ?? []
    }
    private func reconcileApprovalSelection() {
        guard let selectedApproval, !approvalTargets.contains(selectedApproval) else { return }
        let sameKind = approvalTargets.first { target in
            switch (selectedApproval, target) {
            case (.project, .project), (.card, .card): true
            default: false
            }
        }
        self.selectedApproval = sameKind
    }
    public func count(for project: Project) -> Int {
        sourceGroups.isEmpty ? sessions.filter { $0.projectID == project.id }.count : sourceGroups.filter {
            $0.value.first?.projectRoot == project.folder && excludedSessionFingerprints[$0.key] == nil
        }.count
    }
    public func count(for agent: Agent?) -> Int { sessions(matching: agent).count }
    public func projectName(_ id: String) -> String { projects.first { $0.id == id }?.name ?? "" }
    public func selectProject(_ id: String) {
        guard approvedProjects.contains(where: { $0.id == id }) else { return }
        selectedProjectID = id
        query = ""
        readerError = nil
        selectedSessionID = visibleSessions.first?.id
    }
    public func reconcileSelection() {
        if !visibleSessions.contains(where: { $0.id == selectedSessionID }) { selectedSessionID = visibleSessions.first?.id }
    }
    public func selectSession(_ id: String) {
        guard visibleSessions.contains(where: { $0.id == id }) else { return }
        readerError = sessionReadErrors[id]
        selectedSessionID = id
    }
    public func updatePreferences(_ update: (inout AppPreferences) -> Void) {
        update(&preferences)
        preferences.uploadHour = min(23, max(0, preferences.uploadHour))
        preferences.uploadMinute = min(59, max(0, preferences.uploadMinute))
        preferences.uploadWeekday = min(7, max(1, preferences.uploadWeekday ?? 6))
        persist()
    }
    public func saveBinding(_ value: LocalBinding) -> Bool {
        guard !isLive else { return false }
        var value = value
        value.serviceAddress = value.serviceAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        value.name = value.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.isValid else { return false }
        value.savedAt = .now
        binding = value
        persist()
        return storageError == nil
    }
    public func agents(for project: Project) -> [Agent] {
        if !isLive {
            let found = sessions.filter { $0.projectID == project.id }.map(\.agent)
            return Agent.allCases.filter { found.contains($0) || (project.permission == .pending && [.codex, .claude].contains($0)) }
        }
        let found = Set(sourceGroups.values.flatMap { $0 }.filter { $0.projectRoot == project.folder }.map(\.agent))
        return Agent.allCases.filter { found.contains($0) }
    }
    public func changeProjectFolder(_ id: String, to folder: String) throws {
        guard let index = projects.firstIndex(where: { $0.id == id }) else { return }
        if collectorService != nil, projects[index].scopeKey != nil {
            try locateCollectorProject(id, folder: folder)
            return
        }
        let canonical = Self.normalizedFolder(folder)
        guard canonical != Self.normalizedFolder(projects[index].folder) else { return }
        guard !projects.contains(where: { $0.id != id && Self.normalizedFolder($0.folder) == canonical }) else { throw ProjectRegistrationError.duplicateFolder }
        // A different directory must never inherit authorization from the old one.
        decideProject(id, permission: .denied)
        projects[index].id = canonical
        projects[index].folder = canonical
        projects[index].permission = .pending
        projects[index].discoveredAt = .now
        projects[index].isDemo = false
        reconcileSelection()
        persist()
    }
    public func registerProject(name: String, folder: String) throws {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let folder = folder.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { throw ProjectRegistrationError.emptyName }
        guard !folder.isEmpty else { throw ProjectRegistrationError.emptyFolder }
        guard !projects.contains(where: { $0.name == name }) else { throw ProjectRegistrationError.duplicateName }
        let canonical = Self.normalizedFolder(folder)
        guard !projects.contains(where: { Self.normalizedFolder($0.folder) == canonical }) else { throw ProjectRegistrationError.duplicateFolder }
        projects.append(Project(id: isLive ? canonical : UUID().uuidString, name: name, folder: canonical, permission: .pending, isDemo: false))
        projects[projects.count - 1].discoveredAt = .now
        persist()
    }
    public func decideProject(_ id: String, permission: ProjectPermission) {
        if collectorService != nil { Task { await synchronizePermission(id, permission: permission) }; return }
        applyProjectPermission(id, permission: permission)
    }
    private func applyProjectPermission(_ id: String, permission: ProjectPermission) {
        guard let index = projects.firstIndex(where: { $0.id == id }), projects[index].permission != permission else { return }
        projects[index].permission = permission
        if permission != .allowed {
            for (key, sources) in sourceGroups where sources.first?.projectRoot == projects[index].folder {
                loadedFingerprints.removeValue(forKey: key)
                excludedSessionFingerprints.removeValue(forKey: key)
                validatedClaudeTitleFingerprints.removeValue(forKey: key)
            }
            for key in sessions.filter({ $0.projectID == id }).map(\.id) {
                loadedFingerprints.removeValue(forKey: key)
                nativeTitles.removeValue(forKey: key)
                preparedFingerprints.removeValue(forKey: key)
            }
            if isLive { sessions.removeAll { $0.projectID == id }; pruneOutbox() }
        }
        persist()
        if isLive { rebuildSessionList() }
        reconcileApprovalSelection()
    }
    public func refreshDiscovery(includeAuthorizedContent: Bool = true) async {
        guard isLive, !isDiscovering, !isLoadingSessionContents,
              (collectorService != nil || scanWindow == nil || !hasDiscoverySnapshot),
              collectionProgress == nil || !includeAuthorizedContent else { return }
        if collectorService != nil && (!binding.isBound || collectorPolicy == nil || [.binding, .permissions].contains(startupStage)) { return }
        isDiscovering = true
        let task = Task { [self] in
            defer { isDiscovering = false; discoveryTask = nil }
            await performDiscovery(includeAuthorizedContent: includeAuthorizedContent)
        }
        discoveryTask = task
        await task.value
    }
    private func performDiscovery(includeAuthorizedContent: Bool) async {
        let identity = binding
        let snapshot = await discoverMetadata(in: scanWindow)
        guard collectorService == nil || binding == identity else { return }
        applyDiscovery(snapshot)
        if collectorService != nil {
            do {
                try await registerDiscoveredProjects(binding: identity)
                await refreshAppNotifications()
            } catch {
                guard binding == identity else { return }
                recordCollectorLogThrottled("permissions", "POLICY_SYNC_FAILED", level: "error", details: .failure(error))
                handleCollectorError(error)
            }
        }
        guard collectorService == nil || binding == identity else { return }
        guard includeAuthorizedContent, collectionProgress == nil else { return }
        await loadAuthorizedSessionContents(showProgress: false)
        guard collectionProgress == nil else { return }
        await refreshAuthorizedTitles()
    }
    private func discoverMetadata(in window: SessionScanWindow?) async -> DiscoverySnapshot {
        let environment = rememberedDirectoryEnvironment.merging(discoveryEnvironment.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { _, current in current }
        rememberedDirectoryEnvironment = environment.filter { Self.directoryKeys.contains($0.key) }
        let scanner = LocalDiscovery(home: discoveryHome, registeredRoots: projects.filter { !$0.isDemo && !$0.folder.isEmpty }.map(\.folder), pathOverrides: preferences.agentPaths, environment: environment, metadataReader: metadataReader, rememberedLocations: agentLocations, scanWindow: window)
        let announceStart = lastDiscoveryLog.map { Date.now.timeIntervalSince($0.at) >= 300 } ?? true
        if announceStart { recordCollectorLog("discovery", "DISCOVERY_STARTED") }
        let started = ContinuousClock.now
        let snapshot = await Task.detached(priority: .userInitiated) { [self] in
            scanner.scan { progress in
                Task { @MainActor [self] in
                    guard self.startupStage == .scanning,
                          progress.completedSteps >= self.startupProgress.completedSteps else { return }
                    self.startupProgress = progress
                }
            }
        }.value
        recordDiscoveryOutcome(snapshot, since: started, announcedStart: announceStart)
        return snapshot
    }
    /// Discovery runs on every idle sync tick: repeat outcomes are logged once per 5 minutes, a changed outcome immediately.
    private func recordDiscoveryOutcome(_ snapshot: DiscoverySnapshot, since started: ContinuousClock.Instant, announcedStart: Bool) {
        let failed = snapshot.sessions.isEmpty && snapshot.agentStatus.values.contains("读取受限")
        let code = failed ? "DISCOVERY_FAILED" : "DISCOVERY_COMPLETED"
        guard announcedStart || lastDiscoveryLog?.code != code else { return }
        lastDiscoveryLog = (code, Date.now)
        var details = CollectorLogDetails()
        if failed { details.errorKind = .read; details.message = "本机会话来源读取受限，未发现任何会话。" }
        details.durationMs = CollectorLogDetails.milliseconds(since: started)
        details.projectCount = snapshot.projects.count
        details.sessionCount = snapshot.sessions.count
        recordCollectorLog("discovery", code, level: failed ? "error" : "info", details: details)
    }
    public func applyDiscovery(_ snapshot: DiscoverySnapshot) {
        guard isLive else { return }
        let activeSources = snapshot.sessions.filter { !SessionSourcePolicy.isArchived($0.source) && (scanWindow?.contains($0.modifiedAt) ?? true) }
        if collectorService == nil, scanWindow != nil, !hasDiscoverySnapshot {
            let recentRoots = Set(activeSources.map(\.projectRoot))
            projects.removeAll { !recentRoots.contains($0.folder) }
        }
        let archivedOnlyRoots = Set(snapshot.sessions.filter { SessionSourcePolicy.isArchived($0.source) }.map(\.projectRoot)).subtracting(activeSources.map(\.projectRoot))
        for discovered in snapshot.projects where !archivedOnlyRoots.contains(discovered.root) && (scanWindow == nil || activeSources.contains { $0.projectRoot == discovered.root }) {
            if collectorService != nil {
                let key = CollectorPackage.digest(Data(("collector-root:" + discovered.root).utf8))
                if let index = projects.firstIndex(where: { $0.scopeKey == key }) {
                    if projects[index].folder != discovered.root { projects[index].folder = discovered.root }
                } else if let index = projects.firstIndex(where: { $0.folder == discovered.root }) {
                    projects[index].scopeKey = key
                } else {
                    var project = Project(id: "scope:" + key, name: discovered.name, folder: discovered.root, permission: .pending, isDemo: false)
                    project.scopeKey = key; project.discoveredAt = .now
                    projects.append(project)
                }
                continue
            }
            if !projects.contains(where: { $0.folder == discovered.root }) {
                projects.append(Project(id: discovered.root, name: discovered.name, folder: discovered.root, permission: collectorService == nil && authorizedRoots.contains(discovered.root) ? .allowed : .pending, isDemo: false))
                projects[projects.count - 1].discoveredAt = .now
            }
        }
        if let policy = collectorPolicy { applyCollectorPolicy(policy) }
        sourceGroups = Dictionary(grouping: activeSources, by: \.groupID)
        let activeIDs = Set(sourceGroups.keys)
        loadedFingerprints = loadedFingerprints.filter { activeIDs.contains($0.key) }
        excludedSessionFingerprints = excludedSessionFingerprints.filter { key, fingerprint in
            sourceGroups[key]?.map(\.fingerprint).sorted().joined(separator: "|") == fingerprint
        }
        nativeTitles = nativeTitles.filter { activeIDs.contains($0.key) }
        validatedClaudeTitleFingerprints = validatedClaudeTitleFingerprints.filter { activeIDs.contains($0.key) }
        preparedFingerprints = preparedFingerprints.filter { activeIDs.contains($0.key) }
        agentStatus = snapshot.agentStatus
        agentLocations = snapshot.locations.filter { !SessionSourcePolicy.isArchived($0.sessionPath) }
        discoveryIssues = snapshot.issues
        ignoredTemporary = snapshot.skippedTemporary
        lastDiscoveredAt = .now
        persistDiscoveryReport()
        sourceRevision += 1
        hasDiscoverySnapshot = true
        rebuildSessionList()
        pruneOutbox()
        persist()
    }
    public func refreshAuthorizedTitles(projectID: String? = nil) async {
        guard collectorService == nil || permissionsConfirmed else { return }
        let allowed = Set(approvedProjects.filter { projectID == nil || $0.id == projectID }.map(\.folder))
        let sources = sourceGroups.values.flatMap { $0 }.filter { allowed.contains($0.projectRoot) && excludedSessionFingerprints[$0.groupID] == nil }
        let claudeGroups = Dictionary(grouping: sources.filter { $0.agent == .claude }, by: \.groupID)
        let fingerprints = claudeGroups.mapValues(claudeTitleFingerprint)
        let refresh = sources.filter { $0.agent != .claude || validatedClaudeTitleFingerprints[$0.groupID] != fingerprints[$0.groupID] }
        guard !refresh.isEmpty else { return }
        let loader = AuthorizedTitles(home: discoveryHome, pathOverrides: preferences.agentPaths, environment: rememberedDirectoryEnvironment.merging(discoveryEnvironment.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { _, current in current })
        let result = await Task.detached(priority: .utility) { loader.readWithValidation(sources: refresh, allowedRoots: allowed) }.value
        let stillAllowed = Set(approvedProjects.map(\.folder))
        for key in result.validatedClaudeKeys {
            guard let current = sourceGroups[key], current.allSatisfy({ stillAllowed.contains($0.projectRoot) }),
                  claudeTitleFingerprint(current) == fingerprints[key] else { continue }
            validatedClaudeTitleFingerprints[key] = fingerprints[key]
        }
        for session in sessions where (projectID == nil || session.projectID == projectID) && projects.contains(where: { $0.id == session.projectID && stillAllowed.contains($0.folder) }) {
            if let title = result.titles[session.id], let index = sessions.firstIndex(where: { $0.id == session.id }) {
                nativeTitles[session.id] = title
                if sessions[index].title != title { sessions[index].title = title }
            }
        }
    }
    private func claudeTitleFingerprint(_ sources: [LocalSessionSource]) -> String {
        sources.sorted { $0.id < $1.id }.map { source in
            let file = URL(fileURLWithPath: source.source)
            let stamps = [file, file.deletingLastPathComponent().appending(path: "sessions-index.json")].map { path in
                guard let values = try? FileManager.default.attributesOfItem(atPath: path.path) else { return "missing" }
                let size = (values[.size] as? NSNumber)?.uint64Value ?? 0
                let modified = (values[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
                let inode = (values[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
                return "\(size):\(modified):\(inode)"
            }
            return ([source.id, source.fingerprint] + stamps).joined(separator: "|")
        }.joined(separator: "\n")
    }
    public func detectedPaths(for agent: Agent) -> [String] {
        var seen: Set<String> = []
        return agentLocations.filter { $0.agent == agent && $0.exists }.map(\.sessionPath).filter { seen.insert($0).inserted }
    }
    public func sourceCounts(for location: AgentLocation) -> (discovered: Int, allowed: Int) {
        let allowedRoots = Set(approvedProjects.map(\.folder))
        var found: Set<String> = [], allowed: Set<String> = []
        for source in sourceGroups.values.flatMap({ $0 }) where source.agent == location.agent {
            let raw: String
            if source.source.hasPrefix("sqlite:") {
                let tail = String(source.source.dropFirst(7))
                if let range = tail.range(of: ":ses_", options: .backwards) { raw = String(tail[..<range.lowerBound]) }
                else if let hash = tail.lastIndex(of: "#") { raw = String(tail[..<hash]) }
                else { continue }
            } else { raw = source.source }
            let path = Self.normalizedFolder(raw)
            guard path == location.sessionPath || path.hasPrefix(location.sessionPath + "/") else { continue }
            found.insert(source.groupID)
            if allowedRoots.contains(source.projectRoot) { allowed.insert(source.groupID) }
        }
        return (found.count, allowed.count)
    }
    private func persistDiscoveryReport() {
        guard let stateURL else { return }
        do {
            let folder = stateURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let report = DiscoveryReport(scannedAt: .now, locations: agentLocations, status: Dictionary(uniqueKeysWithValues: agentStatus.map { ($0.key.id, $0.value) }), issues: discoveryIssues, directoryEnvironment: rememberedDirectoryEnvironment)
            let file = folder.appending(path: "source-discovery.json")
            try JSONEncoder().encode(report).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { storageError = "无法保存本机目录扫描结果。" }
    }
    private func rebuildSessionList() {
        let old = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let allowedRoots = Dictionary(projects.filter { $0.permission == .allowed }.map { ($0.folder, $0.id) }, uniquingKeysWith: { first, _ in first })
        let rebuilt = sourceGroups.compactMap { key, sources -> AgentSession? in
            guard let source = sources.first, let projectID = allowedRoots[source.projectRoot] else { return nil }
            let fingerprint = sources.map(\.fingerprint).sorted().joined(separator: "|")
            guard excludedSessionFingerprints[key] != fingerprint else { return nil }
            let previous = old[key]
            let keep = loadedFingerprints[key] == fingerprint
            let turns = keep ? previous?.turns ?? [] : []
            let uploaded = keep && uploadCheckpoints[key]?.pendingMessages(in: turns, hiding: hiding).isEmpty == true
            return AgentSession(id: key, projectID: projectID, agent: source.agent, title: nativeTitles[key] ?? (keep ? previous?.title ?? fallbackTitle(source) : fallbackTitle(source)), updatedLabel: dateLabel(source.modifiedAt), uploaded: uploaded, turns: turns)
        }.sorted { (sourceGroups[$0.id]?.first?.modifiedAt ?? .distantPast) > (sourceGroups[$1.id]?.first?.modifiedAt ?? .distantPast) }
        if sessions != rebuilt { sessions = rebuilt }
        let visibleIDs = Set(sessions.map(\.id))
        sessionReadErrors = sessionReadErrors.filter { visibleIDs.contains($0.key) }
        if !approvedProjects.contains(where: { $0.id == selectedProjectID }) { selectedProjectID = approvedProjects.first?.id ?? "" }
        reconcileSelection()
    }
    public func loadSelectedSession() async {
        guard isLive, let id = selectedSessionID else { return }
        await loadSession(id)
    }
    private func loadSession(_ id: String) async {
        guard collectorService == nil || permissionsConfirmed else { return }
        guard let sources = sourceGroups[id], let source = sources.first,
              let project = projects.first(where: { $0.folder == source.projectRoot && $0.permission == .allowed }) else { return }
        guard let reader else {
            sessionReadErrors[id] = "未找到本机会话读取组件，请重新构建应用。"
            if selectedSessionID == id { readerError = sessionReadErrors[id] }
            return
        }
        let fingerprint = sources.map(\.fingerprint).sorted().joined(separator: "|")
        if let loading = sessionLoads[id] {
            await loading.task.value
            if loading.fingerprint != fingerprint { await loadSession(id) }
            return
        }
        guard loadedFingerprints[id] != fingerprint else { return }
        loadingSessionIDs.insert(id)
        if selectedSessionID == id { readerError = nil }
        // A selection change may cancel the view task; keep one shared read per session.
        let task = Task {
            await readSession(id, reader: reader, sources: sources, project: project, fingerprint: fingerprint)
            sessionLoads.removeValue(forKey: id)
            loadingSessionIDs.remove(id)
        }
        sessionLoads[id] = (fingerprint, task)
        await task.value
    }
    private func readSession(_ id: String, reader: any LocalSessionReading, sources: [LocalSessionSource], project: Project, fingerprint: String) async {
        do {
            let result = try await reader.read(sources: sources.sorted { $0.modifiedAt < $1.modifiedAt }, authorizedRoot: project.folder)
            guard projects.contains(where: { $0.id == project.id && $0.permission == .allowed }),
                  sourceGroups[id]?.map(\.fingerprint).sorted().joined(separator: "|") == fingerprint,
                  let index = sessions.firstIndex(where: { $0.id == id }) else { return }
            sessions[index].turns = result.turns
            sessions[index].uploaded = uploadCheckpoints[id]?.pendingMessages(in: result.turns, hiding: hiding).isEmpty == true
            if result.warnings.isEmpty { sessionReadErrors.removeValue(forKey: id) }
            else { sessionReadErrors[id] = result.warnings.joined(separator: "\n") }
            if let title = nativeTitles[id] { sessions[index].title = title }
            else if let prompt = result.turns.first?.prompt { sessions[index].title = Self.displayTitle(prompt) }
            if result.warnings.isEmpty {
                loadedFingerprints[id] = fingerprint
                // Only a successfully parsed conversation with a formal model reply is eligible.
                if !sessions[index].hasModelReply && collectorService == nil {
                    excludedSessionFingerprints[id] = fingerprint
                    sessions.remove(at: index)
                    preparedFingerprints.removeValue(forKey: id)
                    pruneOutbox()
                    reconcileSelection()
                    readerError = selectedSessionID.flatMap { sessionReadErrors[$0] }
                } else { excludedSessionFingerprints.removeValue(forKey: id) }
            }
            if selectedSessionID == id, !result.warnings.isEmpty { readerError = result.warnings.joined(separator: "\n") }
        } catch is CancellationError {
            return
        } catch {
            guard projects.contains(where: { $0.id == project.id && $0.permission == .allowed }),
                  sourceGroups[id]?.map(\.fingerprint).sorted().joined(separator: "|") == fingerprint else { return }
            sessionReadErrors[id] = error.localizedDescription
            if selectedSessionID == id { readerError = error.localizedDescription }
        }
    }
    private func fallbackTitle(_ source: LocalSessionSource) -> String { "\(source.agent.name) 会话 · \(dateLabel(source.modifiedAt))" }
    public static func displayTitle(_ prompt: String) -> String {
        let text = prompt.components(separatedBy: "## My request:").last ?? prompt
        let line = text.split(separator: "\n").first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? "项目会话"
        return String(line.prefix(70))
    }
    private func dateLabel(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN"); formatter.dateFormat = "MM月dd日 HH:mm"; return formatter.string(from: date)
    }
    public static func normalizedFolder(_ folder: String) -> String {
        URL(fileURLWithPath: (folder as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath().path
    }
    public func runLocalUpload() async {
        guard !isUploading, !isPreparingUpload else { return }
        uploadNotice = nil
        connectionError = nil
        if collectorService != nil {
            isPreparingUpload = true
            defer { isPreparingUpload = false }
            if let discoveryTask {
                uploadNotice = "正在等待本机会话扫描完成，随后开始上传。"
                await discoveryTask.value
            }
            await runCollectorUpload()
            return
        }
        uploadProgress = 0; uploadTotal = pendingSessions.count
        isUploading = true
        defer { isUploading = false }
        if isLive { await prepareLocalOutbox(); return }
        do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
        let pending = pendingSessions
        guard !pending.isEmpty else { return }
        let details = pending.map { "\(projectName($0.projectID)) · \($0.agent.name) · \($0.title)" }
        let record = UploadRecord(time: "刚刚", kind: "手动演示", projectsAndAgents: Array(Set(pending.map { projectName($0.projectID) })).sorted().joined(separator: "、"), content: "\(pending.count) 个会话", status: .complete, details: details + ["仅在本机模拟完成，未调用任何上传接口。"], createdAt: .now, projects: summaries(for: pending), isSample: true)
        let ids = Set(pending.map(\.id))
        for index in sessions.indices where ids.contains(sessions[index].id) {
            uploadCheckpoints[sessions[index].id] = UploadCheckpoint(turns: sessions[index].turns)
            sessions[index].uploaded = true
        }
        localRecords.insert(record, at: 0)
        uploadRecords = localRecords + DemoRepository.uploadRecords
        persist()
    }
    private func prepareLocalOutbox() async {
        let approved = pendingSessions
        var staged: [AgentSession] = []
        for session in approved {
            defer { uploadProgress += 1 }
            let fingerprint = sourceGroups[session.id]?.map(\.fingerprint).sorted().joined(separator: "|") ?? ""
            if preparedFingerprints[session.id] == fingerprint { continue }
            await loadSession(session.id)
            if let loaded = sessions.first(where: { $0.id == session.id }), loaded.hasModelReply,
               sessionReadErrors[session.id] == nil,
               projects.contains(where: { $0.id == loaded.projectID && $0.permission == .allowed }) {
                staged.append(loaded)
            }
        }
        guard let stateURL, !staged.isEmpty else { return }
        do {
            let folder = stateURL.deletingLastPathComponent().appending(path: "outbox")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let file = folder.appending(path: "\(UUID().uuidString).json")
            try JSONEncoder().encode(staged).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            for session in staged { preparedFingerprints[session.id] = sourceGroups[session.id]?.map(\.fingerprint).sorted().joined(separator: "|") }
            let record = UploadRecord(time: "刚刚", kind: "本地待传", projectsAndAgents: Array(Set(staged.map { projectName($0.projectID) })).sorted().joined(separator: "、"), content: "\(staged.count) 个会话", status: .queued, details: ["已准备本地待传数据。未连接系统，未发生网络上传。", "\(sessionReadErrors.count) 个会话有读取提示，未将其记为已上传。", "\(file.lastPathComponent)"], createdAt: .now, projects: summaries(for: staged))
            localRecords.insert(record, at: 0); uploadRecords = localRecords; persist()
        } catch { storageError = "待传数据保存失败：\(error.localizedDescription)" }
    }
    public func pendingMessageCount(in session: AgentSession) -> Int {
        uploadCheckpoints[session.id]?.pendingMessages(in: session.turns, hiding: hiding).count ?? UploadCheckpoint.messages(in: session.turns).count
    }
    private func summaries(for values: [AgentSession]) -> [UploadProjectSummary] {
        Dictionary(grouping: values, by: \.projectID).map { id, sessions in
            UploadProjectSummary(id: id, name: projectName(id), sessionCount: sessions.count, messageCount: sessions.reduce(0) { $0 + (collectorService != nil ? UploadCheckpoint.messages(in: $1.turns).count : pendingMessageCount(in: $1)) })
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private func pruneOutbox() {
        guard isLive, let stateURL else { return }
        let folder = stateURL.deletingLastPathComponent().appending(path: "outbox")
        let allowed = Set(approvedProjects.map(\.id))
        do {
            for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension == "json" {
                let staged = try JSONDecoder().decode([AgentSession].self, from: Data(contentsOf: file))
                let active = staged.filter { allowed.contains($0.projectID) && $0.hasModelReply && excludedSessionFingerprints[$0.id] == nil && (lastDiscoveredAt == nil || sourceGroups[$0.id] != nil) }
                guard active.count != staged.count else { continue }
                if active.isEmpty { try FileManager.default.removeItem(at: file) }
                else {
                    try JSONEncoder().encode(active).write(to: file, options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                }
            }
        } catch { storageError = "清理本地待传数据失败：\(error.localizedDescription)" }
    }
    private func persist() {
        guard let stateURL, storageError == nil else { return }
        do {
            let allowed = Set(approvedProjects.map(\.folder))
            let loaded = loadedFingerprints.filter { sourceGroups[$0.key]?.first.map { allowed.contains($0.projectRoot) } == true }
            let saved = SavedState(preferences: preferences, registeredProjects: projects.filter { !$0.isDemo }, uploadedDemoIDs: Set(sessions.filter(\.uploaded).map(\.id)), localRecords: localRecords, liveProjects: isLive ? projects : nil, preparedFingerprints: preparedFingerprints, notifiedApprovalKeys: notifiedApprovalKeys, uploadCheckpoints: uploadCheckpoints, binding: binding, initialScanCompleted: initialScanCompleted, collectionNeedsCompletion: collectionNeedsCompletion, scanWindow: scanWindow, discoveredSources: isLive && hasDiscoverySnapshot ? sourceGroups.values.flatMap { $0 } : nil, importedSessions: isLive ? sessions.filter { ($0.hasModelReply || collectorService != nil) && loaded[$0.id] != nil && sessionReadErrors[$0.id] == nil } : nil, loadedFingerprints: isLive ? loaded : nil, excludedSessionFingerprints: isLive ? excludedSessionFingerprints.filter { loaded[$0.key] == $0.value } : nil, nativeTitles: isLive ? nativeTitles.filter { loaded[$0.key] != nil } : nil, collectorPolicy: collectorPolicy, permissionsConfirmed: permissionsConfirmed, collectorLogs: collectorLogs, lastAutomaticUploadAt: lastAutomaticUploadAt, pendingNotificationReceipts: pendingNotificationReceipts, uploadExcludedSessionIDs: uploadExcludedSessionIDs)
            let folder = stateURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var stored = saved
            stored.hiddenTerms = hiddenTerms
            stored.allowedTerms = allowedTerms
            stored.hiddenPatterns = hiddenPatterns
            try JSONEncoder().encode(stored).write(to: stateURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
        } catch {
            storageError = "本地设置保存失败：\(error.localizedDescription)"
        }
    }
}

extension AppStore {
    public func refreshAppNotifications() async {
        guard let collectorService, binding.isBound, !isRefreshingNotifications else { return }
        isRefreshingNotifications = true
        defer { isRefreshingNotifications = false }
        let identity = binding
        var acknowledging = false
        do {
            let receipts = Array(pendingNotificationReceipts.prefix(100))
            if !receipts.isEmpty {
                acknowledging = true
                try await collectorService.acknowledgeNotifications(binding: identity, ids: receipts)
                acknowledging = false
                guard binding == identity else { return }
                pendingNotificationReceipts.subtract(receipts)
                persist()
            }
            let messages = try await collectorService.notifications(binding: identity)
            guard binding == identity else { return }
            let unread = messages.filter { !pendingNotificationReceipts.contains($0.id) }
            if appMessages != unread { appMessages = unread }
            notificationError = nil
        } catch {
            guard binding == identity else { return }
            if acknowledging { recordCollectorLogThrottled("notification", "NOTIFICATION_RECEIPT_FAILED", level: "error", details: .failure(error)) }
            notificationError = "系统通知同步尚未完成，将自动重试。"
            handleCollectorError(error)
        }
    }

    public func markAppMessageDelivered(_ message: AppMessage) {
        guard binding.isBound, appMessages.contains(where: { $0.id == message.id }) else { return }
        pendingNotificationReceipts.insert(message.id)
        appMessages.removeAll { $0.id == message.id }
        persist()
    }

    public func openAppMessage(type: String, targetID: String?) {
        switch type {
        case "projects": openApproval(pendingProjects.first.map { .project($0.id) })
        case "review":
            let card = reviewBatches.first { $0.id == targetID }?.pendingCards.first ?? pendingCards.first
            openApproval(card.map { .card($0.id) })
        default: page = .sessions
        }
    }

    public func bindCollector(_ value: LocalBinding, code: String) async {
        var value = value
        if let serviceURL { value.serviceAddress = serviceURL.absoluteString }
        guard let collectorService, !isConnecting, !isPreparingProjects, !isUploading, !isSynchronizingCollector, !isFlushingLogs, !isRefreshingReviews, !isPerformingReviewAction, !isRefreshingNotifications, value.isValid else { return }
        isConnecting = true; connectionError = nil
        defer { isConnecting = false }
        do {
            value.name = value.name.trimmingCharacters(in: .whitespacesAndNewlines)
            value.serviceAddress = value.serviceAddress.trimmingCharacters(in: .whitespacesAndNewlines)
            let claim = try await collectorService.claim(binding: value, code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            _ = await collectorService.drainLogs()
            // A new binding never inherits cached contents or local-only approvals; upload history and
            // checkpoints are re-read from the system below.
            binding = value; binding.deviceID = claim.deviceId; binding.name = claim.name; binding.savedAt = .now
            projects = []; sessions = []; sourceGroups = [:]; loadedFingerprints = [:]; excludedSessionFingerprints = [:]
            uploadCheckpoints = [:]; nativeTitles = [:]; preparedFingerprints = [:]; collectorLogs = []
            localRecords = []; uploadRecords = []; scanWindow = nil; hasDiscoverySnapshot = false
            initialScanCompleted = false; permissionsConfirmed = false; lastAutomaticUploadAt = nil
            projectsPrepared = false; lastProjectPreparationAt = nil
            isReviewSignedIn = true; reviewBatches = []; appMessages = []; pendingNotificationReceipts = []; notificationError = nil
            processingSummaries = []; processingError = nil; lastTelemetryAttempt = nil
            reportedNotificationPermission = nil
            lastFailureLogAt = [:]; lastDiscoveryLog = nil
            try discardCollectorOutbox()
            applyCollectorPolicy(claim.policy)
            // Best effort: without it the first upload simply carries the whole cycle again.
            if let state = try? await collectorService.syncState(binding: binding) { restoreCollectorState(state, policy: claim.policy) }
            recordCollectorLog("binding", "BOUND")
            persist()
            await flushCollectorLogs()
            if binding.isBound {
                isConnecting = false
                startupStage = .permissions
            }
        } catch { connectionError = error.localizedDescription }
    }

    public func confirmCollectorPermissions() {
        guard canConfirmCollectorPermissions else {
            connectionError = isPreparingProjects ? "正在发现本机项目，请稍候。" : "请先刷新并完成本机项目发现。"
            return
        }
        permissionsConfirmed = true; startupStage = .welcome; persist()
    }

    @discardableResult
    public func prepareCollectorPermissions(at date: Date = .now) async -> Bool {
        guard let collectorService, binding.isBound, startupStage == .permissions,
              !isPreparingProjects, !isConnecting, !isDiscovering else { return false }
        isPreparingProjects = true; isDiscovering = true; projectsPrepared = false; connectionError = nil
        defer { isPreparingProjects = false; isDiscovering = false }
        let identity = binding
        do {
            let policy = try await collectorService.policy(binding: identity)
            guard binding == identity, startupStage == .permissions else { return false }
            applyCollectorPolicy(policy)
            // Locate project roots before approval without loading titles or conversation bodies.
            let snapshot = await discoverMetadata(in: SessionScanWindow(endingAt: date))
            guard binding == identity, startupStage == .permissions else { return false }
            applyDiscovery(snapshot)
            try await registerDiscoveredProjects(binding: identity)
            guard binding == identity, startupStage == .permissions else { return false }
            let latest = try await collectorService.policy(binding: identity)
            guard binding == identity, startupStage == .permissions else { return false }
            applyCollectorPolicy(latest)
            projectsPrepared = true; lastProjectPreparationAt = .now
            recordCollectorLog("permissions", "POLICY_SYNCED")
            persist()
            await flushCollectorLogs()
            return projectsPrepared && binding.isBound
        } catch {
            guard binding == identity else { return false }
            recordCollectorLogThrottled("permissions", "POLICY_SYNC_FAILED", level: "error", details: .failure(error))
            handleCollectorError(error)
            return false
        }
    }

    private func registerDiscoveredProjects(binding identity: LocalBinding) async throws {
        guard let collectorService, identity.isBound else { return }
        let stage = startupStage
        // Only metadata-backed projects participate; approval is still required to read contents.
        let roots = Set(sourceGroups.values.compactMap { $0.first?.projectRoot })
        for root in roots.sorted() {
            guard binding == identity, startupStage == stage else { return }
            let key = CollectorPackage.digest(Data(("collector-root:" + root).utf8))
            guard collectorPolicy?.entries.contains(where: { $0.scopeKey == key }) != true,
                  let project = projects.first(where: { $0.scopeKey == key && $0.folder == root }) else { continue }
            let count = sourceGroups.values.filter { $0.first?.projectRoot == root }.count
            let updated = try await collectorService.register(binding: identity, scopeKey: key, name: project.name, periodKey: collectorPolicy?.currentPeriod?.periodKey ?? "onboarding", sessionCount: count)
            guard binding == identity, startupStage == stage else { return }
            if updated.version >= (collectorPolicy?.version ?? 0) { applyCollectorPolicy(updated) }
        }
    }

    public func revisitCollectorPermissions() {
        guard collectorService != nil, startupStage == .welcome, !isConnecting else { return }
        permissionsConfirmed = false; projectsPrepared = false; startupStage = .permissions; persist()
    }

    public func locateCollectorProject(_ id: String, folder: String) throws {
        guard !isUploading, !isLoadingSessionContents, let index = projects.firstIndex(where: { $0.id == id }) else { return }
        let canonical = Self.normalizedFolder(folder)
        guard !folder.isEmpty, !SessionSourcePolicy.isArchived(canonical) else { throw ProjectRegistrationError.emptyFolder }
        guard !projects.contains(where: { $0.id != id && $0.folder == canonical }) else { throw ProjectRegistrationError.duplicateFolder }
        let previous = projects[index].permission
        applyProjectPermission(id, permission: .denied)
        projects[index].folder = canonical
        projects[index].permission = previous
        try discardCollectorOutbox()
        persist()
    }

    @discardableResult
    public func refreshCollectorPolicy() async -> Bool {
        guard let collectorService, binding.isBound else { return false }
        do {
            applyCollectorPolicy(try await collectorService.policy(binding: binding))
            connectionError = nil
            persist()
            return true
        } catch {
            recordCollectorLogThrottled("permissions", "POLICY_SYNC_FAILED", level: "error", details: .failure(error))
            handleCollectorError(error)
            return false
        }
    }

    /// A re-bound App keeps only what the system confirms: message digests and received batches.
    private func restoreCollectorState(_ state: CollectorSyncState, policy: CollectorPolicy) {
        for session in state.sessions where !session.messages.isEmpty {
            uploadCheckpoints[session.id] = UploadCheckpoint(messages: session.messages, uploadedAt: state.uploads.compactMap(\.completedAt).max() ?? .now)
        }
        let names = Dictionary(policy.entries.map { ($0.scopeKey, $0.displayName) }, uniquingKeysWith: { first, _ in first })
        localRecords = state.uploads.map { upload in
            let projects = upload.projects.map { UploadProjectSummary(id: $0.scopeKey, name: names[$0.scopeKey] ?? "已上传项目", sessionCount: $0.sessionCount, messageCount: $0.messageCount) }
            let date = upload.completedAt ?? upload.createdAt
            return UploadRecord(id: upload.id, time: date.formatted(.dateTime.month().day().hour().minute()), kind: "周期会话包", projectsAndAgents: projects.map(\.name).sorted().joined(separator: "、"), content: "\(upload.sessionCount) 个完整会话", status: .complete, details: [upload.periodKey, "绑定时从系统恢复"], createdAt: date, projects: projects)
        }
        uploadRecords = localRecords
    }

    private func applyCollectorPolicy(_ policy: CollectorPolicy) {
        let entries = Dictionary(uniqueKeysWithValues: policy.entries.map { ($0.scopeKey, $0) })
        for project in projects {
            guard let key = project.scopeKey else {
                // Local-only decisions cannot bypass a server policy.
                if project.permission == .allowed { applyProjectPermission(project.id, permission: .pending) }
                continue
            }
            applyProjectPermission(project.id, permission: entries[key]?.status ?? .pending)
        }
        for entry in policy.entries {
            if let index = projects.firstIndex(where: { $0.scopeKey == entry.scopeKey }) {
                if projects[index].name != entry.displayName { projects[index].name = entry.displayName }
            }
            else {
                var project = Project(id: "scope:" + entry.scopeKey, name: entry.displayName, folder: "", permission: entry.status, isDemo: false)
                project.scopeKey = entry.scopeKey
                projects.append(project)
            }
        }
        collectorPolicy = policy
        if !approvedProjects.contains(where: { $0.id == selectedProjectID }) { selectedProjectID = approvedProjects.first?.id ?? "" }
        reconcileSelection()
    }

    @discardableResult
    public func synchronizePermission(_ id: String, permission: ProjectPermission) async -> Bool {
        guard let collectorService, binding.isBound, !isConnecting, !isPreparingProjects, !isUploading, permission != .pending,
              let project = projects.first(where: { $0.id == id }) else { return false }
        isConnecting = true; connectionError = nil
        defer { isConnecting = false }
        do {
            var policy = try await collectorService.policy(binding: binding)
            var key = project.scopeKey
            if key == nil || !policy.entries.contains(where: { $0.scopeKey == key }) {
                key = key ?? CollectorPackage.digest(Data(("collector-root:" + project.folder).utf8))
                let sessionCount = sourceGroups.values.filter { $0.first?.projectRoot == project.folder }.count
                policy = try await collectorService.register(binding: binding, scopeKey: key!, name: project.name, periodKey: policy.currentPeriod?.periodKey ?? "onboarding", sessionCount: sessionCount)
                if let index = projects.firstIndex(where: { $0.id == id }) { projects[index].scopeKey = key }
            }
            let updated = try await collectorService.decide(binding: binding, version: policy.version, scopeKey: key!, permission: permission)
            applyCollectorPolicy(updated)
            try discardCollectorOutbox()
            recordCollectorLog("permissions", "POLICY_SYNCED")
            persist(); await flushCollectorLogs()
            return true
        } catch {
            handleCollectorError(error)
            // Conflicts must refresh the visible state, never silently reapply the old decision.
            _ = await refreshCollectorPolicy()
            connectionError = error.localizedDescription
            return false
        }
    }

    private var collectorOutboxURL: URL? { stateURL?.deletingLastPathComponent().appending(path: "collector-outbox.json") }
    private func outboxContainsExcludedSession(_ package: CollectorPackage) throws -> Bool {
        try package.parts.contains { bytes in
            try CollectorJSON.decoder().decode([CollectorSession].self, from: bytes).contains { uploadExcludedSessionIDs.contains($0.id) }
        }
    }
    /// Mark text as hidden. It applies to every upload from now on, including content that was uploaded before:
    /// those sessions become pending again and the hidden version replaces them on the next upload.
    public func hideTerm(_ raw: String) {
        let term = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard term.count >= 2, term.count <= 500, !term.contains(SecretScrubber.hidden) else { return }
        let wasAllowed = allowedTerms.contains(term)
        allowedTerms.removeAll { $0 == term }
        if !hiddenTerms.contains(term) { hiddenTerms.append(term) } else if !wasAllowed { return }
        hidingChanged()
    }
    /// Hide whatever a regular expression matches, in every session and every later upload, like `hideTerm`.
    /// Returns why the expression was refused, or nil once it is in use (or already was).
    @discardableResult
    public func hidePattern(_ raw: String) -> SecretScrubber.PatternProblem? {
        let pattern = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pattern.count >= 2, pattern.count <= 500 else { return nil }
        if let problem = SecretScrubber.problem(withPattern: pattern) { return problem }
        guard !hiddenPatterns.contains(pattern) else { return nil }
        hiddenPatterns.append(pattern)
        hidingChanged()
        return nil
    }
    public func unhidePattern(_ pattern: String) {
        guard hiddenPatterns.contains(pattern) else { return }
        hiddenPatterns.removeAll { $0 == pattern }
        hidingChanged()
    }
    /// Take a red piece back: it is shown normally and uploaded as written, whether the member or an automatic rule
    /// marked it. Sessions that were uploaded with it hidden become pending so the original goes out next time.
    public func revealTerm(_ piece: String) {
        guard !piece.isEmpty, piece.count <= 500 else { return }
        let before = (hiddenTerms, allowedTerms)
        hiddenTerms.removeAll { $0 == piece || piece.contains($0) }
        if !allowedTerms.contains(piece) { allowedTerms.append(piece) }
        guard before.0 != hiddenTerms || before.1 != allowedTerms else { return }
        hidingChanged()
    }
    /// Back to the automatic rules for a piece the member had let through.
    public func restoreAutomatic(_ piece: String) {
        guard allowedTerms.contains(piece) else { return }
        allowedTerms.removeAll { $0 == piece }
        hidingChanged()
    }
    public func unhideTerm(_ term: String) {
        guard hiddenTerms.contains(term) else { return }
        hiddenTerms.removeAll { $0 == term }
        hidingChanged()
    }
    private func hidingChanged() {
        // A queued package still carries the old wording.
        try? discardCollectorOutbox(reason: "隐藏内容已变更，旧批次已作废，后续将重新打包。")
        for index in sessions.indices {
            sessions[index].uploaded = uploadCheckpoints[sessions[index].id]?.pendingMessages(in: sessions[index].turns, hiding: hiding).isEmpty == true
        }
        persist()
    }
    private func discardCollectorOutbox(reason: String = "权限或绑定已变更，旧批次已作废，后续将重新打包。") throws {
        guard let url = collectorOutboxURL, FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
        for index in localRecords.indices where localRecords[index].status == .queued || localRecords[index].status == .failed {
            localRecords[index].status = .failed
            localRecords[index].errorMessage = reason
        }
        uploadRecords = localRecords
    }

    private func recordCollectorLogThrottled(_ stage: String, _ code: String, level: String = "info", details: CollectorLogDetails? = nil) {
        if let last = lastFailureLogAt[code], Date.now.timeIntervalSince(last) < 300 { return }
        lastFailureLogAt[code] = .now
        recordCollectorLog(stage, code, level: level, details: details)
    }

    private func recordCollectorLog(_ stage: String, _ code: String, level: String = "info", uploadID: String? = nil, details: CollectorLogDetails? = nil) {
        guard collectorService != nil, binding.isBound else { return }
        let state = CollectorDeviceState(startupStage: String(describing: startupStage), projectCount: projects.count,
            allowedProjectCount: approvedProjects.count, sessionCount: sessions.count,
            unreadableSessionCount: sessionReadErrors.count, pendingSessionCount: pendingSessions.count,
            isScanning: isDiscovering || isLoadingSessionContents, isUploading: isUploading,
            scanProcessed: collectionProgress?.processed ?? 0, scanTotal: collectionProgress?.total ?? 0,
            uploadProcessed: uploadProgress, uploadTotal: uploadTotal, autoUpload: preferences.autoUpload,
            frequency: preferences.frequency.rawValue, uploadHour: preferences.uploadHour,
            uploadMinute: preferences.uploadMinute, uploadWeekday: preferences.uploadWeekday)
        collectorLogs.append(CollectorLog(stage: stage, level: level, code: code, uploadId: uploadID, sessionCount: sessions.count, state: state, details: (details ?? CollectorLogDetails()).sanitized()))
        // Keep a bounded, durable offline queue without session text, file paths or exception strings.
        if collectorLogs.count > 2000 { collectorLogs.removeFirst(collectorLogs.count - 2000) }
        persist()
    }

    public func flushCollectorLogs() async {
        guard let collectorService, binding.isBound, !isFlushingLogs else { return }
        isFlushingLogs = true
        defer { isFlushingLogs = false }
        // Per-part upload outcomes are recorded by the transport; fold them into the same durable queue.
        let transport = await collectorService.drainLogs()
        if !transport.isEmpty, binding.isBound {
            collectorLogs.append(contentsOf: transport)
            if collectorLogs.count > 2000 { collectorLogs.removeFirst(collectorLogs.count - 2000) }
            persist()
        }
        while !collectorLogs.isEmpty {
            let batch = Array(collectorLogs.prefix(100))
            do {
                try await collectorService.logs(binding: binding, events: batch)
                let ids = Set(batch.map(\.eventId)); collectorLogs.removeAll { ids.contains($0.eventId) }
                logUploadError = nil; persist()
            } catch {
                logUploadError = "运行日志尚未送达系统，将自动重试。"
                if (error as? CollectorError)?.status == 401 { handleCollectorError(error) }
                break
            }
        }
    }

    private func handleCollectorError(_ error: any Error) {
        connectionError = error.localizedDescription
        if (error as? CollectorError)?.status == 401 {
            // Do not continue reading or exposing cached contents after revocation.
            startupStage = .binding; permissionsConfirmed = false
            for project in projects { applyProjectPermission(project.id, permission: .pending) }
            try? discardCollectorOutbox()
            binding.savedAt = nil
            isReviewSignedIn = false; reviewBatches = []; appMessages = []
            personalData = nil; personalDataError = nil
            processingSummaries = []; processingError = nil; lastTelemetryAttempt = nil
            persist()
        }
    }

    public func synchronizeCollector(at date: Date = .now) async {
        guard collectorService != nil, binding.isBound, !isSynchronizingCollector,
              startupStage == .ready, collectionProgress == nil, !isConnecting, !isUploading, !isPreparingUpload else { return }
        isSynchronizingCollector = true
        defer { isSynchronizingCollector = false }
        recordCollectorLog("heartbeat", "ALIVE")
        await flushCollectorLogs()
        guard await refreshCollectorPolicy() else { return }
        let queued = collectorOutboxURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        let calendar = Calendar.current
        var match = DateComponents(hour: preferences.uploadHour, minute: preferences.uploadMinute)
        if preferences.frequency == .weekly { match.weekday = preferences.uploadWeekday ?? 6 }
        let scheduled = calendar.nextDate(after: date.addingTimeInterval(1), matching: match, matchingPolicy: .nextTime, direction: .backward) ?? date
        let due = preferences.autoUpload && (lastAutomaticUploadAt == nil || lastAutomaticUploadAt! < scheduled)
        if (queued || due), date.timeIntervalSince(lastUploadAttempt ?? .distantPast) >= 60 {
            await runCollectorUpload()
            if collectorOutboxURL.map({ !FileManager.default.fileExists(atPath: $0.path) }) == true && connectionError == nil {
                lastAutomaticUploadAt = date; persist()
            }
        } else if !queued && !isDiscovering && !isLoadingSessionContents {
            let recentStart = SessionScanWindow(endingAt: date).start
            scanWindow = SessionScanWindow(start: min(recentStart, collectorPolicy?.currentPeriod?.startsAt ?? recentStart), end: date)
            await refreshDiscovery()
        }
    }

    private func runCollectorUpload() async {
        guard let collectorService else { return }
        guard binding.isBound else { uploadNotice = "请先绑定系统后再上传。"; return }
        guard startupStage == .ready else { uploadNotice = "请先完成项目授权和首次扫描后再上传。"; return }
        guard !isUploading else { uploadNotice = "正在上传，请稍候。"; return }
        guard !isConnecting else { uploadNotice = "正在同步系统连接，请稍后重试。"; return }
        guard !isLoadingSessionContents, !isDiscovering else { uploadNotice = "正在加载本机会话，请完成后再上传。"; return }
        guard let outbox = collectorOutboxURL else { storageError = "无法创建本地上传队列，请重新启动 App 后重试。"; return }
        isUploading = true; lastUploadAttempt = .now; connectionError = nil; uploadNotice = nil
        defer { isUploading = false }
        var activeID: String?
        do {
            guard await refreshCollectorPolicy(), let policy = collectorPolicy else { return }
            guard !approvedProjects.contains(where: { $0.folder.isEmpty }) else { throw CollectorError(status: 409, message: "请先为已允许的项目选择对应的本机文件夹。") }
            var package: CollectorPackage
            if FileManager.default.fileExists(atPath: outbox.path) {
                package = try CollectorJSON.decoder().decode(CollectorPackage.self, from: Data(contentsOf: outbox))
                if package.policyVersion != policy.version { try discardCollectorOutbox() }
                else if try outboxContainsExcludedSession(package) {
                    try discardCollectorOutbox(reason: "已按你的选择不上传部分会话，旧批次已作废，后续将重新打包。")
                }
            }
            if FileManager.default.fileExists(atPath: outbox.path) {
                package = try CollectorJSON.decoder().decode(CollectorPackage.self, from: Data(contentsOf: outbox))
            } else {
                guard let period = policy.currentPeriod else { throw CollectorError(status: 409, message: "系统当前没有开放的采集周期。") }
                let end = min(Date.now, period.endsAt)
                // Refresh the entire cycle, not merely sessions missing an upload checkpoint.
                scanWindow = SessionScanWindow(start: min(period.startsAt, SessionScanWindow(endingAt: end).start), end: end)
                hasDiscoverySnapshot = false
                recordCollectorLog("scan", "SCAN_STARTED")
                await flushCollectorLogs()
                guard startupStage == .ready else { return }
                await refreshDiscovery(includeAuthorizedContent: false)
                guard await loadAuthorizedSessionContents(showProgress: false) else {
                    recordCollectorLog("scan", "SCAN_FAILED", level: "error", details: .readFailure)
                    throw CollectorError(status: 409, message: "部分会话读取失败，整批尚未上传，请重试。")
                }
                recordCollectorLog("scan", "SCAN_COMPLETED")
                // First upload carries every approved session of the scanned month; later uploads carry
                // only sessions that are new or changed since their last successful upload receipt.
                let payload = sessions.compactMap { session -> CollectorSession? in
                    guard !uploadExcludedSessionIDs.contains(session.id),
                          let project = approvedProjects.first(where: { $0.id == session.projectID }), let key = project.scopeKey,
                          let modified = sourceGroups[session.id]?.map(\.modifiedAt).max(), modified <= end,
                          scanWindow?.contains(modified) ?? true,
                          uploadCheckpoints[session.id]?.pendingMessages(in: session.turns, hiding: hiding).isEmpty != true,
                          loadedFingerprints[session.id] != nil, sessionReadErrors[session.id] == nil else { return nil }
                    return CollectorSession(id: session.id, scopeKey: key, agent: session.agent, title: session.title, modifiedAt: modified, turns: session.turns)
                }.sorted { $0.id < $1.id }
                guard !payload.isEmpty else {
                    uploadNotice = "距离上次上传后没有新的或更新的会话，无需上传。"
                    await flushCollectorLogs()
                    return
                }
                package = try CollectorPackage(period: period, start: payload.map(\.modifiedAt).min() ?? end, end: end, version: collectorPolicy?.version ?? policy.version, sessions: payload, hiding: hiding)
                try FileManager.default.createDirectory(at: outbox.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try CollectorJSON.encoder().encode(package).write(to: outbox, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outbox.path)
                recordCollectorLog("upload", "UPLOAD_QUEUED", uploadID: package.id, details: .forPackage(package))
                let values = sessions.filter { s in payload.contains { $0.id == s.id } }
                localRecords.insert(UploadRecord(id: package.id, time: "刚刚", kind: "周期会话包", projectsAndAgents: Array(Set(values.map { projectName($0.projectID) })).sorted().joined(separator: "、"), content: "\(package.sessionCount) 个完整会话", status: .queued, details: [period.periodKey, "完整会话包 · \(package.parts.count) 个分包"], createdAt: .now, projects: summaries(for: values)), at: 0)
                uploadRecords = localRecords; persist()
            }
            activeID = package.id; uploadProgress = 0; uploadTotal = package.sessionCount
            recordCollectorLog("upload", "UPLOAD_STARTED", uploadID: package.id, details: .forPackage(package))
            await flushCollectorLogs()
            try await collectorService.upload(binding: binding, package: package)
            for bytes in package.parts {
                for item in try CollectorJSON.decoder().decode([CollectorSession].self, from: bytes) {
                    uploadCheckpoints[item.id] = UploadCheckpoint(turns: item.turns)
                    if let index = sessions.firstIndex(where: { $0.id == item.id }) {
                        sessions[index].uploaded = uploadCheckpoints[item.id]?.pendingMessages(in: sessions[index].turns, hiding: hiding).isEmpty == true
                    }
                }
            }
            if let index = localRecords.firstIndex(where: { $0.id == package.id }) { localRecords[index].status = .complete; localRecords[index].errorMessage = nil }
            uploadProgress = uploadTotal; uploadRecords = localRecords; persist()
            try FileManager.default.removeItem(at: outbox)
            recordCollectorLog("upload", "UPLOAD_COMPLETED", uploadID: package.id, details: .forPackage(package))
            uploadNotice = "系统已确认接收本次上传的 \(package.sessionCount) 个完整会话。"
        } catch {
            handleCollectorError(error)
            if let index = localRecords.firstIndex(where: { $0.id == activeID }) { localRecords[index].status = .failed; localRecords[index].errorMessage = error.localizedDescription }
            uploadRecords = localRecords
            let code: String
            if error is URLError { code = "UPLOAD_NETWORK_FAILED" }
            else if (error as? CollectorError)?.status == 401 { code = "UPLOAD_AUTH_FAILED" }
            else if (error as? CollectorError)?.status == 409 { code = "UPLOAD_POLICY_CHANGED" }
            else if (error as? CollectorError)?.status == 413 { code = "UPLOAD_TOO_LARGE" }
            else if let status = (error as? CollectorError)?.status, status >= 500 { code = "UPLOAD_SERVER_FAILED" }
            else if (error as NSError).domain == NSCocoaErrorDomain { code = "UPLOAD_STORAGE_FAILED" }
            else { code = "UPLOAD_FAILED" }
            recordCollectorLog("upload", code, level: "error", uploadID: activeID, details: .failure(error))
            persist()
        }
        await flushCollectorLogs()
    }
}
