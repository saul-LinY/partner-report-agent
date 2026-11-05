import XCTest
@testable import WeeklyReportCore

final class PersonalActivityTests: XCTestCase {
    private typealias Event = PersonalData.ActivityEvent
    private let events = [
        Event(t: "2026-11-04T10:15", p: "官网"), Event(t: "2026-11-04T10:59", p: "平台"), Event(t: "2026-11-04T23:00", p: "官网"),
        Event(t: "2026-11-05T00:00", p: "官网"), Event(t: "2026-10-31T09:00", p: "平台"), Event(t: "2026-11-05T09:30", p: "已删除的项目"),
    ]

    func testHourlyBucketsPerProjectWithTotalLine() {
        let lines = PersonalActivity.hourly(events: events, day: "2026-11-04", projects: ["官网", "平台"])
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
        let lines = PersonalActivity.hourly(events: events, day: "2026-11-05", projects: ["官网"])
        XCTAssertEqual(lines.map(\.name), ["交互轮数"])
        XCTAssertEqual(lines[0].values[0], 1)
        XCTAssertEqual(lines[0].values[9], 1, "a turn of a project the card list lacks still counts in the single-line view")
    }

    func testMonthlyBucketsByDayOfMonth() {
        let november = PersonalActivity.monthly(events: events, month: "2026-11", projects: ["官网", "平台"])
        XCTAssertEqual(november[0].values.count, 30)
        XCTAssertEqual(november[0].values[3], 2)
        XCTAssertEqual(november[0].values[4], 1)
        XCTAssertEqual(november[2].values[3], 3)
        XCTAssertEqual(november[2].values[0], 0)
        let october = PersonalActivity.monthly(events: events, month: "2026-10", projects: ["官网", "平台"])
        XCTAssertEqual(october[0].values.count, 31)
        XCTAssertEqual(october[1].values[30], 1)
        XCTAssertEqual(PersonalActivity.monthly(events: events, month: "2026-09", projects: ["官网", "平台"])[2].sum, 0)
    }

    func testLastEventDayAndMonthMath() {
        XCTAssertEqual(PersonalActivity.lastEventDay(events), "2026-11-05")
        XCTAssertNil(PersonalActivity.lastEventDay([]))
        XCTAssertEqual(PersonalActivity.shiftMonth("2026-01", by: -1), "2025-12")
        XCTAssertEqual(PersonalActivity.shiftMonth("2026-11", by: 2), "2027-01")
        XCTAssertEqual(PersonalActivity.daysInMonth("2028-02"), 29)
        XCTAssertEqual(PersonalActivity.daysInMonth("2100-02"), 28)
    }

    func testCalendarGridIsMondayFirstForAMonthStartingOnSunday() {
        // 2026-02-01 is a Sunday: six leading days from January, and 28 days make exactly five weeks.
        let february = PersonalActivity.calendarGrid(month: "2026-02")
        XCTAssertEqual(february.count, 35)
        XCTAssertEqual(february.first, "2026-01-26")
        XCTAssertEqual(february[6], "2026-02-01")
        XCTAssertEqual(february.last, "2026-03-01")
        // 2026-06-01 is a Monday: no leading days.
        XCTAssertEqual(PersonalActivity.calendarGrid(month: "2026-06").first, "2026-06-01")
        XCTAssertEqual(PersonalActivity.calendarGrid(month: "2026-11").count % 7, 0)
        XCTAssertEqual(PersonalActivity.dates(in: "2026-11").count, 30)
    }
}
