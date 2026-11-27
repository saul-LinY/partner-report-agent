import XCTest
@testable import WeeklyReportCore

final class PersonalActivityTests: XCTestCase {
    private typealias Event = PersonalData.ActivityEvent
    private let events = [
        Event(t: "2026-11-17T10:15", p: "官网"), Event(t: "2026-11-17T10:59", p: "平台"), Event(t: "2026-11-17T23:00", p: "官网"),
        Event(t: "2026-11-18T00:00", p: "官网"), Event(t: "2026-11-16T09:00", p: "平台"), Event(t: "2026-11-18T09:30", p: "已删除的项目"),
    ]
    private let week = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]

    func testHourlyBucketsPerProjectWithTotalLine() {
        let lines = PersonalActivity.hourly(events: events, day: "2026-11-17", projects: ["官网", "平台"])
        XCTAssertEqual(lines.map(\.name), ["官网", "平台", "总计"])
        XCTAssertEqual(lines[0].values.count, 24)
        XCTAssertEqual(lines[0].values[10], 1)
        XCTAssertEqual(lines[0].values[23], 1)
        XCTAssertEqual(lines[1].values[10], 1)
        XCTAssertEqual(lines[2].values[10], 2)
        XCTAssertTrue(lines[2].isTotal)
        XCTAssertEqual(lines[2].sum, lines[0].sum + lines[1].sum)
        XCTAssertEqual(lines[2].sum, 3, "other days must not leak into the picked day")
    }

    func testSingleProjectIsOneLineCountingEveryTurnAndNoTotal() {
        let lines = PersonalActivity.hourly(events: events, day: "2026-11-18", projects: ["官网"])
        XCTAssertEqual(lines.map(\.name), ["交互轮数"])
        XCTAssertEqual(lines[0].values[0], 1)
        XCTAssertEqual(lines[0].values[9], 1, "a turn of a project the card list lacks still counts in the single-line view")
    }

    func testDailyBucketsFollowThePeriodsDaysAndIgnoreOtherDays() {
        let lines = PersonalActivity.daily(events: events, days: week, projects: ["官网", "平台"])
        XCTAssertEqual(lines.map(\.name), ["官网", "平台", "总计"])
        XCTAssertEqual(lines[0].values, [2, 1, 0, 0])
        XCTAssertEqual(lines[1].values, [1, 0, 0, 0])
        XCTAssertEqual(lines[2].values, [3, 1, 0, 0], "turns before the period and of unknown projects are not counted")
        XCTAssertEqual(lines.map(\.colorIndex).prefix(2), [0, 1])
    }

    func testLastEventDayStaysWithinTheGivenDays() {
        XCTAssertEqual(PersonalActivity.lastEventDay(events, within: week), "2026-11-18")
        XCTAssertEqual(PersonalActivity.lastEventDay(events, within: ["2026-11-17"]), "2026-11-17")
        XCTAssertNil(PersonalActivity.lastEventDay([], within: week))
        XCTAssertNil(PersonalActivity.lastEventDay(events, within: ["2026-11-19"]))
    }

    func testTeamTimeFormatting() {
        // 2026-11-17 03:10 UTC is 11:10 in Shanghai, but still the 16th in Los Angeles.
        let instant = Instant.parse("2026-11-17T03:10:00.000Z")!
        XCTAssertEqual(PersonalActivity.stamp(instant, timezone: "Asia/Shanghai"), "11月17日 11:10")
        XCTAssertEqual(PersonalActivity.stamp(instant, timezone: "America/Los_Angeles"), "11月16日 19:10")
        XCTAssertEqual(PersonalActivity.day(of: instant, timezone: "Asia/Shanghai"), "2026-11-17")
        XCTAssertEqual(PersonalActivity.stamp("2026-11-17T15:59"), "11月17日 15:59")
        XCTAssertEqual(PersonalActivity.monthDay("2026-11-06"), "11月6日")
        XCTAssertEqual(PersonalActivity.weekday("2026-11-20"), "周五")
        XCTAssertEqual(PersonalActivity.weekday("2026-11-22"), "周日")
    }

    func testCountdown() {
        let cutoff = Instant.parse("2026-11-20T08:00:00.000Z")!
        func left(_ seconds: TimeInterval) -> String { PersonalActivity.countdown(to: cutoff, now: cutoff.addingTimeInterval(-seconds)) }
        XCTAssertEqual(left(2 * 86_400 + 5 * 3_600 + 20 * 60), "2 天 5 小时")
        XCTAssertEqual(left(5 * 3_600 + 12 * 60), "5 小时 12 分钟")
        XCTAssertEqual(left(12 * 60 + 30), "12 分钟")
        XCTAssertEqual(left(0), "已截止")
        XCTAssertEqual(left(-3_600), "已截止")
    }
}
