import XCTest
import SQLite3
@testable import WeeklyReportCore

final class AuthorizedSourceTests: XCTestCase {
    private func fixture() throws -> (home: URL, project: URL) {
        let home = FileManager.default.temporaryDirectory.appending(path: "authorized-sources-\(UUID())")
        let project = home.appending(path: "work/project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        return (home.resolvingSymlinksInPath(), project.resolvingSymlinksInPath())
    }

    private func source(_ agent: Agent, id: String, path: String, project: URL, cwd: String? = nil, storeRoot: String? = nil) -> LocalSessionSource {
        .init(id: "\(agent.id):\(id):\(path)", agent: agent, nativeID: id, source: path, cwd: cwd ?? project.path,
              projectRoot: project.path, modifiedAt: .now, fingerprint: "fixture", storeRoot: storeRoot)
    }

    private func write(_ text: String, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }

    private func json(_ object: Any, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: file)
    }

    private func jsonLines(_ records: [[String: Any]], to file: URL, trailingNewline: Bool = true) throws {
        let text = try records.map { String(decoding: try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]), as: UTF8.self) }.joined(separator: "\n")
        try write(text + (trailingNewline ? "\n" : ""), to: file)
    }

    private func database(_ file: URL, sql: String) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var db: OpaquePointer?
        guard sqlite3_open(file.path, &db) == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }
            throw NSError(domain: "AuthorizedSourceFixture", code: 1)
        }
        defer { sqlite3_close(db) }
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw NSError(domain: "AuthorizedSourceFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
        }
    }

    private func quoted(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "''") + "'" }

    func testCodexSameIDIsScopedToEnvironmentCCSwitchAndManualRoots() throws {
        let (home, project) = try fixture()
        let roots = [home.appending(path: "environment-home"), home.appending(path: "switch-home"), home.appending(path: "manual-home")]
        try json(["codexConfigDir": roots[1].path], to: home.appending(path: ".cc-switch/settings.json"))
        try jsonLines([["id": "shared", "thread_name": "unrelated default title"]], to: home.appending(path: ".codex/session_index.jsonl"))
        var sources: [LocalSessionSource] = []
        for (index, root) in roots.enumerated() {
            let sessions = root.appending(path: "sessions")
            let file = sessions.appending(path: "2026/10/29/rollout-shared.jsonl")
            try write("No transcript parsing is needed for an indexed title.", to: file)
            try jsonLines([["id": "shared", "thread_name": "old label"], ["id": "shared", "thread_name": "root \(index)"]], to: root.appending(path: "session_index.jsonl"))
            sources.append(source(.codex, id: "shared", path: file.path, project: project, storeRoot: sessions.path))
        }
        let titles = AuthorizedTitles(home: home, pathOverrides: ["codex": roots[2].path], environment: ["CODEX_HOME": roots[0].path])
            .read(sources: sources, allowedRoots: [project.path])
        XCTAssertEqual(titles.count, 3)
        for (index, item) in sources.enumerated() { XCTAssertEqual(titles[item.groupID], "root \(index)") }
        XCTAssertNil(titles["codex:shared"])
    }

    func testCodexArchivedSourceNeverReadsTitles() throws {
        let (home, project) = try fixture()
        let original = home.appending(path: "retired-profile")
        let file = original.appending(path: "archived_sessions/2026/rollout-original.jsonl.zst")
        try write("Not a real compressed transcript; only the ancestor index may be read.", to: file)
        try jsonLines([["id": "original", "thread_name": "original profile label"]], to: original.appending(path: "session_index.jsonl"))
        try jsonLines([["id": "original", "thread_name": "wrong current label"]], to: home.appending(path: ".codex/session_index.jsonl"))
        let item = source(.codex, id: "original", path: file.path, project: project)
        XCTAssertEqual(AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: [item], allowedRoots: [project.path]), [:])
    }

    func testCodexOneIndexServesAllAuthorizedIDsAndExcludesDeniedSources() throws {
        let (home, project) = try fixture()
        let sessions = home.appending(path: ".codex/sessions")
        try jsonLines([
            ["id": "first", "thread_name": "first approved label"],
            ["id": "second", "thread_name": "second approved label"],
            ["id": "denied", "thread_name": "denied label"]
        ], to: home.appending(path: ".codex/session_index.jsonl"))
        let approved = ["first", "second"].map { id in source(.codex, id: id, path: sessions.appending(path: "rollout-\(id).jsonl").path, project: project) }
        let denied = source(.codex, id: "denied", path: sessions.appending(path: "rollout-denied.jsonl").path, project: home.appending(path: "unapproved"))
        let titles = AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: approved + [denied], allowedRoots: [project.path])
        XCTAssertEqual(titles, [approved[0].groupID: "first approved label", approved[1].groupID: "second approved label"])
    }

    func testCodexChecksAllStateDatabasesAndRequiresIDAndCwd() throws {
        let (home, project) = try fixture()
        let root = home.appending(path: ".codex")
        let cwd = quoted(project.path)
        try database(root.appending(path: "state_10.sqlite"), sql: "CREATE TABLE threads(id TEXT,cwd TEXT,name TEXT,title TEXT); INSERT INTO threads VALUES('other',\(cwd),'other name','other title');")
        try database(root.appending(path: "state_9.sqlite"), sql: "CREATE TABLE threads(id TEXT,cwd TEXT,name TEXT,title TEXT); INSERT INTO threads VALUES('wanted','/outside/project','wrong project name','wrong project title');")
        // A valid older schema without name must still be consulted.
        try database(root.appending(path: "state_5.sqlite"), sql: "CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT); INSERT INTO threads VALUES('wanted',\(cwd),'matching older database');")
        let item = source(.codex, id: "wanted", path: root.appending(path: "sessions/rollout-wanted.jsonl").path, project: project)
        XCTAssertEqual(AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: [item], allowedRoots: [project.path]), [item.groupID: "matching older database"])
        let missing = source(.codex, id: "missing", path: item.source, project: project)
        XCTAssertTrue(AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: [missing], allowedRoots: [project.path]).isEmpty)
    }

    func testCodexRootSQLiteHomeAndEnvironmentDatabaseRemainSourceScoped() throws {
        let (home, project) = try fixture()
        let configuredRoot = home.appending(path: "configured-codex")
        let environmentRoot = home.appending(path: "environment-codex")
        let configuredDB = home.appending(path: "configured database # one")
        let environmentDB = home.appending(path: "environment-database")
        try write("sqlite_home = '\(configuredDB.path)' # exact root path field\n[profiles.other]\nsqlite_home = '/unrelated'\n", to: configuredRoot.appending(path: "config.toml"))
        // A similarly named field and a profile field must not displace the environment.
        try write("other_sqlite_home = '/unrelated'\n[profiles.other]\nsqlite_home = '/unrelated'\n", to: environmentRoot.appending(path: "config.toml"))
        for (folder, title) in [(configuredDB, "configured database label"), (environmentDB, "environment database label")] {
            try database(folder.appending(path: "state_5.sqlite"), sql: "CREATE TABLE threads(id TEXT,cwd TEXT,name TEXT,title TEXT); INSERT INTO threads VALUES('shared',\(quoted(project.path)),NULL,\(quoted(title)));")
        }
        let items = [configuredRoot, environmentRoot].map { root in
            source(.codex, id: "shared", path: root.appending(path: "sessions/rollout-shared.jsonl").path, project: project, storeRoot: root.appending(path: "sessions").path)
        }
        let titles = AuthorizedTitles(home: home, pathOverrides: [:], environment: ["CODEX_SQLITE_HOME": environmentDB.path]).read(sources: items, allowedRoots: [project.path])
        XCTAssertEqual(titles[items[0].groupID], "configured database label")
        XCTAssertEqual(titles[items[1].groupID], "environment database label")
    }

    func testOpenCodeV2WinsAndSameIDUsesItsActualDatabase() throws {
        let (home, project) = try fixture()
        var items: [LocalSessionSource] = []
        for (index, name) in ["first.db", "second.db"].enumerated() {
            let db = home.appending(path: name)
            try database(db, sql: "CREATE TABLE session(id TEXT,directory TEXT,title TEXT); CREATE TABLE session_v2(id TEXT,directory TEXT,title TEXT); CREATE TABLE session_message(id TEXT,session_id TEXT); INSERT INTO session VALUES('ses_shared',\(quoted(project.path)),'obsolete V1 title'); INSERT INTO session_v2 VALUES('ses_shared',\(quoted(project.path)), 'V2 database \(index)'); INSERT INTO session VALUES('ses_legacy',\(quoted(project.path)),'V1 only title');")
            items.append(source(.opencode, id: "ses_shared", path: "sqlite:\(db.path):ses_shared", project: project, storeRoot: db.path))
        }
        let loader = AuthorizedTitles(home: home, pathOverrides: [:], environment: [:])
        let titles = loader.read(sources: items, allowedRoots: [project.path])
        XCTAssertEqual(titles.count, 2)
        for (index, item) in items.enumerated() { XCTAssertEqual(titles[item.groupID], "V2 database \(index)") }
        let legacy = source(.opencode, id: "ses_legacy", path: "sqlite:\(home.appending(path: "first.db").path):ses_legacy", project: project)
        XCTAssertEqual(loader.read(sources: [legacy], allowedRoots: [project.path]), [legacy.groupID: "V1 only title"])
    }

    func testOpenCodeMovedV2DoesNotFallBackToStaleV1OrAnotherSessionID() throws {
        let (home, project) = try fixture()
        let db = home.appending(path: "opencode.db")
        try database(db, sql: "CREATE TABLE session(id TEXT,directory TEXT,title TEXT); CREATE TABLE session_v2(id TEXT,directory TEXT,title TEXT); CREATE TABLE session_message(id TEXT,session_id TEXT); INSERT INTO session VALUES('ses_moved',\(quoted(project.path)),'stale V1 title'); INSERT INTO session_v2 VALUES('ses_moved','/outside/project','unapproved title');")
        let moved = source(.opencode, id: "ses_moved", path: "sqlite:\(db.path):ses_moved", project: project)
        let mismatched = source(.opencode, id: "ses_different", path: moved.source, project: project)
        XCTAssertTrue(AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: [moved, mismatched], allowedRoots: [project.path]).isEmpty)
    }

    func testOpenCodeLegacyJSONReadsSessionMetadataForBothSourceForms() throws {
        let (home, project) = try fixture()
        let storage = home.appending(path: "custom-opencode/storage")
        let metadata = storage.appending(path: "session/project-hash/ses_legacy.json")
        let messages = storage.appending(path: "message/ses_legacy")
        try json(["id": "ses_legacy", "directory": project.path, "title": "  legacy metadata label  "], to: metadata)
        try write("INVALID_MESSAGE_JSON_MUST_NOT_BE_PARSED", to: messages.appending(path: "message.json"))
        let loader = AuthorizedTitles(home: home, pathOverrides: [:], environment: [:])
        for path in [metadata.path, messages.path] {
            let item = source(.opencode, id: "ses_legacy", path: path, project: project, storeRoot: storage.path)
            XCTAssertEqual(loader.read(sources: [item], allowedRoots: [project.path]), [item.groupID: "legacy metadata label"])
            XCTAssertTrue(loader.read(sources: [item], allowedRoots: []).isEmpty)
        }
        try json(["id": "ses_legacy", "directory": "/outside/project", "title": "unapproved title"], to: metadata)
        let moved = source(.opencode, id: "ses_legacy", path: metadata.path, project: project)
        XCTAssertTrue(loader.read(sources: [moved], allowedRoots: [project.path]).isEmpty)
    }

    func testClaudeRejectsAnyCrossProjectMigrationEvenIfItReturnsAndBothRootsAreAllowed() throws {
        let (home, project) = try fixture()
        let other = home.appending(path: "work/project-other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let file = home.appending(path: ".claude/projects/encoded/session.jsonl")
        try jsonLines([
            ["sessionId": "claude", "cwd": project.path],
            ["type": "custom-title", "customTitle": "initial title"],
            ["type": "relocated", "relocatedCwd": other.path],
            ["type": "custom-title", "customTitle": "unapproved migration title"],
            ["type": "relocated", "relocatedCwd": project.path]
        ], to: file)
        try json(["entries": [["sessionId": "claude", "summary": "index must not bypass preflight"]]], to: file.deletingLastPathComponent().appending(path: "sessions-index.json"))
        let item = source(.claude, id: "claude", path: file.path, project: project)
        XCTAssertTrue(AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: [item], allowedRoots: [project.path, other.path]).isEmpty)
    }

    func testClaudeChecksLateCwdAndFinalLineWithoutNewlineBeforeIndexFallback() throws {
        let (home, project) = try fixture()
        let file = home.appending(path: "claude/session.jsonl")
        var records: [[String: Any]] = [["sessionId": "claude", "cwd": project.path]]
        // Put the offending cwd beyond both the old head scan and one read buffer.
        records += (0..<2500).map { ["sessionId": "claude", "sequence": $0] }
        records.append(["sessionId": "claude", "cwd": project.path + "-sibling"])
        try jsonLines(records, to: file, trailingNewline: false)
        try json(["entries": [["sessionId": "claude", "summary": "must not be loaded"]]], to: file.deletingLastPathComponent().appending(path: "sessions-index.json"))
        let item = source(.claude, id: "claude", path: file.path, project: project)
        XCTAssertTrue(AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: [item], allowedRoots: [project.path]).isEmpty)
    }

    func testClaudeAllowsNestedDirectoriesAndRejectsMismatchedIdentityOrMalformedTail() throws {
        let (home, project) = try fixture()
        let file = home.appending(path: "claude/session.jsonl")
        let records: [[String: Any]] = [
            ["sessionId": "claude", "cwd": project.path],
            ["type": "custom-title", "customTitle": "old title"],
            ["sessionId": "claude", "cwd": project.appending(path: "Sources").path],
            ["type": "relocated", "relocatedCwd": project.appending(path: "Tests").path],
            ["type": "custom-title", "customTitle": "approved final title"]
        ]
        try jsonLines(records, to: file, trailingNewline: false)
        let item = source(.claude, id: "claude", path: file.path, project: project)
        let loader = AuthorizedTitles(home: home, pathOverrides: [:], environment: [:])
        XCTAssertEqual(loader.read(sources: [item], allowedRoots: [project.path]), [item.groupID: "approved final title"])
        try jsonLines(records + [["sessionId": "another-session"]], to: file)
        XCTAssertTrue(loader.read(sources: [item], allowedRoots: [project.path]).isEmpty)
        try jsonLines(records, to: file)
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd(); try handle.write(contentsOf: Data("{incomplete".utf8)); try handle.close()
        XCTAssertTrue(loader.read(sources: [item], allowedRoots: [project.path]).isEmpty)
    }

    func testClaudeTitleAfterLargeChunkedLineAndWithoutTrailingNewline() throws {
        let (home, project) = try fixture()
        let file = home.appending(path: "claude/session.jsonl")
        let records: [[String: Any]] = [
            ["sessionId": "claude", "cwd": project.path],
            ["sessionId": "claude", "payload": String(repeating: "x", count: 2 * 1024 * 1024 + 17)],
            ["type": "custom-title", "customTitle": "title after long line"]
        ]
        try jsonLines(records, to: file, trailingNewline: false)
        let item = source(.claude, id: "claude", path: file.path, project: project)
        let loader = AuthorizedTitles(home: home, pathOverrides: [:], environment: [:])
        let valid = loader.readWithValidation(sources: [item], allowedRoots: [project.path])
        XCTAssertEqual(valid.titles, [item.groupID: "title after long line"])
        XCTAssertEqual(valid.validatedClaudeKeys, [item.groupID])
        try jsonLines(records + [["sessionId": "claude", "cwd": project.path + "-outside"]], to: file)
        let rejected = loader.readWithValidation(sources: [item], allowedRoots: [project.path])
        XCTAssertTrue(rejected.titles.isEmpty)
        XCTAssertTrue(rejected.validatedClaudeKeys.isEmpty)
    }

    func testClaudeWithoutCustomTitleIsValidatedButIncompleteFileIsNotCached() throws {
        let (home, project) = try fixture()
        let file = home.appending(path: "claude/session.jsonl")
        try jsonLines([["sessionId": "claude", "cwd": project.path]], to: file)
        let item = source(.claude, id: "claude", path: file.path, project: project)
        let loader = AuthorizedTitles(home: home, pathOverrides: [:], environment: [:])
        let valid = loader.readWithValidation(sources: [item], allowedRoots: [project.path])
        XCTAssertTrue(valid.titles.isEmpty)
        XCTAssertEqual(valid.validatedClaudeKeys, [item.groupID])
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd(); try handle.write(contentsOf: Data("{incomplete".utf8)); try handle.close()
        let incomplete = loader.readWithValidation(sources: [item], allowedRoots: [project.path])
        XCTAssertTrue(incomplete.validatedClaudeKeys.isEmpty)
    }

    func testClaudeRejectsSymlinkEscapeAndSpoofedApprovedProject() throws {
        let (home, project) = try fixture()
        let outside = home.appending(path: "outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let link = project.appending(path: "linked")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        let file = home.appending(path: "claude/session.jsonl")
        try jsonLines([["sessionId": "claude", "cwd": link.path], ["type": "custom-title", "customTitle": "outside title"]], to: file)
        let item = source(.claude, id: "claude", path: file.path, project: project)
        let spoofed = source(.claude, id: "claude", path: file.path, project: project, cwd: outside.path)
        XCTAssertTrue(AuthorizedTitles(home: home, pathOverrides: [:], environment: [:]).read(sources: [item, spoofed], allowedRoots: [project.path]).isEmpty)
    }
}
