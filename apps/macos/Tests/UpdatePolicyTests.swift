import XCTest
@testable import WeeklyReportCore

@MainActor
final class UpdatePolicyTests: XCTestCase {
    private let detected = Date(timeIntervalSince1970: 1_793_332_800)

    func testNoBadgeUntilUpdateIsDetectedAndClickStartsOnlyOnce() {
        let policy = UpdatePolicy(installedVersion: "1")
        XCTAssertNil(policy.available)
        var installs = 0
        policy.offer(version: "2", now: detected) { installs += 1 }
        XCTAssertNotNil(policy.available)
        XCTAssertEqual(installs, 0)
        XCTAssertTrue(policy.requestInstall())
        XCTAssertFalse(policy.requestInstall())
        XCTAssertEqual(installs, 1)
    }

    func testAutomaticInstallAtExactly24Hours() {
        let policy = UpdatePolicy(installedVersion: "1")
        var installs = 0
        policy.offer(version: "2", now: detected) { installs += 1 }
        policy.installIfDue(now: detected.addingTimeInterval(86_399))
        XCTAssertEqual(installs, 0)
        policy.installIfDue(now: detected.addingTimeInterval(86_400))
        policy.installIfDue(now: detected.addingTimeInterval(90_000))
        XCTAssertEqual(installs, 1)
    }

    func testNewerReleaseDoesNotExtendVisibleBadgesDeadline() {
        let policy = UpdatePolicy(installedVersion: "1")
        policy.offer(version: "2", now: detected) {}
        policy.offer(version: "3", now: detected.addingTimeInterval(80_000)) {}
        XCTAssertEqual(policy.available?.version, "3")
        XCTAssertEqual(policy.available?.automaticInstallAt, detected.addingTimeInterval(86_400))
    }

    func testRestartRevalidatesAvailabilityAndRetainsDeadline() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "update-policy-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "update.json")
        let first = UpdatePolicy(stateURL: url, installedVersion: "1")
        first.offer(version: "2", now: detected) {}
        XCTAssertNil(first.persistenceError)
        let next = UpdatePolicy(stateURL: url, installedVersion: "1")
        XCTAssertNil(next.available)
        var installs = 0
        next.offer(version: "2", now: detected.addingTimeInterval(90_000)) { installs += 1 }
        XCTAssertEqual(next.available?.detectedAt, detected)
        XCTAssertEqual(installs, 1)
        let upgraded = UpdatePolicy(stateURL: url, installedVersion: "2")
        upgraded.offer(version: "3", now: detected.addingTimeInterval(100_000)) {}
        XCTAssertEqual(upgraded.available?.detectedAt, detected.addingTimeInterval(100_000))
    }

    func testFailureCanRetryWithoutResettingDeadline() {
        let policy = UpdatePolicy(installedVersion: "1")
        var installs = 0
        policy.offer(version: "2", now: detected) { installs += 1 }
        policy.requestInstall()
        policy.finishAttempt()
        XCTAssertFalse(policy.isInstalling)
        XCTAssertFalse(policy.requestInstall())
        policy.offer(version: "2", now: detected.addingTimeInterval(86_400)) { installs += 1 }
        XCTAssertEqual(installs, 2)
        XCTAssertEqual(policy.available?.detectedAt, detected)
        policy.clear()
        XCTAssertNil(policy.available)
    }
}
