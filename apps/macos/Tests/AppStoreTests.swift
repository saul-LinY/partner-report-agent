import XCTest
@testable import WeeklyReportCore

@MainActor
final class AppStoreTests: XCTestCase {
    func testSidebarOnlyListsApprovedSpecificProjects() async {
        let store = AppStore()
        XCTAssertEqual(store.approvedProjects.map(\.id), ["website", "content", "platform"])
        XCTAssertEqual(store.selectedProjectID, "website")
        XCTAssertEqual(store.visibleSessions.count, 3)
        store.selectProject("mobile")
        XCTAssertEqual(store.selectedProjectID, "website")
    }
    func testSearchAndAgentCountsStayInsideSelectedProject() async {
        let store = AppStore()
        XCTAssertEqual(store.count(for: .codex), 1)
        store.query = "失效的图片"
        store.reconcileSelection()
        XCTAssertTrue(store.visibleSessions.isEmpty)
        XCTAssertNil(store.selectedSession)
        store.query = ""
        store.selectProject("content")
        store.selectedAgent = .codex
        store.reconcileSelection()
        XCTAssertEqual(store.visibleSessions.map(\.id), ["s6"])
        store.query = "替换素材"
        XCTAssertEqual(store.visibleSessions.map(\.id), ["s6"])
    }
    func testIncompleteTurnPreservesPromptWithoutInventingAnswer() async {
        let store = AppStore()
        store.selectProject("content")
        let session = try! XCTUnwrap(store.selectedSession)
        XCTAssertEqual(session.agent, .omp)
        XCTAssertFalse(session.turns[0].prompt.isEmpty)
        XCTAssertNil(session.turns[0].answer)
    }
    func testAgentMenuCountsMatchFiltersWithoutBeingLimitedToSelectedAgent() async {
        let store = AppStore()
        let total = store.count(for: nil as Agent?)
        XCTAssertEqual(Agent.allCases.reduce(0) { $0 + store.count(for: $1) }, total)
        store.selectedAgent = .codex
        XCTAssertEqual(store.count(for: nil as Agent?), total)
        for pending in [false, true] {
            store.uploadFilter = pending ? .pending : .all
            for agent in Agent.allCases {
                store.selectedAgent = agent
                XCTAssertEqual(store.count(for: agent), store.visibleSessions.count)
            }
        }
        store.uploadFilter = .all
        store.selectProject("content")
        XCTAssertEqual(store.count(for: .codex), 1)
        store.query = "不存在的会话标题"
        XCTAssertEqual(store.count(for: nil as Agent?), 0)
        store.selectedProjectID = "mobile"
        XCTAssertEqual(store.count(for: nil as Agent?), 0)
    }
    func testRegistrationRemainsPendingAndRejectsDuplicates() async throws {
        let store = AppStore()
        try store.registerProject(name: "客户文档", folder: "/tmp/weekly-report-documents")
        XCTAssertEqual(store.projects.last?.permission, .pending)
        XCTAssertFalse(store.approvedProjects.contains { $0.name == "客户文档" })
        XCTAssertThrowsError(try store.registerProject(name: "客户文档", folder: "/tmp/other"))
        XCTAssertThrowsError(try store.registerProject(name: "另一个名称", folder: "/tmp/weekly-report-documents/../weekly-report-documents"))
    }
    func testExcludingASessionTakesItOutOfPendingAndSurvivesRelaunch() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "weekly-report-tests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appending(path: "state.json")
        let first = AppStore(stateURL: url)
        let session = try XCTUnwrap(first.pendingSessions.first)
        let waiting = first.pendingSessions.count
        first.selectProject(session.projectID)

        first.setUploadExcluded(true, for: session.id)
        XCTAssertEqual(first.uploadState(of: session), .excluded)
        XCTAssertEqual(first.pendingSessions.count, waiting - 1)
        XCTAssertEqual(first.excludedSessionCount, 1)
        first.uploadFilter = .excluded
        XCTAssertEqual(first.visibleSessions.map(\.id), [session.id])
        first.uploadFilter = .pending
        XCTAssertFalse(first.visibleSessions.contains { $0.id == session.id })

        let second = AppStore(stateURL: url)
        XCTAssertEqual(second.excludedSessionCount, 1)
        second.setUploadExcluded(false, for: session.id)
        XCTAssertEqual(second.pendingSessions.count, waiting)
        XCTAssertEqual(second.excludedSessionCount, 0)
    }
    func testHiddenExpressionsAreCheckedKeptAcrossRelaunchAndRemovable() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "weekly-report-tests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appending(path: "state.json")
        let first = AppStore(stateURL: url)
        XCTAssertEqual(first.hidePattern("客户[A-Z"), .invalid)
        XCTAssertEqual(first.hidePattern("a*"), .matchesEmptyText)
        XCTAssertTrue(first.hiddenPatterns.isEmpty)
        XCTAssertNil(first.hidePattern(#"客户[A-Z]\d+"#))
        XCTAssertNil(first.hidePattern(#"客户[A-Z]\d+"#))
        XCTAssertEqual(first.hiddenPatterns, [#"客户[A-Z]\d+"#])
        XCTAssertEqual(first.hiding.patterns, first.hiddenPatterns)

        let second = AppStore(stateURL: url)
        XCTAssertEqual(second.hiddenPatterns, [#"客户[A-Z]\d+"#])
        second.unhidePattern(#"客户[A-Z]\d+"#)
        XCTAssertTrue(second.hiddenPatterns.isEmpty)
        XCTAssertTrue(AppStore(stateURL: url).hiddenPatterns.isEmpty)
    }
    func testPreferencesAndLocalStateSurviveRelaunch() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "weekly-report-tests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appending(path: "state.json")
        let first = AppStore(stateURL: url)
        first.updatePreferences { $0.frequency = .weekly; $0.automaticUpdates = false; $0.uploadWeekday = 4 }
        try first.registerProject(name: "本地资料", folder: "/tmp/weekly-report-local-documents")
        let second = AppStore(stateURL: url)
        XCTAssertEqual(second.preferences.frequency, .weekly)
        XCTAssertFalse(second.preferences.automaticUpdates)
        XCTAssertEqual(second.preferences.uploadWeekday, 4)
        XCTAssertEqual(second.projects.last?.permission, .pending)
    }
    func testRepeatedLocalUploadDoesNotDuplicateAndDoesNotNeedServer() async {
        let store = AppStore()
        XCTAssertEqual(store.pendingSessions.count, 1)
        let initial = store.uploadRecords.count
        await store.runLocalUpload()
        XCTAssertTrue(store.pendingSessions.isEmpty)
        XCTAssertEqual(store.uploadRecords.count, initial + 1)
        XCTAssertEqual(store.uploadRecords[0].kind, "手动演示")
        XCTAssertTrue(store.uploadRecords[0].details.last!.contains("未调用"))
        await store.runLocalUpload()
        XCTAssertEqual(store.uploadRecords.count, initial + 1)
    }
    func testCorruptStateIsPreserved() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "weekly-report-corrupt-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appending(path: "state.json")
        try Data("broken".utf8).write(to: url)
        let store = AppStore(stateURL: url)
        XCTAssertNotNil(store.storageError)
        store.updatePreferences { $0.automaticUpdates = false }
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "broken")
    }
    func testOnlyDailyAndWeeklySchedulesAndOldValuesMigrate() async throws {
        XCTAssertEqual(UploadFrequency.allCases, [.daily, .weekly])
        let old = try JSONDecoder().decode(UploadFrequency.self, from: Data("\"halfHour\"".utf8))
        XCTAssertEqual(old, .daily)
        let store = AppStore()
        store.updatePreferences { $0.frequency = .weekly; $0.uploadWeekday = 4; $0.uploadHour = 17; $0.uploadMinute = 30 }
        XCTAssertEqual(store.preferences.scheduleLabel, "每周三 17:30 上传")
    }
}
