import XCTest
import Combine
@testable import WeeklyReportCore

private actor CollectionReader: LocalSessionReading {
    enum Output: Sendable { case reply, empty, questionOnly, blankReply, pendingLastTurn, failure, partial }
    private var outputs: [String: Output]
    private var blocked: Set<String>
    private var calls: [String: Int] = [:]
    private var waiting: [String: CheckedContinuation<Void, Never>] = [:]
    private var observers: [String: CheckedContinuation<Void, Never>] = [:]
    init(outputs: [String: Output] = [:], blocked: Set<String> = []) { self.outputs = outputs; self.blocked = blocked }
    func read(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession {
        let id = sources[0].nativeID
        calls[id, default: 0] += 1
        if blocked.contains(id) {
            await withCheckedContinuation { continuation in
                waiting[id] = continuation
                observers.removeValue(forKey: id)?.resume()
            }
        } else { observers.removeValue(forKey: id)?.resume() }
        let question = ChatTurn(id: "question", prompt: "question", answer: nil, questionTime: "time")
        let reply = ChatTurn(id: "reply", prompt: "question", answer: "answer", questionTime: "time")
        switch outputs[id] ?? .reply {
        case .reply: return ReadSession(turns: [reply], warnings: [])
        case .empty: return ReadSession(turns: [], warnings: [])
        case .questionOnly: return ReadSession(turns: [question], warnings: [])
        case .blankReply: return ReadSession(turns: [.init(id: "blank", prompt: "question", answer: " \n ", questionTime: "time")], warnings: [])
        case .pendingLastTurn: return ReadSession(turns: [reply, question], warnings: [])
        case .failure: throw CocoaError(.fileReadNoPermission)
        case .partial: return ReadSession(turns: [], warnings: ["一处来源暂时无法读取"])
        }
    }
    func waitUntilStarted(_ id: String) async {
        if calls[id, default: 0] > 0 { return }
        await withCheckedContinuation { observers[id] = $0 }
    }
    func release(_ id: String) { blocked.remove(id); waiting.removeValue(forKey: id)?.resume() }
    func setOutput(_ output: Output, for id: String) { outputs[id] = output }
    func count(_ id: String) -> Int { calls[id, default: 0] }
}

@MainActor
final class SessionCollectionTests: XCTestCase {
    private func fixture() throws -> URL {
        let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let home = caches.appending(path: "weekly-collection-test-\(UUID())")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return home.resolvingSymlinksInPath()
    }
    private func source(_ id: String, project: String = "project", home: URL, revision: Int = 1, modifiedAt: Date? = nil) throws -> String {
        let root = home.appending(path: "work/\(project)")
        try FileManager.default.createDirectory(at: root.appending(path: ".git"), withIntermediateDirectories: true)
        let file = home.appending(path: ".claude/projects/main/\(id).jsonl")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var data = try JSONSerialization.data(withJSONObject: ["type": "user", "sessionId": id, "cwd": root.path, "revision": revision])
        data.append(10)
        try data.write(to: file)
        if let modifiedAt { try FileManager.default.setAttributes([.modificationDate: modifiedAt], ofItemAtPath: file.path) }
        return root.path
    }
    private func store(_ home: URL, reader: (any LocalSessionReading)?, authorizedRoots: [String] = []) -> AppStore {
        AppStore(stateURL: home.appending(path: "app/state.json"), live: true, reader: reader, discoveryHome: home, authorizedRoots: authorizedRoots, discoveryEnvironment: [:], metadataReader: nil)
    }

    func testInitialScanFreezesRecentMonthAndApprovalsImportWithoutAnotherScan() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let clickedAt = Date(timeIntervalSince1970: floor(Date.now.timeIntervalSince1970))
        let window = SessionScanWindow(endingAt: clickedAt)
        let root = try source("recent", home: home, modifiedAt: clickedAt.addingTimeInterval(-60))
        _ = try source("boundary", home: home, modifiedAt: window.start)
        _ = try source("old", home: home, modifiedAt: window.start.addingTimeInterval(-1))
        _ = try source("future", home: home, modifiedAt: clickedAt.addingTimeInterval(60))
        _ = try source("old-project", project: "old-project", home: home, modifiedAt: window.start.addingTimeInterval(-60))
        let other = try source("other", project: "other", home: home, modifiedAt: clickedAt.addingTimeInterval(-60))
        let reader = CollectionReader()
        let first = store(home, reader: reader)
        await first.startInitialScan(at: clickedAt)
        XCTAssertEqual(first.startupStage, .ready)
        XCTAssertEqual(first.scanWindow, window)
        XCTAssertEqual(first.projects.count, 2)
        XCTAssertEqual(first.count(for: try XCTUnwrap(first.projects.first { $0.id == root })), 2)
        XCTAssertTrue(first.sessions.isEmpty)
        let initialCalls = await reader.count("recent")
        XCTAssertEqual(initialCalls, 0)
        let revision = first.sourceRevision
        let reportURL = home.appending(path: "app/source-discovery.json")
        let report = try Data(contentsOf: reportURL)
        _ = try source("later", home: home, modifiedAt: clickedAt.addingTimeInterval(-1))
        await first.refreshDiscovery()
        await first.collectProject(root)
        XCTAssertEqual(first.sourceRevision, revision)
        XCTAssertEqual(try Data(contentsOf: reportURL), report)
        XCTAssertEqual(first.sessions.count, 2)
        XCTAssertTrue(first.sessions.allSatisfy(\.hasModelReply))
        for id in ["old", "future", "old-project", "other", "later"] {
            let calls = await reader.count(id)
            XCTAssertEqual(calls, 0, id)
        }

        let next = store(home, reader: reader)
        XCTAssertEqual(next.startupStage, .ready)
        XCTAssertEqual(next.scanWindow, window)
        XCTAssertEqual(next.sessions.count, 2)
        XCTAssertTrue(next.sessions.allSatisfy(\.hasModelReply))
        await next.startInitialScan(at: clickedAt.addingTimeInterval(60 * 24 * 60 * 60))
        await next.refreshDiscovery()
        await next.loadSelectedSession()
        XCTAssertEqual(next.scanWindow, window)
        XCTAssertEqual(try Data(contentsOf: reportURL), report)
        for id in ["recent", "boundary"] {
            let calls = await reader.count(id)
            XCTAssertEqual(calls, 1, id)
        }
        await next.collectProject(other)
        XCTAssertEqual(next.sessions.count, 3)
        XCTAssertEqual(try Data(contentsOf: reportURL), report)
        let permissions = try FileManager.default.attributesOfItem(atPath: home.appending(path: "app/state.json").path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    func testInterruptedInitialImportResumesSameWindowAndIndexWithoutRescanning() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let clickedAt = Date(timeIntervalSince1970: floor(Date.now.timeIntervalSince1970))
        let root = try source("failed", home: home, modifiedAt: clickedAt.addingTimeInterval(-60))
        let reader = CollectionReader(outputs: ["failed": .failure])
        let first = store(home, reader: reader, authorizedRoots: [root])
        await first.startInitialScan(at: clickedAt)
        XCTAssertEqual(first.collectionProgress?.failures.count, 1)
        let reportURL = home.appending(path: "app/source-discovery.json")
        let report = try Data(contentsOf: reportURL)
        _ = try source("not-indexed", home: home, modifiedAt: clickedAt.addingTimeInterval(-1))
        await reader.setOutput(.reply, for: "failed")
        let restarted = store(home, reader: reader)
        XCTAssertEqual(restarted.startupStage, .welcome)
        await restarted.startInitialScan(at: clickedAt.addingTimeInterval(24 * 60 * 60))
        XCTAssertEqual(restarted.startupStage, .ready)
        XCTAssertEqual(restarted.scanWindow?.end, clickedAt)
        XCTAssertEqual(try Data(contentsOf: reportURL), report)
        XCTAssertEqual(restarted.sessions.count, 1)
        let notIndexed = await reader.count("not-indexed")
        XCTAssertEqual(notIndexed, 0)
    }

    func testCachedContentIsRemovedWhenPermissionIsRevokedAndExcludedSessionsStayExcluded() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("reply", home: home)
        _ = try source("empty", home: home)
        let reader = CollectionReader(outputs: ["empty": .questionOnly])
        let first = store(home, reader: reader)
        await first.startInitialScan()
        await first.collectProject(root)
        let restored = store(home, reader: reader)
        XCTAssertEqual(restored.startupStage, .ready)
        XCTAssertEqual(restored.sessions.count, 1)
        XCTAssertEqual(restored.count(for: try XCTUnwrap(restored.projects.first)), 1)
        restored.decideProject(root, permission: .denied)
        let revoked = store(home, reader: reader)
        XCTAssertTrue(revoked.sessions.isEmpty)
        let saved = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: home.appending(path: "app/state.json"))) as? [String: Any])
        XCTAssertTrue((saved["importedSessions"] as? [Any] ?? []).isEmpty)
        XCTAssertTrue((saved["loadedFingerprints"] as? [String: Any] ?? [:]).isEmpty)
        XCTAssertTrue((saved["excludedSessionFingerprints"] as? [String: Any] ?? [:]).isEmpty)
    }

    func testCollectDuringBackgroundReadShowsProgressAndRunsAfterCurrentRead() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let allowed = try source("a", project: "allowed", home: home)
        _ = try source("z", project: "allowed", home: home)
        let pending = try source("b", project: "pending", home: home)
        _ = try source("private", project: "private", home: home)
        let reader = CollectionReader(blocked: ["a", "b"])
        let store = store(home, reader: reader)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        store.decideProject(allowed, permission: .allowed)
        let refresh = Task { await store.refreshDiscovery() }
        await reader.waitUntilStarted("a")
        XCTAssertTrue(store.isDiscovering)
        XCTAssertTrue(store.isLoadingSessionContents)

        let accepted = expectation(description: "Collection is accepted while background refresh is busy")
        let observation = store.$collectionProgress.compactMap { $0 }.first().sink { _ in accepted.fulfill() }
        let collection = Task { await store.collectProject(pending) }
        await fulfillment(of: [accepted], timeout: 2)
        withExtendedLifetime(observation) {}
        XCTAssertNotNil(store.collectionProgress)
        XCTAssertEqual(store.projects.first { $0.id == pending }?.permission, .pending)
        let callsBeforeHandoff = await reader.count("b")
        XCTAssertEqual(callsBeforeHandoff, 0)
        await store.collectProject(pending)
        await store.refreshDiscovery()

        await reader.release("a")
        await reader.waitUntilStarted("b")
        XCTAssertNotNil(store.collectionProgress)
        XCTAssertEqual(store.collectionProgress?.total, 1)
        let remainingBackgroundCalls = await reader.count("z")
        XCTAssertEqual(remainingBackgroundCalls, 0)
        await reader.release("b")
        await collection.value
        await refresh.value
        XCTAssertNil(store.collectionProgress)
        XCTAssertFalse(store.isDiscovering)
        XCTAssertFalse(store.isLoadingSessionContents)
        XCTAssertEqual(store.projects.first { $0.id == pending }?.permission, .allowed)
        XCTAssertEqual(store.sessions.count, 3)
        for id in ["a", "b"] {
            let calls = await reader.count(id)
            XCTAssertEqual(calls, 1)
        }
        let untouchedAllowedCalls = await reader.count("z")
        XCTAssertEqual(untouchedAllowedCalls, 0)
        let privateCalls = await reader.count("private")
        XCTAssertEqual(privateCalls, 0)
    }

    func testCollectRequestedAtBackgroundScanStartKeepsFailureAndRetryVisible() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let pending = try source("bad", home: home)
        let reader = CollectionReader(outputs: ["bad": .failure])
        let store = store(home, reader: reader)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        let completed = expectation(description: "Collection requested during metadata scan completes")
        let observation = store.$isDiscovering.filter { $0 }.first().sink { _ in
            Task {
                await store.collectProject(pending)
                completed.fulfill()
            }
        }
        await store.refreshDiscovery()
        await fulfillment(of: [completed], timeout: 5)
        withExtendedLifetime(observation) {}
        XCTAssertEqual(store.collectionProgress?.failures.count, 1)
        XCTAssertFalse(store.isDiscovering)
        XCTAssertFalse(store.isLoadingSessionContents)
        await reader.setOutput(.reply, for: "bad")
        await store.retryCollection()
        XCTAssertNil(store.collectionProgress)
        XCTAssertEqual(store.sessions.count, 1)
        let calls = await reader.count("bad")
        XCTAssertEqual(calls, 2)
    }

    func testCollectProjectOnlyLoadsItsOwnSessionsAndWaitsForAllOfThem() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("a", home: home)
        _ = try source("b", home: home)
        let other = try source("c", project: "other", home: home)
        _ = try source("pending", project: "pending", home: home)
        let denied = try source("denied", project: "denied", home: home)
        let reader = CollectionReader(outputs: ["c": .failure], blocked: ["a", "b"])
        let store = store(home, reader: reader)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        store.decideProject(other, permission: .allowed)
        store.decideProject(denied, permission: .denied)
        let collection = Task { await store.collectProject(root) }
        await reader.waitUntilStarted("a")
        XCTAssertNotNil(store.collectionProgress)
        XCTAssertEqual(store.collectionProgress?.total, 2)
        XCTAssertEqual(store.collectionProgress?.processed, 0)
        await reader.release("a")
        await reader.waitUntilStarted("b")
        XCTAssertNotNil(store.collectionProgress)
        XCTAssertEqual(store.collectionProgress?.processed, 1)
        XCTAssertEqual(store.collectionProgress?.completed, 1)
        await reader.release("b")
        await collection.value
        XCTAssertNil(store.collectionProgress)
        let collected = store.sessions.filter { $0.projectID == root }
        XCTAssertEqual(collected.count, 2)
        XCTAssertTrue(collected.allSatisfy { $0.hasModelReply })
        XCTAssertEqual(store.sessions.count, 3)
        let pendingCalls = await reader.count("pending"), deniedCalls = await reader.count("denied"), unrelatedCalls = await reader.count("c")
        XCTAssertEqual(pendingCalls, 0); XCTAssertEqual(deniedCalls, 0); XCTAssertEqual(unrelatedCalls, 0)
        XCTAssertTrue(store.sessionReadErrors.isEmpty)
    }

    func testSuccessiveApprovalsUseExistingDiscoveryAndBackgroundRefreshFindsNewSessions() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let first = try source("a", project: "first", home: home)
        let second = try source("b", project: "second", home: home)
        let reader = CollectionReader()
        let store = store(home, reader: reader)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        let revision = store.sourceRevision
        let discoveredAt = store.lastDiscoveredAt
        let reportURL = home.appending(path: "app/source-discovery.json")
        let report = try Data(contentsOf: reportURL)
        _ = try source("later", project: "second", home: home)

        await store.collectProject(first)
        await store.collectProject(second)
        XCTAssertNil(store.collectionProgress)
        XCTAssertEqual(store.sourceRevision, revision)
        XCTAssertEqual(store.lastDiscoveredAt, discoveredAt)
        XCTAssertEqual(try Data(contentsOf: reportURL), report)
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertTrue(store.sessions.allSatisfy(\.hasModelReply))
        let laterBeforeRefresh = await reader.count("later")
        XCTAssertEqual(laterBeforeRefresh, 0)

        await store.refreshDiscovery()
        XCTAssertGreaterThan(store.sourceRevision, revision)
        XCTAssertEqual(store.sessions.count, 3)
        for id in ["a", "b", "later"] {
            let calls = await reader.count(id)
            XCTAssertEqual(calls, 1)
        }
    }

    func testProjectRetryDoesNotReadUnrelatedAllowedSessions() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let target = try source("target", home: home)
        let other = try source("other", project: "other", home: home)
        let reader = CollectionReader(outputs: ["target": .failure, "other": .failure])
        let store = store(home, reader: reader)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        store.decideProject(other, permission: .allowed)
        await store.collectProject(target)
        XCTAssertEqual(store.collectionProgress?.total, 1)
        XCTAssertEqual(store.collectionProgress?.failures.count, 1)
        await reader.setOutput(.reply, for: "target")
        await store.retryCollection()
        XCTAssertNil(store.collectionProgress)
        let otherCalls = await reader.count("other")
        XCTAssertEqual(otherCalls, 0)
        XCTAssertTrue(store.sessionReadErrors.isEmpty)
    }

    func testInitialScanDoesNotFinishOrPersistCompletionUntilAllContentIsLoaded() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("initial", home: home)
        let other = try source("second", project: "other", home: home)
        let reader = CollectionReader(blocked: ["initial", "second"])
        let store = store(home, reader: reader, authorizedRoots: [root, other])
        let scan = Task { await store.startInitialScan() }
        await reader.waitUntilStarted("initial")
        XCTAssertEqual(store.startupStage, .scanning)
        XCTAssertNotNil(store.collectionProgress)
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: home.appending(path: "app/state.json"))) as? [String: Any]
        XCTAssertEqual(saved?["initialScanCompleted"] as? Bool, false)
        await reader.release("initial")
        await reader.waitUntilStarted("second")
        XCTAssertEqual(store.startupStage, .scanning)
        XCTAssertEqual(store.collectionProgress?.total, 2)
        XCTAssertEqual(store.collectionProgress?.completed, 1)
        await reader.release("second")
        await scan.value
        XCTAssertEqual(store.startupStage, .ready)
        XCTAssertNil(store.collectionProgress)
        XCTAssertEqual(store.startupProgress.fraction, 1)
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertTrue(store.sessions.allSatisfy(\.hasModelReply))
    }

    func testEmptyQuestionOnlyAndBlankRepliesAreExcludedButPendingLastTurnIsPreserved() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("empty", home: home)
        for id in ["question", "blank", "history", "reply"] { _ = try source(id, home: home) }
        let reader = CollectionReader(outputs: ["empty": .empty, "question": .questionOnly, "blank": .blankReply, "history": .pendingLastTurn])
        let store = store(home, reader: reader)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        await store.collectProject(root)
        XCTAssertNil(store.collectionProgress)
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertEqual(store.sessions.filter { $0.id.hasPrefix("claude:history:") }.count, 1)
        XCTAssertEqual(store.sessions.filter { $0.id.hasPrefix("claude:reply:") }.count, 1)
        XCTAssertEqual(store.count(for: store.projects[0]), 2)
        XCTAssertEqual(store.count(for: .claude), 2)
        let history = try XCTUnwrap(store.sessions.first { $0.id.hasPrefix("claude:history:") })
        XCTAssertEqual(history.turns.count, 2)
        XCTAssertNil(history.turns.last?.answer)
        await store.runLocalUpload()
        XCTAssertEqual(store.uploadRecords.first?.content, "2 个会话")
        let outbox = home.appending(path: "app/outbox")
        let files = try FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil)
        let staged = try JSONDecoder().decode([AgentSession].self, from: Data(contentsOf: files[0]))
        XCTAssertTrue(staged.allSatisfy(\.hasModelReply))
        await store.refreshDiscovery()
        let unchangedCalls = await reader.count("question")
        XCTAssertEqual(unchangedCalls, 1)
        XCTAssertEqual(store.sessions.count, 2)
        await reader.setOutput(.reply, for: "question")
        _ = try source("question", home: home, revision: 222)
        await store.refreshDiscovery()
        XCTAssertEqual(store.sessions.count, 3)
        XCTAssertTrue(store.sessions.contains { $0.id.hasPrefix("claude:question:") && $0.hasModelReply })
    }

    func testFailuresBlockEntryAndRetryOnlyReadsUnsuccessfulSessions() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("good", home: home)
        _ = try source("bad", home: home)
        _ = try source("partial", home: home)
        let reader = CollectionReader(outputs: ["bad": .failure, "partial": .partial])
        let store = store(home, reader: reader)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        await store.collectProject(root)
        XCTAssertEqual(store.collectionProgress?.failures.count, 2)
        XCTAssertEqual(store.collectionProgress?.completed, 1)
        XCTAssertEqual(store.collectionProgress?.excluded, 0)
        XCTAssertEqual(store.sessions.count, 3)
        XCTAssertFalse(store.isLoadingSessionContents)
        await reader.setOutput(.reply, for: "bad")
        await reader.setOutput(.questionOnly, for: "partial")
        await store.retryCollection()
        XCTAssertNil(store.collectionProgress)
        XCTAssertTrue(store.sessionReadErrors.isEmpty)
        XCTAssertEqual(store.sessions.count, 2)
        let good = await reader.count("good"), bad = await reader.count("bad"), partial = await reader.count("partial")
        XCTAssertEqual(good, 1); XCTAssertEqual(bad, 2); XCTAssertEqual(partial, 2)
    }

    func testFailedInitialCollectionStaysAtStartupUntilRetrySucceeds() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("bad", home: home)
        let reader = CollectionReader(outputs: ["bad": .failure])
        let store = store(home, reader: reader, authorizedRoots: [root])
        await store.startInitialScan()
        XCTAssertEqual(store.startupStage, .scanning)
        XCTAssertEqual(store.collectionProgress?.failures.count, 1)
        await reader.setOutput(.reply, for: "bad")
        await store.retryCollection()
        XCTAssertEqual(store.startupStage, .ready)
        XCTAssertNil(store.collectionProgress)
    }

    func testReturningFromFailedInitialLoadCannotBypassItOnRestart() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("bad", home: home)
        let reader = CollectionReader(outputs: ["bad": .failure])
        let first = store(home, reader: reader)
        await first.startInitialScan()
        await first.collectProject(root)
        let restarted = store(home, reader: reader)
        await restarted.startInitialScan()
        XCTAssertNotNil(restarted.collectionProgress)
        restarted.cancelCollection()
        XCTAssertEqual(restarted.startupStage, .welcome)
        XCTAssertEqual(store(home, reader: reader).startupStage, .welcome)
    }

    func testMissingReaderDoesNotPassAndBackRestoresPreviousPermission() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("missing", home: home)
        let store = store(home, reader: nil)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        store.decideProject(root, permission: .denied)
        await store.collectProject(root)
        XCTAssertEqual(store.collectionProgress?.failures.count, 1)
        store.cancelCollection()
        XCTAssertNil(store.collectionProgress)
        XCTAssertEqual(store.projects.first { $0.id == root }?.permission, .denied)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertEqual(store.page, .approvals)
    }

    func testInterruptedCollectionMustFinishAgainAfterRelaunch() async throws {
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("bad", home: home)
        let reader = CollectionReader(outputs: ["bad": .failure])
        let first = store(home, reader: reader)
        await first.startInitialScan()
        XCTAssertEqual(first.startupStage, .ready)
        await first.collectProject(root)
        XCTAssertNotNil(first.collectionProgress)
        let restarted = store(home, reader: reader)
        XCTAssertEqual(restarted.startupStage, .welcome)
        await reader.setOutput(.reply, for: "bad")
        await restarted.startInitialScan()
        XCTAssertEqual(restarted.startupStage, .ready)
        XCTAssertEqual(restarted.sessions.count, 1)
        let completed = store(home, reader: reader)
        XCTAssertEqual(completed.startupStage, .ready)
    }

    func testNativeClaudeReaderFiltersEmptyAndUserOnlyFilesBeforeEntry() async throws {
        let executable = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "Resources/Reader/cc-session-reader")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { throw XCTSkip("先构建原生读取组件") }
        let home = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = try source("empty", home: home)
        for id in ["question", "answered"] {
            _ = try source(id, home: home)
            let file = home.appending(path: ".claude/projects/main/\(id).jsonl")
            var rows: [[String: Any]] = [
                ["type": "user", "sessionId": id, "cwd": root, "uuid": "u", "message": ["role": "user", "content": "test"]]
            ]
            if id == "answered" {
                rows.append(["type": "assistant", "sessionId": id, "cwd": root, "uuid": "a", "message": ["role": "assistant", "id": "reply", "stop_reason": "end_turn", "content": [["type": "text", "text": "answer"]]]])
            }
            let data = try rows.reduce(into: Data()) { data, row in data.append(try JSONSerialization.data(withJSONObject: row)); data.append(10) }
            try data.write(to: file)
        }
        let bridge = LocalReader(executable: executable, workingDirectory: home.appending(path: "reader-work"))
        let store = store(home, reader: bridge)
        await store.refreshDiscovery(includeAuthorizedContent: false)
        XCTAssertEqual(store.count(for: store.projects[0]), 3)
        await store.collectProject(root)
        XCTAssertNil(store.collectionProgress)
        XCTAssertEqual(store.sessions.count, 1)
        XCTAssertTrue(store.sessions.first?.id.hasPrefix("claude:answered:") == true)
        XCTAssertEqual(store.sessions.first?.turns.first?.answer, "answer")
        XCTAssertEqual(store.count(for: store.projects[0]), 1)
    }
}
