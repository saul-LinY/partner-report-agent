import XCTest
@testable import WeeklyReportCore

@MainActor
final class StartupTests: XCTestCase {
    func testScanWindowUsesOneCalendarMonthAndIncludesBothBoundaries() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let formatter = ISO8601DateFormatter()
        let end = try XCTUnwrap(formatter.date(from: "2026-03-31T09:30:00Z"))
        let start = try XCTUnwrap(formatter.date(from: "2026-02-28T09:30:00Z"))
        let window = SessionScanWindow(endingAt: end, calendar: calendar)
        XCTAssertEqual(window.start, start)
        XCTAssertTrue(window.contains(start))
        XCTAssertTrue(window.contains(end))
        XCTAssertFalse(window.contains(start.addingTimeInterval(-1)))
        XCTAssertFalse(window.contains(end.addingTimeInterval(1)))
    }

    func testFreshInstallWaitsForButtonAndCompletionSurvivesRestart() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "startup-\(UUID())")
        defer { try? FileManager.default.removeItem(at: home) }
        let state = home.appending(path: "app/state.json")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let store = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil)
        XCTAssertEqual(store.startupStage, .welcome)
        XCTAssertFalse(store.isDiscovering)
        XCTAssertNil(store.lastDiscoveredAt)
        XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
        await store.startInitialScan()
        XCTAssertEqual(store.startupStage, .ready)
        XCTAssertEqual(store.startupProgress.fraction, 1)
        XCTAssertNotNil(store.lastDiscoveredAt)
        XCTAssertTrue(store.sessions.isEmpty)
        let completed = store.lastDiscoveredAt
        await store.startInitialScan()
        XCTAssertEqual(store.lastDiscoveredAt, completed)
        let next = AppStore(stateURL: state, live: true, discoveryHome: home, discoveryEnvironment: [:], metadataReader: nil)
        XCTAssertEqual(next.startupStage, .ready)
    }

    func testDemoStartupCanBePreviewedWithoutTouchingUserSources() async {
        let store = AppStore()
        XCTAssertEqual(store.startupStage, .ready)
        store.previewStartup()
        XCTAssertEqual(store.startupStage, .welcome)
        await store.startInitialScan()
        XCTAssertEqual(store.startupStage, .ready)
        XCTAssertEqual(store.page, .approvals)
        XCTAssertEqual(store.pendingProjects.map(\.id), ["mobile"])
        XCTAssertNil(store.lastDiscoveredAt)
    }

    func testProgressIsClampedAndPreviewCannotBypassRealStartup() {
        XCTAssertEqual(DiscoveryProgress(completedSteps: -1).fraction, 0)
        XCTAssertEqual(DiscoveryProgress(completedSteps: 20).fraction, 1)
        let store = AppStore(live: true)
        store.previewStartup(DiscoveryProgress(completedSteps: 3))
        XCTAssertEqual(store.startupStage, .welcome)
    }
}
