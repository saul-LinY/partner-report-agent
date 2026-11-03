import XCTest
import SQLite3
@testable import WeeklyReportCore

final class SourceLocationsTests: XCTestCase {
    private func home() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "weekly-locations-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func folder(_ home: URL, _ path: String) throws -> URL {
        let url = home.appending(path: path)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func head(_ directory: URL, id: String, cwd: URL) throws {
        let record: [String: Any] = ["type": "session", "id": id, "sessionId": id, "cwd": cwd.path]
        try JSONSerialization.data(withJSONObject: record).write(to: directory.appending(path: "\(id).jsonl"))
    }
    private func database(_ file: URL, sql: String) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(file.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw NSError(domain: "Fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))]) }
    }
    func testEnvironmentNativeSettingsAndDefaultsAreSupplementalAndRemembered() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let pi = try folder(home, "custom-pi")
        let sessions = try folder(home, "pi-history")
        _ = try folder(home, ".pi/agent/sessions")
        try Data("{ // native JSON5\n sessionDir: '\(sessions.path)',\n ignoredCredential: 'MUST_NOT_BE_PROJECTED' }".utf8).write(to: pi.appending(path: "settings.json"))
        let first = SourceLocations(home: home, environment: ["PI_CODING_AGENT_DIR": pi.path]).resolve()
        let paths = Set(first.locations.filter { $0.agent == .pi && $0.exists }.map(\.sessionPath))
        XCTAssertTrue(paths.contains(sessions.resolvingSymlinksInPath().path))
        XCTAssertTrue(paths.contains(home.appending(path: ".pi/agent/sessions").resolvingSymlinksInPath().path))
        let next = SourceLocations(home: home, environment: [:], remembered: first.locations).resolve()
        XCTAssertTrue(next.locations.contains { $0.agent == .pi && $0.sessionPath == sessions.resolvingSymlinksInPath().path && $0.origin == "上次发现" })
    }
    func testRelativePiSessionDirectoryIsReportedWithoutInventingACwd() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let pi = try folder(home, ".pi/agent")
        try Data("{\"sessionDir\":\"relative/history\"}".utf8).write(to: pi.appending(path: "settings.json"))
        let result = SourceLocations(home: home, environment: ["PI_CODING_AGENT_SESSION_DIR": "relative/other"]).resolve()
        XCTAssertEqual(result.issues.count, 2)
        XCTAssertFalse(result.locations.contains { $0.sessionPath.contains("relative") })
    }
    func testOMPEnvironmentDoesNotRelabelItsSessionsAsPi() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let agent = try folder(home, ".custom-omp/agent")
        let history = try folder(agent, "sessions")
        let result = SourceLocations(home: home, environment: ["OMP_PROFILE": "default", "PI_CODING_AGENT_DIR": agent.path, "PI_CODING_AGENT_SESSION_DIR": history.path]).resolve()
        let paths = result.locations.filter { $0.exists && $0.sessionPath == history.resolvingSymlinksInPath().path }
        XCTAssertEqual(Set(paths.map(\.agent)), [.omp])
    }
    func testCodexSQLitePathIsNotReadFromMultilineOrNestedConfigText() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let codex = try folder(home, ".codex")
        let db = try folder(home, "real-db")
        let config = "notes = '''\nsqlite_home = '/wrong-db'\n'''\nsqlite_home = '\(db.path)'\n[other]\nsqlite_home='/nested-wrong'\n"
        try Data(config.utf8).write(to: codex.appending(path: "config.toml"))
        let paths = SourceLocations.codexDatabaseDirectories(agentDirectory: codex, home: home, environment: ["CODEX_SQLITE_HOME": "/ignored-env"])
        XCTAssertEqual(Set(paths.map(\.path)), Set([codex, db].map { $0.resolvingSymlinksInPath().path }))
    }
    func testSwitchDirectoryOverridesAccountsAndPrivateAgyDataRoot() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let ccs = try folder(home, ".cc-switch")
        let claude = try folder(home, "custom-claude/projects")
        let data = try folder(home, "switch-data")
        let account = try folder(data, "claude-accounts/" + String(repeating: "a", count: 32) + "/config/projects")
        let brain = try folder(data, "agy/private/antigravity-cli/brain")
        let appData = try folder(home, "Library/Application Support/com.ccswitch.desktop")
        try JSONSerialization.data(withJSONObject: ["claudeConfigDir": claude.deletingLastPathComponent().path]).write(to: ccs.appending(path: "settings.json"))
        try JSONSerialization.data(withJSONObject: ["app_config_dir_override": data.path]).write(to: appData.appending(path: "app_paths.json"))
        let paths = Set(SourceLocations(home: home, environment: [:]).resolve().locations.filter(\.exists).map(\.sessionPath))
        for path in [claude, account, brain] { XCTAssertTrue(paths.contains(path.resolvingSymlinksInPath().path)) }
    }
    func testCustomOMPAndXDGProfilesAreDiscoveredButGrokArchivesAreExcluded() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let project = try folder(home, "work/project/.git").deletingLastPathComponent()
        let paths = [try folder(home, ".team/profiles/work/agent/sessions/project"), try folder(home, "xdg/omp/profiles/work/sessions/project")]
        for (i, path) in paths.enumerated() { try head(path, id: "omp-\(i)", cwd: project) }
        let grok = try folder(home, "custom-grok/archived_sessions/encoded/session-01")
        try JSONSerialization.data(withJSONObject: ["info": ["id": "session-01", "cwd": project.path]]).write(to: grok.appending(path: "summary.json"))
        let snapshot = LocalDiscovery(home: home, pathOverrides: ["grokbuild": home.appending(path: "custom-grok/sessions").path], temporaryRoots: [], environment: ["PI_CONFIG_DIR": ".team", "XDG_DATA_HOME": home.appending(path: "xdg").path], metadataReader: nil).scan()
        XCTAssertEqual(snapshot.sessions.filter { $0.agent == .omp }.count, 2)
        XCTAssertEqual(snapshot.sessions.filter { $0.agent == .grokbuild }.count, 0)
    }
    func testCodexWithoutIndexAndExternalSQLiteAllVersions() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let project = try folder(home, "work/project/.git").deletingLastPathComponent()
        let sessions = try folder(home, "custom-codex/sessions/2026/10/29")
        let rollout = sessions.appending(path: "rollout-native.jsonl")
        try JSONSerialization.data(withJSONObject: ["type": "session_meta", "payload": ["id": "native", "cwd": project.path]]).write(to: rollout)
        let noIndex = LocalDiscovery(home: home, temporaryRoots: [], environment: ["CODEX_HOME": home.appending(path: "custom-codex").path], metadataReader: nil).scan()
        XCTAssertEqual(noIndex.sessions.filter { $0.agent == .codex }.count, 1)
        let external = try folder(home, "sqlite-home")
        try Data("sqlite_home = '\(external.path)'\n[model]\nsqlite_home='IGNORE_NESTED'\n".utf8).write(to: home.appending(path: "custom-codex/config.toml"))
        for version in [9, 10] {
            let file = sessions.appending(path: "index-\(version).jsonl"); try Data("INVALID_BODY_NOT_NEEDED_FOR_INDEX_SCAN".utf8).write(to: file)
            try database(external.appending(path: "state_\(version).sqlite"), sql: "CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT); INSERT INTO threads VALUES('native-\(version)','\(project.path)','\(file.path)');")
        }
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: ["CODEX_HOME": home.appending(path: "custom-codex").path], metadataReader: nil).scan()
        XCTAssertEqual(Set(snapshot.sessions.filter { $0.agent == .codex }.map(\.nativeID)), ["native", "native-9", "native-10"])
    }
    func testCodexArchivesExcludedAndDifferentHomesStaySeparate() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let project = try folder(home, "work/project/.git").deletingLastPathComponent()
        let locations = [try folder(home, ".codex/sessions/2026"), try folder(home, ".codex/archived_sessions"), try folder(home, "other-codex/sessions/2026")]
        for path in locations {
            try JSONSerialization.data(withJSONObject: ["type": "session_meta", "payload": ["id": "same-native", "cwd": project.path]]).write(to: path.appending(path: "session.jsonl"))
        }
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: ["CODEX_HOME": home.appending(path: "other-codex").path], metadataReader: nil).scan()
        XCTAssertEqual(snapshot.sessions.count, 2)
        XCTAssertEqual(Set(snapshot.sessions.map(\.groupID)).count, 2)
    }
    func testArchivedCodexDatabaseFlagPreventsFileRediscovery() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let project = try folder(home, "work/project/.git").deletingLastPathComponent()
        let sessions = try folder(home, ".codex/sessions")
        let id = "a0000000-0000-0000-0000-000000000001"
        let file = sessions.appending(path: "rollout-\(id).jsonl")
        try JSONSerialization.data(withJSONObject: ["type": "session_meta", "payload": ["id": id, "cwd": project.path]]).write(to: file)
        try database(home.appending(path: ".codex/state_5.sqlite"), sql: "CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,archived INTEGER); INSERT INTO threads VALUES('\(id)','\(project.path)','\(file.path)',1);")
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: [:], metadataReader: nil).scan()
        XCTAssertTrue(snapshot.sessions.isEmpty)
        XCTAssertTrue(snapshot.projects.isEmpty)
    }
    func testArchivedV2OpenCodeIDDoesNotFallBackToActiveLegacyRow() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let project = try folder(home, "work/project/.git").deletingLastPathComponent()
        let data = try folder(home, ".local/share/opencode")
        let db = data.appending(path: "opencode.db")
        try database(db, sql: "CREATE TABLE session_v2(id TEXT,directory TEXT,time_archived INTEGER); CREATE TABLE session(id TEXT,directory TEXT); INSERT INTO session_v2 VALUES('archived','\(project.path)',123); INSERT INTO session VALUES('archived','\(project.path)'); INSERT INTO session VALUES('active','\(project.path)');")
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: [:], metadataReader: nil).scan()
        XCTAssertEqual(snapshot.sessions.map(\.nativeID), ["active"])
    }
    func testOpenCodeV2AndHermesAlternateMetadataColumnsAndActualPaths() throws {
        let home = try home(); defer { try? FileManager.default.removeItem(at: home) }
        let project = try folder(home, "work/project/.git").deletingLastPathComponent()
        let data = try folder(home, "xdg/opencode")
        let db = data.appending(path: "desktop.db")
        try database(db, sql: "CREATE TABLE session_v2(id TEXT,directory TEXT,parent_id TEXT,time_updated INTEGER); INSERT INTO session_v2 VALUES('ses_v2','\(project.path)',NULL,1793273127000); INSERT INTO session_v2 VALUES('ses_child','\(project.path)','ses_v2',1793273127000); CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_updated INTEGER); INSERT INTO session VALUES('ses_child','\(project.path)',NULL,1793273127000);")
        let hermes = try folder(home, "custom-hermes")
        try database(hermes.appending(path: "state.db"), sql: "CREATE TABLE sessions(id TEXT,directory TEXT,created_at REAL); INSERT INTO sessions VALUES('hermes','\(project.path)',1793273127);")
        let snapshot = LocalDiscovery(home: home, temporaryRoots: [], environment: ["XDG_DATA_HOME": home.appending(path: "xdg").path, "OPENCODE_DB": "desktop.db", "HERMES_HOME": hermes.path], metadataReader: nil).scan()
        XCTAssertEqual(snapshot.sessions.filter { $0.agent == .opencode }.map(\.nativeID), ["ses_v2"])
        XCTAssertEqual(snapshot.sessions.filter { $0.agent == .hermes }.map(\.nativeID), ["hermes"])
        XCTAssertTrue(snapshot.locations.contains { $0.agent == .opencode && $0.sessionPath == db.resolvingSymlinksInPath().path && $0.exists })
    }
}
