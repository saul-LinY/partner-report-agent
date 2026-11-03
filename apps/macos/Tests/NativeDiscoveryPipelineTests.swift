import XCTest
import SQLite3
@testable import WeeklyReportCore

@MainActor
final class NativeDiscoveryPipelineTests: XCTestCase {
    private func reader() throws -> URL {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "Resources/Reader/cc-session-reader")
        guard FileManager.default.isExecutableFile(atPath: file.path) else { throw XCTSkip("先运行 scripts/build.sh 构建随 App 打包的读取程序。") }
        return file
    }
    private func fixture() throws -> (URL, URL) {
        let home = FileManager.default.temporaryDirectory.appending(path: "weekly-pipeline-\(UUID())")
        let project = home.appending(path: "work/project")
        try FileManager.default.createDirectory(at: project.appending(path: ".git"), withIntermediateDirectories: true)
        return (home, project)
    }
    private func write(_ home: URL, _ path: String, _ records: [[String: Any]]) throws {
        let file = home.appending(path: path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try records.map { try JSONSerialization.data(withJSONObject: $0) }.reduce(into: Data()) { $0.append($1); $0.append(10) }
        try data.write(to: file)
    }
    private func verify(_ snapshot: DiscoverySnapshot, home: URL, project: URL, agent: Agent, expected: Int = 1) async throws {
        let bridge = LocalReader(executable: try reader(), workingDirectory: home.appending(path: "reader-work"))
        let store = AppStore(live: true, reader: bridge, discoveryHome: home)
        store.applyDiscovery(snapshot)
        XCTAssertTrue(store.sessions.isEmpty)
        let root = project.resolvingSymlinksInPath().path
        store.decideProject(root, permission: .allowed)
        store.selectedAgent = agent; store.reconcileSelection()
        XCTAssertEqual(store.visibleSessions.count, expected)
        for session in store.visibleSessions {
            store.selectSession(session.id); await store.loadSelectedSession()
            XCTAssertNil(store.readerError)
            XCTAssertEqual(store.selectedSession?.turns.first?.prompt, "question")
            XCTAssertEqual(store.selectedSession?.turns.first?.answer, "answer")
        }
    }
    func testUnindexedCodexFileIsDiscoveredThenReadOnlyAfterProjectApproval() async throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        try write(home, "custom-codex/sessions/2026/10/29/rollout-session.jsonl", [
            ["type": "session_meta", "payload": ["id": "native-codex", "cwd": project.path, "source": "cli"]],
            ["type": "response_item", "payload": ["type": "message", "id": "u", "role": "user", "content": [["type": "input_text", "text": "question"]]]],
            ["type": "response_item", "payload": ["type": "message", "id": "a", "role": "assistant", "phase": "final_answer", "content": [["type": "output_text", "text": "answer"]]]]
        ])
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: ["CODEX_HOME": home.appending(path: "custom-codex").path], metadataReader: try reader()).scan()
        try await verify(snapshot, home: home, project: project, agent: .codex)
    }
    func testFirstLaunchPersistsDetectedPathsAndRescansWithoutInheritedEnvironment() async throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let file = "custom-pi/sessions/session.jsonl"
        try write(home, file, [["type": "session", "id": "native-session", "cwd": project.path]])
        let source = home.appending(path: file)
        let handle = try FileHandle(forWritingTo: source); try handle.seekToEnd(); try handle.write(contentsOf: Data("INVALID_PRIVATE_BODY_MUST_NOT_BE_PARSED\n".utf8)); try handle.close()
        let state = home.appending(path: "app/state.json")
        let first = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: ["PI_CODING_AGENT_DIR": home.appending(path: "custom-pi").path, "OPENAI_API_KEY": "DO_NOT_PERSIST_CREDENTIALS"], metadataReader: try reader())
        await first.refreshDiscovery()
        XCTAssertNotNil(first.lastDiscoveredAt)
        XCTAssertEqual(first.projects.first?.permission, .pending)
        XCTAssertTrue(first.sessions.isEmpty)
        let expected = source.deletingLastPathComponent().resolvingSymlinksInPath().path
        XCTAssertTrue(first.detectedPaths(for: .pi).contains(expected))
        let report = home.appending(path: "app/source-discovery.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: report.path))
        XCTAssertFalse(try String(contentsOf: report, encoding: .utf8).contains("DO_NOT_PERSIST_CREDENTIALS"))
        let permissions = try FileManager.default.attributesOfItem(atPath: report.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        let next = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: try reader())
        await next.refreshDiscovery()
        XCTAssertTrue(next.detectedPaths(for: .pi).contains(expected))
        XCTAssertEqual(next.projects.first?.permission, .pending)
        XCTAssertTrue(next.sessions.isEmpty)
    }
    func testExternalCodexIndexLocationSurvivesRestartWithoutShellEnvironment() async throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let sessions = home.appending(path: ".codex/sessions")
        let external = home.appending(path: "external-index")
        try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true)
        let file = sessions.appending(path: "legacy.jsonl")
        try Data("INVALID_PRIVATE_BODY_NOT_NEEDED_FOR_INDEX_DISCOVERY".utf8).write(to: file)
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(external.appending(path: "state_10.sqlite").path, &db), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT); INSERT INTO threads VALUES('legacy','\(project.path)','\(file.path)');", nil, nil, nil), SQLITE_OK)
        sqlite3_close(db)
        let state = home.appending(path: "app/state.json")
        let first = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: ["CODEX_SQLITE_HOME": external.path], metadataReader: try reader())
        await first.refreshDiscovery()
        XCTAssertEqual(first.count(for: first.projects[0]), 1)
        let next = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: try reader())
        await next.refreshDiscovery()
        XCTAssertEqual(next.count(for: next.projects[0]), 1)
        XCTAssertTrue(next.sessions.isEmpty)
    }
    func testPiProfilesWithSameNativeIDRemainSeparateAndReadBothDirectories() async throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        for path in [".omp/agent/sessions/project", ".omp/profiles/team/agent/sessions/project"] {
            try write(home, path + "/session.jsonl", [
                ["type": "session", "id": "same-native-id", "version": 3, "cwd": project.path],
                ["type": "message", "id": "u", "message": ["role": "user", "content": [["type": "text", "text": "question"]]]],
                ["type": "message", "id": "a", "parentId": "u", "message": ["role": "assistant", "stopReason": "stop", "content": [["type": "text", "text": "answer"]]]]
            ])
        }
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: [:], metadataReader: try reader()).scan()
        XCTAssertEqual(Set(snapshot.sessions.map(\.groupID)).count, 2)
        try await verify(snapshot, home: home, project: project, agent: .omp, expected: 2)
        // Even callers passing both directories in one batch receive both native files without root rejection.
        let bridge = LocalReader(executable: try reader(), workingDirectory: home.appending(path: "multi-reader"))
        let result = try await bridge.read(sources: snapshot.sessions, authorizedRoot: project.resolvingSymlinksInPath().path)
        XCTAssertTrue(result.warnings.isEmpty)
        XCTAssertEqual(result.turns.first?.answer, "answer")
    }
    func testCustomHermesJSONLDirectoryReachesNativeReplyExtraction() async throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        try write(home, "custom-hermes/sessions/session.jsonl", [
            ["type": "session", "id": "native-hermes", "cwd": project.path],
            ["id": 1, "role": "user", "content": "question"],
            ["id": 2, "role": "assistant", "content": "answer", "finish_reason": "stop"]
        ])
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: ["HERMES_HOME": home.appending(path: "custom-hermes").path], metadataReader: try reader()).scan()
        try await verify(snapshot, home: home, project: project, agent: .hermes)
    }
    func testOpenCodeLegacyMetadataMessageAndPartChainAndFingerprint() async throws {
        let (home, project) = try fixture(); defer { try? FileManager.default.removeItem(at: home) }
        let base = "xdg/opencode/storage/"
        try write(home, base + "session/project/ses_01.json", [["id": "ses_01", "directory": project.path, "title": "native title"]])
        try write(home, base + "message/ses_01/msg_u.json", [["id": "msg_u", "sessionID": "ses_01", "role": "user", "time": ["created": 1793273127000]]])
        try write(home, base + "message/ses_01/msg_a.json", [["id": "msg_a", "sessionID": "ses_01", "role": "assistant", "finish": "stop", "time": ["created": 1793273128000], "path": ["cwd": project.path, "root": project.path]]])
        try write(home, base + "part/msg_u/prt_u.json", [["id": "prt_u", "sessionID": "ses_01", "messageID": "msg_u", "type": "text", "text": "question"]])
        try write(home, base + "part/msg_a/prt_a.json", [["id": "prt_a", "sessionID": "ses_01", "messageID": "msg_a", "type": "text", "text": "answer"]])
        let scanner = LocalDiscovery(home: home, temporaryRoots: [], environment: ["XDG_DATA_HOME": home.appending(path: "xdg").path], metadataReader: try reader())
        let snapshot = scanner.scan()
        try await verify(snapshot, home: home, project: project, agent: .opencode)
        try write(home, base + "part/msg_a/prt_a.json", [["id": "prt_a", "sessionID": "ses_01", "messageID": "msg_a", "type": "text", "text": "updated answer"]])
        XCTAssertNotEqual(snapshot.sessions.first?.fingerprint, scanner.scan().sessions.first?.fingerprint)
    }
}
