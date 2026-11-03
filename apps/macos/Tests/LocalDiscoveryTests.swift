import XCTest
import SQLite3
@testable import WeeklyReportCore

final class LocalDiscoveryTests: XCTestCase {
    private func fixture() throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "weekly-discovery-\(UUID())")
        let project = root.appending(path: "work/actual-project")
        try FileManager.default.createDirectory(at: project.appending(path: ".git"), withIntermediateDirectories: true)
        return (root, project)
    }
    func testScanWindowFiltersDatabaseRowsBySessionTimeNotDatabaseFileTime() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let directory = home.appending(path: ".hermes")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(directory.appending(path: "state.db").path, &database), SQLITE_OK)
        defer { sqlite3_close(database) }
        let clickedAt = Date(timeIntervalSince1970: 1_793_577_600)
        let window = SessionScanWindow(endingAt: clickedAt)
        XCTAssertEqual(sqlite3_exec(database, "CREATE TABLE sessions(id TEXT,cwd TEXT,updated_at REAL);", nil, nil, nil), SQLITE_OK)
        let dates = ["old": window.start.addingTimeInterval(-1), "boundary": window.start, "recent": clickedAt, "future": clickedAt.addingTimeInterval(1)]
        for (id, date) in dates {
            let sql = "INSERT INTO sessions VALUES('\(id)','\(project.path)',\(date.timeIntervalSince1970));"
            XCTAssertEqual(sqlite3_exec(database, sql, nil, nil, nil), SQLITE_OK)
        }
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: [:], metadataReader: nil, scanWindow: window).scan()
        XCTAssertEqual(Set(snapshot.sessions.map(\.nativeID)), ["boundary", "recent"])
        XCTAssertTrue(snapshot.sessions.allSatisfy { window.contains($0.modifiedAt) })
    }

    func testRealFormatDiscoveryUsesMetadataAndMergesAgentsIntoOneProject() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        for (agent, path) in [("claude", ".claude/projects/encoded"), ("omp", ".omp/agent/sessions/encoded")] {
            let folder = home.appending(path: path)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let head: [String: Any] = ["type": agent == "omp" ? "session" : "user", "id": agent, "sessionId": agent, "cwd": project.path]
            var data = try JSONSerialization.data(withJSONObject: head); data.append(10)
            // The scanner must stop after project metadata and not need valid transcript content.
            data.append(Data("THIS_IS_NOT_JSON_AND_MUST_NOT_BE_NEEDED\n".utf8))
            try data.write(to: folder.appending(path: "main.jsonl"))
            try data.write(to: folder.appending(path: "agent-child.jsonl"))
        }
        let scanner = LocalDiscovery(home: home, temporaryRoots: [])
        XCTAssertNotNil(scanner.projectRoot(for: project.path))
        let snapshot = scanner.scan()
        XCTAssertEqual(snapshot.projects.count, 1)
        XCTAssertEqual(snapshot.projects.first?.root, project.resolvingSymlinksInPath().path)
        XCTAssertEqual(Set(snapshot.sessions.map(\.agent)), [.claude, .omp])
        XCTAssertEqual(snapshot.sessions.count, 2)
    }
    func testOrdinaryFolderIsIgnoredUnlessExplicitlyRegistered() throws {
        let (home, _) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let ordinary = home.appending(path: "documents/client-materials")
        try FileManager.default.createDirectory(at: ordinary, withIntermediateDirectories: true)
        XCTAssertNil(LocalDiscovery(home: home, temporaryRoots: []).projectRoot(for: ordinary.path))
        XCTAssertEqual(LocalDiscovery(home: home, registeredRoots: [ordinary.path], temporaryRoots: []).projectRoot(for: ordinary.appending(path: "notes").path), ordinary.resolvingSymlinksInPath().path)
    }
    func testTemporaryLocationIsExcludedEvenWhenRegistered() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let root = project.resolvingSymlinksInPath().path
        XCTAssertNil(LocalDiscovery(home: home, registeredRoots: [root], temporaryRoots: [root]).projectRoot(for: root))
    }
    func testNativeTitlesPreferStoredNameAndOnlyReadAllowedSources() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let codex = home.appending(path: ".codex")
        try FileManager.default.createDirectory(at: codex, withIntermediateDirectories: true)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(codex.appending(path: "state_5.sqlite").path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        let root = project.path
        let sql = "CREATE TABLE threads(id TEXT,cwd TEXT,name TEXT,title TEXT); INSERT INTO threads VALUES('approved','\(root)','用户设置的真实标题','旧的自动标题'); INSERT INTO threads VALUES('denied','/other/project',NULL,'不应出现的标题');"
        XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
        let source = LocalSessionSource(id: "s", agent: .codex, nativeID: "approved", source: "unused", cwd: root, projectRoot: root, modifiedAt: .now, fingerprint: "1")
        let denied = LocalSessionSource(id: "d", agent: .codex, nativeID: "denied", source: "unused", cwd: "/other/project", projectRoot: "/other/project", modifiedAt: .now, fingerprint: "1")
        let titles = AuthorizedTitles(home: home, pathOverrides: [:]).read(sources: [source, denied], allowedRoots: [root])
        XCTAssertEqual(titles, ["codex:approved": "用户设置的真实标题"])
    }
    func testOMPTitleSlotAndClaudeCustomTitleAreUsed() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let omp = home.appending(path: "omp.jsonl"), claude = home.appending(path: "claude.jsonl")
        try Data("{\"type\":\"title\",\"title\":\"OMP 会话标题\"}\n{\"type\":\"session_info\",\"name\":\"后来重命名的标题\"}\n".utf8).write(to: omp)
        try Data("{\"type\":\"custom-title\",\"customTitle\":\"Claude 会话标题\"}\n".utf8).write(to: claude)
        let sources = [(Agent.omp, omp), (.claude, claude)].map { agent, file in LocalSessionSource(id: agent.id, agent: agent, nativeID: agent.id, source: file.path, cwd: project.path, projectRoot: project.path, modifiedAt: .now, fingerprint: "1") }
        let titles = AuthorizedTitles(home: home, pathOverrides: [:]).read(sources: sources, allowedRoots: [project.path])
        XCTAssertEqual(titles["omp:omp"], "后来重命名的标题")
        XCTAssertEqual(titles["claude:claude"], "Claude 会话标题")
    }
    func testConfiguredClaudeLocationSupplementsDefaultHistory() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let folders = [home.appending(path: ".claude/projects/project"), home.appending(path: "custom-claude/project")]
        for (index, folder) in folders.enumerated() {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var bytes = try JSONSerialization.data(withJSONObject: ["type": "user", "sessionId": "claude-\(index)", "cwd": project.path]); bytes.append(10)
            try bytes.write(to: folder.appending(path: "session.jsonl"))
        }
        let snapshot = LocalDiscovery(home: home, pathOverrides: ["claude": home.appending(path: "custom-claude").path], temporaryRoots: []).scan()
        XCTAssertEqual(snapshot.sessions.filter { $0.agent == .claude }.count, 2)
    }
    func testGrokNativeTitleAndChatAppendInvalidateSourceFingerprint() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let folder = home.appending(path: ".grok/sessions/encoded/grok-session")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let metadata: [String: Any] = ["info": ["id": "grok-session", "cwd": project.path], "generated_title": "Grok 原生标题"]
        try JSONSerialization.data(withJSONObject: metadata).write(to: folder.appending(path: "summary.json"))
        let chat = folder.appending(path: "chat_history.jsonl")
        try Data("{}\n".utf8).write(to: chat)
        let scanner = LocalDiscovery(home: home, temporaryRoots: [])
        let first = scanner.scan().sessions.first { $0.agent == .grokbuild }!
        try Data("{}\n{\"type\":\"assistant\"}\n".utf8).write(to: chat)
        let second = scanner.scan().sessions.first { $0.agent == .grokbuild }!
        XCTAssertNotEqual(first.fingerprint, second.fingerprint)
        let titles = AuthorizedTitles(home: home, pathOverrides: [:]).read(sources: [second], allowedRoots: [project.resolvingSymlinksInPath().path])
        XCTAssertEqual(titles[second.groupID], "Grok 原生标题")
    }
    func testOMPDefaultAndProfileHistoryAreBothDiscovered() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let folders = [home.appending(path: ".omp/agent/sessions/project"), home.appending(path: ".omp/profiles/team/agent/sessions/project")]
        for (index, folder) in folders.enumerated() {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var bytes = try JSONSerialization.data(withJSONObject: ["type": "session", "id": "omp-\(index)", "cwd": project.path]); bytes.append(10)
            try bytes.write(to: folder.appending(path: "session.jsonl"))
        }
        let snapshot = LocalDiscovery(home: home, temporaryRoots: []).scan()
        XCTAssertEqual(snapshot.sessions.filter { $0.agent == .omp }.count, 2)
    }
    func testAntigravityDiscoversDesktopAndCLIAndDeduplicatesConfiguredRoot() throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        for name in ["antigravity", "antigravity-cli"] {
            let base = home.appending(path: ".gemini/\(name)")
            let id = name + "-session"
            let transcript = base.appending(path: "brain/\(id)/.system_generated/logs/transcript_full.jsonl")
            try FileManager.default.createDirectory(at: transcript.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("PRIVATE_BODY_NOT_NEEDED_FOR_DISCOVERY".utf8).write(to: transcript)
            var db: OpaquePointer?
            XCTAssertEqual(sqlite3_open(base.appending(path: "conversation_summaries.db").path, &db), SQLITE_OK)
            let uris = String(decoding: try JSONEncoder().encode([project.absoluteString]), as: UTF8.self)
            let sql = "CREATE TABLE conversation_summaries(conversation_id TEXT,workspace_uris TEXT,last_modified_time TEXT,parent_conversation_id TEXT,title TEXT); INSERT INTO conversation_summaries VALUES('\(id)','\(uris)','2026-10-29',NULL,'真实会话标题');"
            XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK); sqlite3_close(db)
        }
        let override = home.appending(path: ".gemini/antigravity/brain").path
        let snapshot = LocalDiscovery(home: home, pathOverrides: ["agy": override], temporaryRoots: []).scan()
        let sessions = snapshot.sessions.filter { $0.agent == .agy }
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(snapshot.projects.count, 1)
        let titles = AuthorizedTitles(home: home, pathOverrides: [:]).read(sources: sessions, allowedRoots: [project.resolvingSymlinksInPath().path])
        XCTAssertEqual(titles.count, 2)
        XCTAssertTrue(titles.values.allSatisfy { $0 == "真实会话标题" })
    }
}

private actor SpyReader: LocalSessionReading {
    private(set) var calls = 0
    func read(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession {
        calls += 1
        return ReadSession(turns: [.init(id: "native-turn", prompt: "实际文件中的提问", answer: "实际文件中的回复", questionTime: "10月29日 16:00")], warnings: [])
    }
    func count() -> Int { calls }
}
private actor RecoveringReader: LocalSessionReading {
    private var calls = 0
    func read(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession {
        calls += 1
        return ReadSession(turns: [.init(id: "turn", prompt: "question", answer: "answer", questionTime: "10月29日 16:00")], warnings: calls == 1 ? ["另一处来源暂时不可读"] : [])
    }
}

private actor ControlledSessionReader: LocalSessionReading {
    private var calls: [String: Int] = [:]
    private var pending: [String: CheckedContinuation<ReadSession, any Error>] = [:]
    private var started: [String: CheckedContinuation<Void, Never>] = [:]
    func read(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession {
        let id = sources[0].nativeID
        calls[id, default: 0] += 1
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            started.removeValue(forKey: id)?.resume()
        }
    }
    func waitUntilStarted(_ id: String) async {
        if pending[id] != nil { return }
        await withCheckedContinuation { started[id] = $0 }
    }
    func finish(_ id: String, empty: Bool = false) {
        let turns: [ChatTurn] = empty ? [] : [.init(id: id, prompt: id, answer: "answer", questionTime: "time")]
        pending.removeValue(forKey: id)?.resume(returning: ReadSession(turns: turns, warnings: []))
    }
    func count(_ id: String) -> Int { calls[id, default: 0] }
}

@MainActor
final class LocalAuthorizationTests: XCTestCase {
    private func sessionSource(_ id: String, fingerprint: String = "1") -> LocalSessionSource {
        LocalSessionSource(id: id, agent: .codex, nativeID: id, source: "/data/\(id).jsonl", cwd: "/work/project", projectRoot: "/work/project", modifiedAt: .now, fingerprint: fingerprint)
    }
    private func apply(_ sources: [LocalSessionSource], to store: AppStore) {
        store.applyDiscovery(DiscoverySnapshot(projects: [.init(root: "/work/project", name: "project")], sessions: sources, agentStatus: [:], skippedTemporary: 0, issues: []))
        store.decideProject("/work/project", permission: .allowed)
    }
    func testSelectedBodyDoesNotWaitForOrRefreshUnrelatedTitles() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "weekly-body-first-\(UUID())")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let file = home.appending(path: "other.jsonl")
        try Data("{\"type\":\"title\",\"title\":\"unrelated native title\"}\n".utf8).write(to: file)
        let selected = sessionSource("selected")
        let other = LocalSessionSource(id: "other", agent: .omp, nativeID: "other", source: file.path, cwd: "/work/project", projectRoot: "/work/project", modifiedAt: .now, fingerprint: "1")
        let reader = SpyReader()
        let store = AppStore(live: true, reader: reader, discoveryHome: home, discoveryEnvironment: [:])
        apply([selected, other], to: store)
        store.selectSession(selected.groupID)
        XCTAssertEqual(store.loadingSessionID, selected.groupID)
        let previousTitle = store.sessions.first { $0.id == other.groupID }?.title
        await store.loadSelectedSession()
        XCTAssertFalse(store.selectedSession?.turns.isEmpty ?? true)
        XCTAssertNil(store.loadingSessionID)
        XCTAssertEqual(store.sessions.first { $0.id == other.groupID }?.title, previousTitle)
        let calls = await reader.count()
        XCTAssertEqual(calls, 1)
        await store.refreshAuthorizedTitles()
        XCTAssertEqual(store.sessions.first { $0.id == other.groupID }?.title, "unrelated native title")
    }
    func testSwitchingSessionsKeepsLoadingStateAndSharesInFlightRead() async {
        let reader = ControlledSessionReader()
        let store = AppStore(live: true, reader: reader)
        let first = sessionSource("first"), second = sessionSource("second")
        apply([first, second], to: store)
        store.selectSession(first.groupID)
        let firstLoad = Task { await store.loadSelectedSession() }
        await reader.waitUntilStarted("first")
        store.selectSession(second.groupID)
        let secondLoad = Task { await store.loadSelectedSession() }
        await reader.waitUntilStarted("second")
        store.selectSession(first.groupID)
        let repeatedLoad = Task { await store.loadSelectedSession() }
        await reader.finish("second")
        await secondLoad.value
        XCTAssertEqual(store.loadingSessionID, first.groupID)
        await reader.finish("first")
        await firstLoad.value
        await repeatedLoad.value
        let calls = await reader.count("first")
        XCTAssertEqual(calls, 1)
        XCTAssertNil(store.loadingSessionID)
        XCTAssertEqual(store.selectedSession?.turns.first?.prompt, "first")
    }
    func testEmptySessionIsFilteredAndItsFingerprintIsCached() async {
        let reader = ControlledSessionReader()
        let store = AppStore(live: true, reader: reader)
        let source = sessionSource("empty")
        apply([source], to: store)
        let load = Task { await store.loadSelectedSession() }
        await reader.waitUntilStarted("empty")
        await reader.finish("empty", empty: true)
        await load.value
        XCTAssertNil(store.selectedSession)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertEqual(store.count(for: store.projects[0]), 0)
        store.applyDiscovery(DiscoverySnapshot(projects: [.init(root: source.projectRoot, name: "project")], sessions: [source], agentStatus: [:], skippedTemporary: 0, issues: []))
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.loadingSessionID)
        await store.loadSelectedSession()
        let calls = await reader.count("empty")
        XCTAssertEqual(calls, 1)
    }
    func testChangedSourceDiscardsOldReadAndLoadsCurrentFingerprint() async {
        let reader = ControlledSessionReader()
        let store = AppStore(live: true, reader: reader)
        let source = sessionSource("changing")
        apply([source], to: store)
        let firstLoad = Task { await store.loadSelectedSession() }
        await reader.waitUntilStarted("changing")
        apply([sessionSource("changing", fingerprint: "2")], to: store)
        let nextLoad = Task { await store.loadSelectedSession() }
        await reader.finish("changing")
        await firstLoad.value
        XCTAssertTrue(store.selectedSession?.turns.isEmpty == true)
        await reader.waitUntilStarted("changing")
        await reader.finish("changing")
        await nextLoad.value
        let calls = await reader.count("changing")
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(store.selectedSession?.turns.first?.prompt, "changing")
        XCTAssertNil(store.loadingSessionID)
    }
    func testPartialSourceFailureIsNotCachedOrStagedAndCanRecoverWithoutFileChange() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "weekly-retry-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = AppStore(stateURL: folder.appending(path: "state.json"), live: true, reader: RecoveringReader())
        let root = "/work/project"
        let source = LocalSessionSource(id: "source", agent: .codex, nativeID: "native", source: "/missing.jsonl", cwd: root, projectRoot: root, modifiedAt: .now, fingerprint: "unchanged")
        store.applyDiscovery(DiscoverySnapshot(projects: [.init(root: root, name: "project")], sessions: [source], agentStatus: [:], skippedTemporary: 0, issues: []))
        store.decideProject(root, permission: .allowed)
        await store.runLocalUpload()
        XCTAssertTrue(store.uploadRecords.isEmpty)
        XCTAssertEqual(store.sessionReadErrors.count, 1)
        await store.runLocalUpload()
        XCTAssertEqual(store.uploadRecords.count, 1)
        XCTAssertTrue(store.sessionReadErrors.isEmpty)
        XCTAssertEqual(store.uploadRecords.first?.status, .queued)
    }
    func testDiscoveredProjectDoesNotReadUntilLocallyAllowedAndRevocationHidesText() async {
        let reader = SpyReader()
        let store = AppStore(live: true, reader: reader)
        let root = "/work/new-project"
        let source = LocalSessionSource(id: "source", agent: .codex, nativeID: "native-id", source: "/data/session.jsonl", cwd: root, projectRoot: root, modifiedAt: .now, fingerprint: "1")
        store.applyDiscovery(DiscoverySnapshot(projects: [.init(root: root, name: "new-project")], sessions: [source], agentStatus: [.codex: "已发现"], skippedTemporary: 0, issues: []))
        XCTAssertEqual(store.projects.first?.permission, .pending)
        XCTAssertTrue(store.sessions.isEmpty)
        await store.loadSelectedSession()
        let before = await reader.count()
        XCTAssertEqual(before, 0)
        store.decideProject(root, permission: .allowed)
        await store.loadSelectedSession()
        let after = await reader.count()
        XCTAssertEqual(after, 1)
        XCTAssertEqual(store.selectedSession?.turns.first?.prompt, "实际文件中的提问")
        store.decideProject(root, permission: .denied)
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNil(store.selectedSession)
    }
    func testAuthorizationAndProjectIdentitiesPersistWithoutSameNameAutoApproval() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "weekly-permissions-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let state = folder.appending(path: "state.json")
        let first = AppStore(stateURL: state, live: true)
        let snapshot = DiscoverySnapshot(projects: [.init(root: "/work/one/app", name: "app"), .init(root: "/work/two/app", name: "app")], sessions: [], agentStatus: [:], skippedTemporary: 0, issues: [])
        first.applyDiscovery(snapshot)
        first.decideProject("/work/one/app", permission: .allowed)
        let second = AppStore(stateURL: state, live: true)
        XCTAssertEqual(second.projects.count, 2)
        XCTAssertEqual(second.approvedProjects.map(\.id), ["/work/one/app"])
    }
}
