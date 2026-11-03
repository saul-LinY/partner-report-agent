import XCTest
import Security
@testable import WeeklyReportCore

final class BackgroundRuntimeTests: XCTestCase {
    private func fixture() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "weekly-background-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder
    }

    func testOnlyOneCollectorCanOwnTheStateAndLeaseCanBeReacquired() throws {
        let file = try fixture().appending(path: "collector.lock")
        var first = try ProcessLease.acquire(at: file)
        XCTAssertNotNil(first)
        XCTAssertNil(try ProcessLease.acquire(at: file))
        first = nil
        let next = try ProcessLease.acquire(at: file)
        XCTAssertNotNil(next)
        XCTAssertNil(try ProcessLease.acquire(at: file))
        withExtendedLifetime(next) {}
    }

    func testExplicitStopPersistsAndEnableClearsIt() throws {
        let folder = try fixture()
        XCTAssertTrue(BackgroundRuntime.shouldRestart(in: folder))
        try BackgroundRuntime.setDisabled(true, in: folder)
        XCTAssertFalse(BackgroundRuntime.shouldRestart(in: folder))
        try BackgroundRuntime.setDisabled(false, in: folder)
        XCTAssertTrue(BackgroundRuntime.shouldRestart(in: folder))
    }

    func testInstallerPauseExpiresWithoutUserIntervention() throws {
        let folder = try fixture(), now = Date.now
        try BackgroundRuntime.pauseForUpdate(until: now.addingTimeInterval(600), in: folder)
        XCTAssertFalse(BackgroundRuntime.shouldRestart(at: now, in: folder))
        XCTAssertTrue(BackgroundRuntime.shouldRestart(at: now.addingTimeInterval(601), in: folder))
        try BackgroundRuntime.setDisabled(true, in: folder)
        XCTAssertFalse(BackgroundRuntime.shouldRestart(at: now.addingTimeInterval(601), in: folder))
    }

    func testLockedKeychainDoesNotInvalidatePersistentBinding() {
        for status in [errSecInteractionNotAllowed, errSecNotAvailable, errSecAuthFailed] {
            XCTAssertEqual(HTTPCollectorService.credentialError(status).status, 503)
        }
        XCTAssertEqual(HTTPCollectorService.credentialError(errSecItemNotFound).status, 401)
    }
}
