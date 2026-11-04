import XCTest
import Combine
@testable import WeeklyReportCore

private actor FakeCollector: CollectorServing {
    var current = CollectorPolicy(version: 1, entries: [], currentPeriod: .init(periodKey: "test-period", startsAt: Date.now.addingTimeInterval(-86400), endsAt: Date.now.addingTimeInterval(86400)))
    var packages: [CollectorPackage] = []
    var events: [CollectorLog] = []
    var claimedBindings: [LocalBinding] = []
    var failLogs = false
    var failUploads = false
    var messages: [AppMessage] = []
    var syncedState = CollectorSyncState.empty
    func setSyncState(_ value: CollectorSyncState) { syncedState = value }
    func syncState(binding: LocalBinding) async throws -> CollectorSyncState { syncedState }
    var receipts: [String] = []
    var failReceipts = false
    var failPolicy = false
    var policyDelay = false
    var registeredKeys: [String] = []
    var failRegistrations = false
    func setRegistrationFailure(_ value: Bool) { failRegistrations = value }
    func setPolicyFailure(_ value: Bool) { failPolicy = value }
    func setPolicyDelay(_ value: Bool) { policyDelay = value }
    func setMessages(_ value: [AppMessage]) { messages = value }
    func setReceiptFailure(_ value: Bool) { failReceipts = value }
    func notifications(binding: LocalBinding) async throws -> [AppMessage] { messages.filter { !receipts.contains($0.id) } }
    func acknowledgeNotifications(binding: LocalBinding, ids: [String]) async throws {
        if failReceipts { throw URLError(.notConnectedToInternet) }
        receipts += ids
    }
    func setEntries(_ entries: [CollectorPolicy.Entry]) { current.entries = entries }
    func setLogFailure(_ value: Bool) { failLogs = value }
    func setUploadFailure(_ value: Bool) { failUploads = value }
    func claim(binding: LocalBinding, code: String) async throws -> CollectorClaim {
        guard binding.name == "Member", code == "TEST-CODE" else { throw CollectorError(status: 400, message: "名字或绑定码不匹配。") }
        claimedBindings.append(binding)
        return CollectorClaim(deviceId: "device", name: "Member", policy: current)
    }
    func policy(binding: LocalBinding) async throws -> CollectorPolicy {
        if policyDelay { try await Task.sleep(for: .milliseconds(100)) }
        if failPolicy { throw URLError(.notConnectedToInternet) }
        return current
    }
    func decide(binding: LocalBinding, version: Int, scopeKey: String, permission: ProjectPermission) async throws -> CollectorPolicy {
        guard version == current.version else { throw CollectorError(status: 409, message: "Conflict") }
        current.entries[current.entries.firstIndex { $0.scopeKey == scopeKey }!].status = permission
        current.version += 1
        return current
    }
    func register(binding: LocalBinding, scopeKey: String, name: String, periodKey: String, sessionCount: Int) async throws -> CollectorPolicy {
        if failRegistrations { throw URLError(.notConnectedToInternet) }
        registeredKeys.append(scopeKey)
        messages.append(AppMessage(id: UUID().uuidString, kind: "project_scope.candidates.changed", title: "新项目采集审批", body: "发现新项目，请确认是否允许采集会话。", targetType: "projects", targetId: nil, createdAt: .now))
        current.entries.append(.init(scopeKey: scopeKey, displayName: name, status: .pending)); current.version += 1; return current
    }
    func upload(binding: LocalBinding, package: CollectorPackage) async throws {
        packages.append(package)
        if failUploads { throw URLError(.notConnectedToInternet) }
    }
    func logs(binding: LocalBinding, events: [CollectorLog]) async throws {
        if failLogs { throw URLError(.notConnectedToInternet) }
        self.events += events
    }
}

private actor QuestionOnlyReader: LocalSessionReading {
    var calls = 0
    func read(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession {
        calls += 1
        return ReadSession(turns: [.init(id: "question", prompt: "A complete question-only session", answer: nil, questionTime: "12:00")], warnings: [])
    }
}

@MainActor
final class CollectorTests: XCTestCase {
    private let binding = LocalBinding(serviceAddress: "https://company.example", name: "Member")
    func testConfiguredServiceURLBindsWithoutEnteringAddressAndOverridesCandidateAddress() async throws {
        let service = FakeCollector()
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:4314"))
        let store = AppStore(live: true, collectorService: service, serviceURL: url)
        XCTAssertEqual(store.binding.serviceAddress, url.absoluteString)
        XCTAssertEqual(store.startupStage, .binding)
        await store.bindCollector(LocalBinding(name: "Member"), code: "TEST-CODE")
        XCTAssertTrue(store.binding.isBound)
        await store.bindCollector(binding, code: "TEST-CODE")
        let claims = await service.claimedBindings
        XCTAssertEqual(claims.map(\.serviceAddress), [url.absoluteString, url.absoluteString])
        XCTAssertEqual(store.binding.serviceAddress, url.absoluteString)
        XCTAssertEqual(store.startupStage, .permissions)
    }

    func testConfiguredServiceURLPreservesMatchingBindingAndRequiresRebindingAfterDeploymentChange() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "deployment-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let state = home.appending(path: "state.json")
        let service = FakeCollector()
        let originalURL = try XCTUnwrap(URL(string: binding.serviceAddress))
        let store = AppStore(stateURL: state, live: true, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")

        let same = AppStore(stateURL: state, live: true, collectorService: service, serviceURL: originalURL)
        XCTAssertEqual(same.binding, store.binding)
        XCTAssertTrue(same.binding.isBound)

        let localURL = try XCTUnwrap(URL(string: "http://127.0.0.1:4314"))
        let changed = AppStore(stateURL: state, live: true, collectorService: service, serviceURL: localURL)
        XCTAssertEqual(changed.binding.serviceAddress, localURL.absoluteString)
        XCTAssertEqual(changed.binding.name, "Member")
        XCTAssertFalse(changed.binding.isBound)
        XCTAssertNil(changed.binding.deviceID)
        XCTAssertNil(changed.collectorPolicy)
        XCTAssertFalse(changed.isReviewSignedIn)
        XCTAssertEqual(changed.startupStage, .binding)
    }

    func testNotificationPermissionIsReportedWithoutAcknowledgingQueuedMessages() async throws {
        let service = FakeCollector()
        let message = AppMessage(id: UUID().uuidString, kind: "test", title: "Title", body: "Body", targetType: "app", targetId: nil, createdAt: .now)
        await service.setMessages([message])
        let store = AppStore(live: true, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        await store.refreshAppNotifications()
        await store.reportNotificationPermission(.denied)
        await store.reportNotificationPermission(.denied)
        await store.reportNotificationPermission(.allowed)
        let events = await service.events.filter { $0.stage == "notification" }
        XCTAssertEqual(events.map(\.code), ["NOTIFICATIONS_DENIED", "NOTIFICATIONS_ALLOWED"])
        XCTAssertEqual(events.map(\.level), ["warning", "info"])
        let receipts = await service.receipts
        XCTAssertTrue(receipts.isEmpty)
        XCTAssertEqual(store.appMessages, [message])
    }
    func testNotificationsAreNotAcknowledgedByFetchingAndFailedReceiptsSurviveRestart() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "notification-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let service = FakeCollector()
        let message = AppMessage(id: UUID().uuidString, kind: "test", title: "Title", body: "Body", targetType: "app", targetId: nil, createdAt: .now)
        await service.setMessages([message])
        let state = home.appending(path: "state.json")
        let store = AppStore(stateURL: state, live: true, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        await store.refreshAppNotifications()
        XCTAssertEqual(store.appMessages, [message])
        var receipts = await service.receipts
        XCTAssertTrue(receipts.isEmpty)
        store.markAppMessageDelivered(message)
        await service.setReceiptFailure(true)
        await store.refreshAppNotifications()
        XCTAssertNotNil(store.notificationError)
        let next = AppStore(stateURL: state, live: true, collectorService: service)
        await service.setReceiptFailure(false)
        await next.refreshAppNotifications()
        receipts = await service.receipts
        XCTAssertEqual(receipts, [message.id])
        XCTAssertTrue(next.appMessages.isEmpty)
        XCTAssertNil(next.notificationError)
    }
    func testBindingThenPermissionsThenOneMonthScanAndRestart() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "collector-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let service = FakeCollector()
        let state = home.appending(path: "app/state.json")
        let store = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        XCTAssertEqual(store.startupStage, .binding)
        await store.startInitialScan()
        XCTAssertNil(store.lastDiscoveredAt)
        await store.bindCollector(binding, code: "WRONG-CODE")
        XCTAssertFalse(store.binding.isBound)
        XCTAssertEqual(store.startupStage, .binding)
        await store.bindCollector(binding, code: "TEST-CODE")
        XCTAssertEqual(store.startupStage, .permissions)
        XCTAssertTrue(store.projects.isEmpty)
        XCTAssertNil(store.lastDiscoveredAt)
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        XCTAssertEqual(store.startupStage, .welcome)
        await store.startInitialScan()
        XCTAssertEqual(store.startupStage, .ready)
        XCTAssertNotNil(store.scanWindow)
        XCTAssertTrue(store.sessions.isEmpty)
        let next = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        XCTAssertEqual(next.startupStage, .ready)
        XCTAssertEqual(next.binding.name, "Member")
    }
    func testExistingPolicyDoesNotGrantUnrelatedLocalFolderByName() async throws {
        let service = FakeCollector()
        let key = String(repeating: "a", count: 64)
        await service.setEntries([.init(scopeKey: key, displayName: "project", status: .allowed), .init(scopeKey: String(repeating: "b", count: 64), displayName: "denied", status: .denied)])
        let store = AppStore(live: true, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        XCTAssertEqual(store.projects.count, 2)
        XCTAssertEqual(store.approvedProjects.first?.folder, "")
        let id = try XCTUnwrap(store.approvedProjects.first?.id)
        try store.locateCollectorProject(id, folder: "/tmp/explicit-project")
        XCTAssertEqual(store.approvedProjects.first?.folder, AppStore.normalizedFolder("/tmp/explicit-project"))
        let success = await store.synchronizePermission(id, permission: .denied)
        XCTAssertTrue(success)
        XCTAssertTrue(store.approvedProjects.isEmpty)
        XCTAssertEqual(store.collectorPolicy?.version, 2)
    }
    func testRebindingRestoresUploadHistoryAndMessageCheckpointsFromTheSystem() async throws {
        let service = FakeCollector()
        let key = String(repeating: "a", count: 64)
        await service.setEntries([.init(scopeKey: key, displayName: "Atlas", status: .allowed)])
        let uploaded = ChatTurn(id: "t", prompt: "question", answer: "answer", questionTime: "12:00")
        let completed = Date.now.addingTimeInterval(-3600)
        await service.setSyncState(CollectorSyncState(
            sessions: [.init(id: "session", messages: UploadCheckpoint(turns: [uploaded]).messages)],
            uploads: [.init(id: "upload", periodKey: "2026-W45", sessionCount: 3, completedAt: completed, createdAt: completed, projects: [.init(scopeKey: key, sessionCount: 3, messageCount: 12)])]))
        let store = AppStore(live: true, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        let record = try XCTUnwrap(store.uploadRecords.first)
        XCTAssertEqual([record.id, record.status.rawValue, record.projectsAndAgents], ["upload", "complete", "Atlas"])
        XCTAssertEqual(record.messageCount, 12)
        let checkpoint = try XCTUnwrap(store.uploadCheckpoints["session"])
        XCTAssertTrue(checkpoint.pendingMessages(in: [uploaded]).isEmpty)
        var edited = uploaded; edited.answer = "a new answer"
        XCTAssertEqual(checkpoint.pendingMessages(in: [edited]).map(\.id), ["t:answer"])
    }
    func testRebindingStillSucceedsWhenTheSystemHasNoStateToReturn() async throws {
        let store = AppStore(live: true, collectorService: FakeCollector())
        await store.bindCollector(binding, code: "TEST-CODE")
        XCTAssertTrue(store.binding.isBound)
        XCTAssertTrue(store.uploadRecords.isEmpty)
        XCTAssertTrue(store.uploadCheckpoints.isEmpty)
    }
    func testBackgroundResumeKeepsBindingAndDoesNotBypassFirstScanConsent() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "background-resume-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let state = home.appending(path: "app/state.json"), service = FakeCollector()
        let first = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await first.bindCollector(binding, code: "TEST-CODE")
        await first.resumeSavedCollection()
        XCTAssertEqual(first.startupStage, .permissions)
        _ = await first.prepareCollectorPermissions()
        first.confirmCollectorPermissions()
        await first.resumeSavedCollection()
        XCTAssertEqual(first.startupStage, .welcome)
        XCTAssertNil(first.scanWindow)
        await first.startInitialScan()
        let identity = first.binding
        // Model an interrupted import from its existing persisted scan window.
        var saved = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: state)) as? [String: Any])
        saved["initialScanCompleted"] = false
        try JSONSerialization.data(withJSONObject: saved).write(to: state, options: .atomic)
        let next = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        XCTAssertEqual(next.startupStage, .welcome)
        await next.resumeSavedCollection()
        XCTAssertEqual(next.startupStage, .ready)
        XCTAssertEqual(next.binding, identity)
        XCTAssertEqual(next.scanWindow, first.scanWindow)
    }
    func testLogsSurviveRestartAndRetryWithoutSessionText() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "collector-logs-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let state = home.appending(path: "state.json")
        let service = FakeCollector(); await service.setLogFailure(true)
        let first = AppStore(stateURL: state, live: true, collectorService: service)
        await first.bindCollector(binding, code: "TEST-CODE")
        XCTAssertNotNil(first.logUploadError)
        let next = AppStore(stateURL: state, live: true, collectorService: service)
        await service.setLogFailure(false)
        await next.flushCollectorLogs()
        let events = await service.events
        XCTAssertEqual(events.map(\.code), ["BOUND", "APP_LAUNCHED"])
        XCTAssertEqual(events.first?.stage, "binding")
        XCTAssertEqual(events.last?.stage, "app")
        XCTAssertNotNil(events.last?.details?.appVersion)
        XCTAssertNotNil(events.last?.details?.osVersion)
        XCTAssertNil(next.logUploadError)
    }
    func testFullSessionPackageRetainsQuestionsAndAllTurnsAndHasStableChecksums() throws {
        let now = Date.now
        let period = CollectorPolicy.Period(periodKey: "test", startsAt: now.addingTimeInterval(-100), endsAt: now.addingTimeInterval(100))
        let question = ChatTurn(id: "q", prompt: "Question only", answer: nil, questionTime: "12:00")
        let session = CollectorSession(id: "session", scopeKey: String(repeating: "a", count: 64), agent: .codex, title: "Title", modifiedAt: now, turns: [question])
        let package = try CollectorPackage(period: period, start: now, end: now, version: 2, sessions: [session, .init(id: "second", scopeKey: session.scopeKey, agent: .claude, title: "Other", modifiedAt: now, turns: [question])], targetBytes: 1)
        XCTAssertEqual(package.parts.count, 2)
        XCTAssertEqual(package.sessionCount, 2)
        XCTAssertEqual(package.partDigests, package.parts.map(CollectorPackage.digest))
        let decoded = try CollectorJSON.decoder().decode([CollectorSession].self, from: package.parts[0])
        XCTAssertEqual(decoded[0].turns, [question])
        let roundtrip = try CollectorJSON.decoder().decode(CollectorPackage.self, from: CollectorJSON.encoder().encode(package))
        XCTAssertEqual(roundtrip.parts, package.parts)
    }
    func testExcludedSessionIsNeverUploadedEvenWhenAlreadyQueuedAndComesBackWhenRestored() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "collector-exclude-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let root = home.appending(path: "project")
        let source = home.appending(path: ".claude/projects/test/session.jsonl")
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let metadata: [String: Any] = ["type": "user", "sessionId": "session", "cwd": root.path, "message": ["role": "user", "content": "fixture question"]]
        try JSONSerialization.data(withJSONObject: metadata).write(to: source)
        let state = home.appending(path: "app/state.json")
        let outbox = state.deletingLastPathComponent().appending(path: "collector-outbox.json")
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let store = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        try store.registerProject(name: "Project", folder: root.path)
        let projectID = try XCTUnwrap(store.projects.first?.id)
        let approved = await store.synchronizePermission(projectID, permission: .allowed)
        XCTAssertTrue(approved)
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        let session = try XCTUnwrap(store.sessions.first)
        XCTAssertEqual(store.uploadState(of: session), .pending)

        // A failed upload leaves the session queued in the outbox.
        await service.setUploadFailure(true)
        await store.runLocalUpload()
        XCTAssertTrue(FileManager.default.fileExists(atPath: outbox.path))
        let attempts = await service.packages.count

        // Excluding it afterwards must also remove it from that queued package.
        store.setUploadExcluded(true, for: session.id)
        XCTAssertEqual(store.uploadState(of: session), .excluded)
        XCTAssertTrue(store.pendingSessions.isEmpty)
        await service.setUploadFailure(false)
        await store.runLocalUpload()
        let afterExclusion = await service.packages
        XCTAssertEqual(afterExclusion.count, attempts, "an excluded session must not be sent")
        XCTAssertFalse(FileManager.default.fileExists(atPath: outbox.path))
        XCTAssertEqual(store.uploadNotice, "距离上次上传后没有新的或更新的会话，无需上传。")
        XCTAssertTrue(store.uploadRecords.first?.errorMessage?.contains("不上传") == true)

        // The choice survives a restart.
        let relaunched = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        XCTAssertTrue(relaunched.uploadExcludedSessionIDs.contains(session.id))

        // Restoring it makes the next upload carry the session again.
        relaunched.setUploadExcluded(false, for: session.id)
        await relaunched.runLocalUpload()
        let afterRestore = await service.packages
        XCTAssertEqual(afterRestore.count, attempts + 1)
        let sent = try CollectorJSON.decoder().decode([CollectorSession].self, from: try XCTUnwrap(afterRestore.last?.parts.first))
        XCTAssertEqual(sent.map(\.id), [session.id])
    }
    func testMarkedTermIsHiddenInTheNextUploadEvenForAnAlreadyUploadedSessionAndSurvivesRestartAndRebinding() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "collector-hide-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let root = home.appending(path: "project")
        let source = home.appending(path: ".claude/projects/test/session.jsonl")
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let metadata: [String: Any] = ["type": "user", "sessionId": "session", "cwd": root.path, "message": ["role": "user", "content": "fixture question"]]
        try JSONSerialization.data(withJSONObject: metadata).write(to: source)
        let state = home.appending(path: "app/state.json")
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let store = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        try store.registerProject(name: "Project", folder: root.path)
        let projectID = try XCTUnwrap(store.projects.first?.id)
        _ = await store.synchronizePermission(projectID, permission: .allowed)
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        await store.runLocalUpload()
        let session = try XCTUnwrap(store.sessions.first)
        XCTAssertEqual(store.uploadState(of: session), .uploaded)

        // Marking text that is part of the already-uploaded conversation makes it pending again.
        store.hideTerm("complete question")
        store.hideTerm("x")
        XCTAssertEqual(store.hiddenTerms, ["complete question"])
        XCTAssertEqual(store.uploadState(of: try XCTUnwrap(store.sessions.first)), .pending)
        let before = await service.packages.count
        await store.runLocalUpload()
        let packages = await service.packages
        XCTAssertEqual(packages.count, before + 1)
        let sent = try CollectorJSON.decoder().decode([CollectorSession].self, from: try XCTUnwrap(packages.last?.parts.first))
        XCTAssertEqual(sent.first?.turns.first?.prompt, "A [已隐藏]-only session")
        XCTAssertEqual(store.uploadState(of: try XCTUnwrap(store.sessions.first)), .uploaded)

        // Taking back an automatic red uploads the original next time and tells the server not to hide it again.
        store.revealTerm("complete question")
        XCTAssertTrue(store.hiddenTerms.isEmpty)
        XCTAssertEqual(store.allowedTerms, ["complete question"])
        store.restoreAutomatic("complete question")
        XCTAssertTrue(store.allowedTerms.isEmpty)
        store.hideTerm("complete question")

        // The marks survive a restart and a new binding.
        let relaunched = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        XCTAssertEqual(relaunched.hiddenTerms, ["complete question"])
        await relaunched.bindCollector(binding, code: "TEST-CODE")
        XCTAssertEqual(relaunched.hiddenTerms, ["complete question"])
        relaunched.unhideTerm("complete question")
        XCTAssertTrue(relaunched.hiddenTerms.isEmpty)
    }
    func testOldEmailConfigurationDoesNotCountAsAuthenticatedBinding() throws {
        let value = try JSONDecoder().decode(LocalBinding.self, from: Data(#"{"serviceAddress":"https://company.example","workEmail":"old@example.com","savedAt":0}"#.utf8))
        XCTAssertEqual(value.name, "")
        XCTAssertFalse(value.isBound)
        XCTAssertFalse(LocalBinding(serviceAddress: "http://company.example", name: "Member").isValid)
        XCTAssertTrue(LocalBinding(serviceAddress: "http://127.0.0.1:4310", name: "Member").isValid)
    }
    func testFailedWholeSessionUploadSurvivesRestartAndRetriesSamePackage() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "collector-upload-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let root = home.appending(path: "project")
        let source = home.appending(path: ".claude/projects/test/session.jsonl")
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let metadata: [String: Any] = ["type": "user", "sessionId": "session", "cwd": root.path, "message": ["role": "user", "content": "fixture question"]]
        try JSONSerialization.data(withJSONObject: metadata).write(to: source)
        let state = home.appending(path: "app/state.json")
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let store = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        try store.registerProject(name: "Project", folder: root.path)
        let projectID = try XCTUnwrap(store.projects.first?.id)
        let approved = await store.synchronizePermission(projectID, permission: .allowed)
        XCTAssertTrue(approved)
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        XCTAssertEqual(store.startupStage, .ready)
        XCTAssertEqual(store.sessions.count, 1)
        XCTAssertFalse(try XCTUnwrap(store.sessions.first).hasModelReply)
        await service.setUploadFailure(true)
        await store.runLocalUpload()
        XCTAssertFalse(try XCTUnwrap(store.sessions.first).uploaded)
        XCTAssertEqual(store.uploadRecords.first?.status, .failed)
        let outbox = state.deletingLastPathComponent().appending(path: "collector-outbox.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: outbox.path))
        let package = try CollectorJSON.decoder().decode(CollectorPackage.self, from: Data(contentsOf: outbox))
        let next = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await service.setUploadFailure(false)
        await next.runLocalUpload()
        XCTAssertFalse(FileManager.default.fileExists(atPath: outbox.path))
        XCTAssertEqual(next.uploadRecords.first?.status, .complete)
        XCTAssertEqual(next.uploadNotice, "系统已确认接收本次上传的 1 个完整会话。")
        XCTAssertTrue(try XCTUnwrap(next.sessions.first).uploaded)
        var uploads = await service.packages
        XCTAssertEqual(uploads.map(\.id), [package.id, package.id])
        XCTAssertEqual(uploads[0].parts, uploads[1].parts)
        // Nothing changed since the receipt: no new package, an explicit notice instead.
        await next.runLocalUpload()
        uploads = await service.packages
        XCTAssertEqual(uploads.count, 2)
        XCTAssertNotNil(next.uploadNotice)
        XCTAssertNil(next.connectionError)
    }

    private func projectFixture(_ names: [String]) throws -> (URL, [URL]) {
        let home = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appending(path: "collector-project-test-\(UUID())")
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        var roots: [URL] = []
        for (index, name) in names.enumerated() {
            let root = home.appending(path: "work/\(index)/\(name)").resolvingSymlinksInPath()
            try FileManager.default.createDirectory(at: root.appending(path: ".git"), withIntermediateDirectories: true)
            let source = home.appending(path: ".claude/projects/fixture/\(index).jsonl")
            try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
            let header: [String: Any] = ["type": "user", "sessionId": "fixture-\(index)", "cwd": root.path]
            var data = try JSONSerialization.data(withJSONObject: header); data.append(10)
            data.append(Data("INVALID_BODY_MUST_NOT_BE_READ\n".utf8))
            try data.write(to: source)
            roots.append(root)
        }
        return (home, roots)
    }

    private func addRuntimeProject(in home: URL, name: String) throws -> URL {
        let root = home.appending(path: "work/runtime/\(name)").resolvingSymlinksInPath()
        let source = home.appending(path: ".claude/projects/fixture/runtime-\(name).jsonl")
        try FileManager.default.createDirectory(at: root.appending(path: ".git"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        let header: [String: Any] = ["type": "user", "sessionId": "runtime-\(name)", "cwd": root.path]
        var data = try JSONSerialization.data(withJSONObject: header); data.append(10)
        data.append(Data("INVALID_BODY_MUST_NOT_BE_READ\n".utf8))
        try data.write(to: source)
        return root
    }

    func testRuntimeDiscoveryRegistersNewProjectAndFetchesApprovalNoticeOnlyOnce() async throws {
        let (home, _) = try projectFixture([])
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let store = AppStore(stateURL: home.appending(path: "app/state.json"), live: true, reader: reader,
                             discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        XCTAssertEqual(store.startupStage, .ready)
        let root = try addRuntimeProject(in: home, name: "new-project")
        let key = CollectorPackage.digest(Data(("collector-root:" + root.path).utf8))
        await store.synchronizeCollector()
        XCTAssertEqual(store.pendingProjects.first?.scopeKey, key)
        XCTAssertEqual(store.collectorPolicy?.entries.first?.status, .pending)
        XCTAssertEqual(store.appMessages.map(\.kind), ["project_scope.candidates.changed"])
        let message = try XCTUnwrap(store.appMessages.first)
        store.markAppMessageDelivered(message)
        await store.refreshAppNotifications()
        await store.synchronizeCollector()
        let registered = await service.registeredKeys
        let calls = await reader.calls
        XCTAssertEqual(registered, [key])
        XCTAssertEqual(calls, 0)
        XCTAssertTrue(store.appMessages.isEmpty)
        XCTAssertTrue(store.sessions.isEmpty)
        store.openAppMessage(type: message.targetType, targetID: message.targetId)
        XCTAssertEqual(store.page, .approvals)
    }

    func testFailedRuntimeProjectRegistrationRetriesAfterRestart() async throws {
        let (home, _) = try projectFixture([])
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let state = home.appending(path: "app/state.json")
        let store = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home,
                             discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        let root = try addRuntimeProject(in: home, name: "retry-project")
        let key = CollectorPackage.digest(Data(("collector-root:" + root.path).utf8))
        await service.setRegistrationFailure(true)
        await store.synchronizeCollector()
        XCTAssertEqual(store.pendingProjects.first?.scopeKey, key)
        XCTAssertNotNil(store.connectionError)
        XCTAssertTrue(store.appMessages.isEmpty)
        await service.setRegistrationFailure(false)
        let next = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home,
                            discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await next.synchronizeCollector()
        let registered = await service.registeredKeys
        let calls = await reader.calls
        XCTAssertEqual(registered, [key])
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(next.appMessages.map(\.kind), ["project_scope.candidates.changed"])
    }

    func testUploadUsesPolicyVersionAfterDiscoveringNewPendingProject() async throws {
        let (home, roots) = try projectFixture(["allowed-project"])
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let key = CollectorPackage.digest(Data(("collector-root:" + roots[0].path).utf8))
        await service.setEntries([.init(scopeKey: key, displayName: "Allowed", status: .allowed)])
        let store = AppStore(stateURL: home.appending(path: "app/state.json"), live: true, reader: reader,
                             discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        _ = try addRuntimeProject(in: home, name: "pending-project")
        await store.runLocalUpload()
        let packages = await service.packages
        let package = try XCTUnwrap(packages.first)
        XCTAssertEqual(package.policyVersion, store.collectorPolicy?.version)
        XCTAssertEqual(package.policyVersion, 2)
        XCTAssertEqual(package.sessionCount, 1)
        let sessions = try package.parts.flatMap { try CollectorJSON.decoder().decode([CollectorSession].self, from: $0) }
        XCTAssertEqual(sessions.map(\.scopeKey), [key])
        XCTAssertEqual(store.pendingProjects.count, 1)
    }

    func testCachedClaudeTitleRefreshesAfterTranscriptOrIndexChanges() async throws {
        let (home, roots) = try projectFixture(["project"])
        let file = home.appending(path: ".claude/projects/fixture/0.jsonl")
        let header = try JSONSerialization.data(withJSONObject: ["sessionId": "fixture-0", "cwd": roots[0].path])
        var transcript = header; transcript.append(10)
        transcript.append(Data("{\"type\":\"custom-title\",\"customTitle\":\"first title\"}\n".utf8))
        try transcript.write(to: file)
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let key = CollectorPackage.digest(Data(("collector-root:" + roots[0].path).utf8))
        await service.setEntries([.init(scopeKey: key, displayName: "Project", status: .allowed)])
        let store = AppStore(stateURL: home.appending(path: "app/state.json"), live: true, reader: reader,
                             discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        XCTAssertEqual(store.sessions.first?.title, "first title")
        try Data(String(decoding: transcript, as: UTF8.self).replacingOccurrences(of: "first title", with: "other title").utf8).write(to: file)
        await store.refreshAuthorizedTitles()
        XCTAssertEqual(store.sessions.first?.title, "other title")
        try header.write(to: file)
        let index = file.deletingLastPathComponent().appending(path: "sessions-index.json")
        try JSONSerialization.data(withJSONObject: ["entries": [["sessionId": "fixture-0", "summary": "index old"]]]).write(to: index)
        await store.refreshAuthorizedTitles()
        XCTAssertEqual(store.sessions.first?.title, "index old")
        try JSONSerialization.data(withJSONObject: ["entries": [["sessionId": "fixture-0", "summary": "index new"]]]).write(to: index)
        await store.refreshAuthorizedTitles()
        XCTAssertEqual(store.sessions.first?.title, "index new")
    }

    func testManualUploadExplainsWhyOnboardingBlocksUpload() async throws {
        let service = FakeCollector()
        let store = AppStore(live: true, collectorService: service)
        await store.runLocalUpload()
        XCTAssertEqual(store.uploadNotice, "请先绑定系统后再上传。")
        await store.bindCollector(binding, code: "TEST-CODE")
        await store.runLocalUpload()
        XCTAssertEqual(store.uploadNotice, "请先完成项目授权和首次扫描后再上传。")
        let uploads = await service.packages
        XCTAssertTrue(uploads.isEmpty)
        XCTAssertFalse(store.isPreparingUpload)
    }

    func testManualUploadWaitsForBackgroundDiscoveryInsteadOfDroppingClick() async throws {
        let (home, roots) = try projectFixture(["project"])
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let key = CollectorPackage.digest(Data(("collector-root:" + roots[0].path).utf8))
        await service.setEntries([.init(scopeKey: key, displayName: "Project", status: .allowed)])
        let store = AppStore(stateURL: home.appending(path: "app/state.json"), live: true, reader: reader,
                             discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        XCTAssertEqual(store.startupStage, .ready)
        let refresh = Task { await store.refreshDiscovery() }
        for _ in 0..<100 where !store.isDiscovering { await Task.yield() }
        XCTAssertTrue(store.isDiscovering)
        await store.runLocalUpload()
        await refresh.value
        let uploads = await service.packages
        XCTAssertEqual(uploads.count, 1)
        XCTAssertEqual(store.uploadRecords.first?.status, .complete)
        XCTAssertEqual(store.uploadNotice, "系统已确认接收本次上传的 1 个完整会话。")
        XCTAssertFalse(store.isPreparingUpload)
        XCTAssertFalse(store.isUploading)
    }

    func testUnchangedPolicyDoesNotRebuildProjectsOrSessions() async throws {
        let (home, roots) = try projectFixture(["project"])
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let key = CollectorPackage.digest(Data(("collector-root:" + roots[0].path).utf8))
        await service.setEntries([.init(scopeKey: key, displayName: "Project", status: .allowed)])
        let store = AppStore(stateURL: home.appending(path: "app/state.json"), live: true, reader: reader,
                             discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        _ = await store.prepareCollectorPermissions()
        store.confirmCollectorPermissions()
        await store.startInitialScan()
        let sessions = store.sessions
        var projectChanges = 0, sessionChanges = 0
        let projects = store.$projects.dropFirst().sink { _ in projectChanges += 1 }
        let conversations = store.$sessions.dropFirst().sink { _ in sessionChanges += 1 }
        let refreshed = await store.refreshCollectorPolicy()
        XCTAssertTrue(refreshed)
        XCTAssertEqual(projectChanges, 0)
        XCTAssertEqual(sessionChanges, 0)
        XCTAssertEqual(store.sessions, sessions)
        withExtendedLifetime((projects, conversations)) {}
    }

    func testProjectDiscoveryMatchesHistoricalKeysAndRegistersSameNameAsPendingWithoutReadingBodies() async throws {
        let (home, roots) = try projectFixture(["project", "project", "denied"])
        let key = { (root: URL) in CollectorPackage.digest(Data(("collector-root:" + root.path).utf8)) }
        let service = FakeCollector(), reader = QuestionOnlyReader()
        let remoteKey = String(repeating: "b", count: 64)
        await service.setEntries([
            .init(scopeKey: key(roots[0]), displayName: "project", status: .allowed),
            .init(scopeKey: key(roots[2]), displayName: "denied", status: .denied),
            .init(scopeKey: remoteKey, displayName: "another-machine", status: .allowed),
        ])
        let state = home.appending(path: "app/state.json")
        let store = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        XCTAssertFalse(store.canConfirmCollectorPermissions)
        let success = await store.prepareCollectorPermissions()
        XCTAssertTrue(success)
        XCTAssertTrue(store.canConfirmCollectorPermissions)
        XCTAssertEqual(store.projects.count, 4)
        XCTAssertEqual(store.projects.first { $0.scopeKey == key(roots[0]) }?.folder, roots[0].path)
        XCTAssertEqual(store.projects.first { $0.scopeKey == key(roots[0]) }?.permission, .allowed)
        XCTAssertEqual(store.projects.first { $0.scopeKey == key(roots[1]) }?.permission, .pending)
        XCTAssertEqual(store.projects.first { $0.scopeKey == key(roots[2]) }?.permission, .denied)
        XCTAssertEqual(store.projects.first { $0.scopeKey == remoteKey }?.folder, "")
        await store.loadSelectedSession()
        let calls = await reader.calls
        XCTAssertEqual(calls, 0)
        XCTAssertTrue(store.sessions.allSatisfy { $0.turns.isEmpty })
        XCTAssertNil(store.scanWindow)
        let registered = await service.registeredKeys
        XCTAssertEqual(registered, [key(roots[1])])
        _ = await store.prepareCollectorPermissions()
        let registeredAgain = await service.registeredKeys
        XCTAssertEqual(registeredAgain, registered)
        let next = AppStore(stateURL: state, live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        XCTAssertEqual(next.startupStage, .permissions)
        _ = await next.prepareCollectorPermissions()
        XCTAssertEqual(next.projects.count, 4)
        // An allowed project from another machine must not block this machine's onboarding.
        next.confirmCollectorPermissions()
        XCTAssertEqual(next.startupStage, .welcome)
    }

    func testProjectRefreshShowsBusyStateAndFailureCanBeRetried() async throws {
        let (home, roots) = try projectFixture(["new-project"])
        let service = FakeCollector()
        let store = AppStore(live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        await service.setPolicyDelay(true)
        let refresh = Task { await store.prepareCollectorPermissions() }
        for _ in 0..<100 where !store.isPreparingProjects { await Task.yield() }
        XCTAssertTrue(store.isPreparingProjects)
        XCTAssertFalse(store.canConfirmCollectorPermissions)
        let duplicate = await store.prepareCollectorPermissions()
        XCTAssertFalse(duplicate)
        let success = await refresh.value
        XCTAssertTrue(success)
        XCTAssertFalse(store.isPreparingProjects)
        XCTAssertNotNil(store.lastProjectPreparationAt)
        XCTAssertEqual(store.projects.first?.folder, roots[0].path)
        await service.setPolicyFailure(true)
        let failed = await store.prepareCollectorPermissions()
        XCTAssertFalse(failed)
        XCTAssertFalse(store.isPreparingProjects)
        XCTAssertNotNil(store.connectionError)
        XCTAssertFalse(store.canConfirmCollectorPermissions)
        await service.setPolicyFailure(false)
        let retried = await store.prepareCollectorPermissions()
        XCTAssertTrue(retried)
        XCTAssertNil(store.connectionError)
        XCTAssertTrue(store.canConfirmCollectorPermissions)
    }

    // MARK: Log details

    private func wireJSON(_ log: CollectorLog) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: CollectorJSON.encoder().encode(["events": [log]])) as? [String: Any])
    }
    private func wireDetails(_ log: CollectorLog) throws -> [String: Any] {
        let events = try XCTUnwrap(wireJSON(log)["events"] as? [[String: Any]])
        return try XCTUnwrap(events.first?["details"] as? [String: Any])
    }
    /// Keys of `collectorLogDetailsSchema` (apps/api/src/collector-contracts.ts), which is `.strict()`.
    private let serverDetailKeys: Set<String> = ["appVersion", "osVersion", "durationMs", "httpStatus", "apiErrorCode", "errorDomain", "errorCode", "errorKind", "message", "projectCount", "sessionCount", "failedSessionCount", "partIndex", "partCount", "bytes", "windowStart", "windowEnd", "periodKey", "policyVersion", "agent", "retryAttempt"]

    func testLogDetailsKeysMatchServerWhitelistAndNilIsOmitted() throws {
        XCTAssertEqual(Set(CollectorLogDetails.CodingKeys.allCases.map(\.rawValue)), serverDetailKeys)
        var full = CollectorLogDetails(durationMs: 5, httpStatus: 500, apiErrorCode: "X", errorDomain: "NSURLErrorDomain", errorCode: -1009, errorKind: .network, message: "m", projectCount: 1, sessionCount: 2, failedSessionCount: 3, partIndex: 0, partCount: 1, bytes: 9, windowStart: .now, windowEnd: .now, periodKey: "p", policyVersion: 1, agent: .codex, retryAttempt: 1)
        full.appVersion = "1"; full.osVersion = "macOS 14"
        let allKeys = try wireDetails(CollectorLog(stage: "upload", level: "error", code: "UPLOAD_FAILED", sessionCount: 0, details: full))
        XCTAssertEqual(Set(allKeys.keys), serverDetailKeys)
        let sparse = try wireDetails(CollectorLog(stage: "app", level: "info", code: "APP_LAUNCHED", sessionCount: 0, details: CollectorLogDetails(projectCount: 2)))
        XCTAssertEqual(Set(sparse.keys), ["projectCount"])
        let text = try XCTUnwrap(String(data: CollectorJSON.encoder().encode(CollectorLog(stage: "app", level: "info", code: "APP_LAUNCHED", sessionCount: 0, details: CollectorLogDetails(projectCount: 2).sanitized())), encoding: .utf8))
        XCTAssertFalse(text.contains("null"))
        let plain = try XCTUnwrap(String(data: JSONEncoder().encode(CollectorLog(stage: "app", level: "info", code: "APP_LAUNCHED", sessionCount: 0)), encoding: .utf8))
        XCTAssertFalse(plain.contains("details"))
        XCTAssertFalse(plain.contains("null"))
    }
    func testSanitizedDetailsAddVersionsAndStayWithinServerBounds() throws {
        var raw = CollectorLogDetails(durationMs: 999_999_999, httpStatus: 42, apiErrorCode: "bad code", errorDomain: "bad domain!", errorCode: Int.max, message: String(repeating: "x", count: 400), partCount: 99_999, bytes: 5_000_000_000)
        raw.appVersion = String(repeating: "9", count: 90)
        let clean = raw.sanitized()
        XCTAssertEqual(clean.durationMs, 86_400_000)
        XCTAssertNil(clean.httpStatus); XCTAssertNil(clean.apiErrorCode); XCTAssertNil(clean.errorDomain); XCTAssertNil(clean.errorCode)
        XCTAssertEqual(clean.message?.count, 300)
        XCTAssertEqual(clean.partCount, 10_000)
        XCTAssertEqual(clean.bytes, 1_000_000_000)
        XCTAssertEqual(clean.appVersion?.count, 40)
        XCTAssertFalse(try XCTUnwrap(CollectorLogDetails().sanitized().osVersion).isEmpty)
    }
    func testFailureDetailsAreFixedDescriptionsWithoutPathsOrErrorText() throws {
        let secret = "/Users/member/secret-project/token=abc123"
        let cases: [(any Error, CollectorLogDetails.ErrorKind, Int?, String?)] = [
            (CollectorError(status: 401, message: secret, apiCode: "COLLECTOR_AUTH_FAILED"), .auth, 401, "COLLECTOR_AUTH_FAILED"),
            (CollectorError(status: 409, message: secret), .policy, 409, nil),
            (CollectorError(status: 413, message: secret), .size, 413, nil),
            (CollectorError(status: 503, message: secret), .server, 503, nil),
            (ReviewServiceError(status: 500, message: secret), .server, 500, nil),
            (URLError(.notConnectedToInternet, userInfo: [NSLocalizedDescriptionKey: secret, NSURLErrorFailingURLStringErrorKey: secret]), .network, nil, nil),
            (NSError(domain: NSCocoaErrorDomain, code: 513, userInfo: [NSFilePathErrorKey: secret, NSLocalizedDescriptionKey: secret]), .storage, nil, nil),
            (NSError(domain: "Custom.Domain", code: 7, userInfo: [NSLocalizedDescriptionKey: secret]), .unknown, nil, nil),
        ]
        for (error, kind, status, apiCode) in cases {
            let details = CollectorLogDetails.failure(error).sanitized()
            XCTAssertEqual(details.errorKind, kind)
            XCTAssertEqual(details.httpStatus, status)
            XCTAssertEqual(details.apiErrorCode, apiCode)
            XCTAssertEqual(details.message, CollectorLogDetails.fixedMessage(for: kind))
            let wire = try String(data: JSONEncoder().encode(details), encoding: .utf8) ?? ""
            for fragment in ["/Users", "secret", "token", "abc123", "/"] { XCTAssertFalse(wire.contains(fragment), "\(fragment) leaked into \(wire)") }
        }
    }
    func testLegacyPersistedLogsWithoutDetailsStillDecode() throws {
        let legacy = #"{"eventId":"5C0F2A1E-0000-4000-8000-000000000001","occurredAt":780000000.5,"stage":"binding","level":"info","code":"BOUND","sessionCount":3}"#
        let log = try JSONDecoder().decode(CollectorLog.self, from: Data(legacy.utf8))
        XCTAssertEqual(log.code, "BOUND")
        XCTAssertEqual(log.sessionCount, 3)
        XCTAssertNil(log.details)
        XCTAssertNil(log.state)
    }
    func testPackageAndDiscoveryDetailsCarryOnlyCountsAndWindow() throws {
        let now = Date.now
        let period = CollectorPolicy.Period(periodKey: "2026-W44", startsAt: now.addingTimeInterval(-100), endsAt: now.addingTimeInterval(100))
        let session = CollectorSession(id: "session", scopeKey: String(repeating: "a", count: 64), agent: .codex, title: "Private title", modifiedAt: now, turns: [.init(id: "q", prompt: "Private prompt", answer: nil, questionTime: "12:00")])
        let package = try CollectorPackage(period: period, start: now, end: now, version: 3, sessions: [session])
        let details = CollectorLogDetails.forPackage(package)
        XCTAssertEqual(details.sessionCount, 1); XCTAssertEqual(details.partCount, 1); XCTAssertEqual(details.policyVersion, 3)
        XCTAssertEqual(details.periodKey, "2026-W44"); XCTAssertEqual(details.bytes, package.parts[0].count)
        let wire = String(decoding: try JSONEncoder().encode(details), as: UTF8.self)
        XCTAssertFalse(wire.contains("Private"))
    }
    func testStoreRecordsLaunchDiscoveryAndPolicyFailureEventsWithoutPaths() async throws {
        let (home, _) = try projectFixture(["event-project"])
        let service = FakeCollector()
        let state = home.appending(path: "app/state.json")
        let store = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil, collectorService: service)
        await store.bindCollector(binding, code: "TEST-CODE")
        _ = await store.prepareCollectorPermissions()
        await service.setPolicyFailure(true)
        _ = await store.refreshCollectorPolicy()
        _ = await store.refreshCollectorPolicy()
        await store.flushCollectorLogs()
        let events = await service.events
        XCTAssertEqual(events.map(\.code).filter { $0 == "DISCOVERY_STARTED" }.count, 1)
        let completed = try XCTUnwrap(events.first { $0.code == "DISCOVERY_COMPLETED" })
        XCTAssertEqual(completed.stage, "discovery")
        XCTAssertEqual(completed.details?.projectCount, 1)
        XCTAssertNotNil(completed.details?.durationMs)
        let failures = events.filter { $0.code == "POLICY_SYNC_FAILED" }
        XCTAssertEqual(failures.count, 1, "repeat failures inside the throttle window are collapsed")
        XCTAssertEqual(failures.first?.details?.errorKind, .network)
        XCTAssertEqual(failures.first?.level, "error")
        for event in events {
            let wire = String(decoding: try CollectorJSON.encoder().encode(event), as: UTF8.self)
            XCTAssertFalse(wire.contains(home.path), "\(event.code) leaked a path")
            XCTAssertFalse(wire.contains("event-project"), "\(event.code) leaked a project name")
            XCTAssertFalse(wire.contains("null"))
        }
    }
}
