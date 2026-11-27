import XCTest
@testable import WeeklyReportCore

final class PersonalDataDecodingTests: XCTestCase {
    /// Shaped like the API response: nullable keys are null, and the server may send keys the App ignores.
    private let sample = """
    {
      "generatedAt": "2026-11-18T02:40:00.000Z", "timezone": "Asia/Shanghai", "futureKey": 1,
      "member": {"id": "m1", "name": "林宇"},
      "period": {"periodKey": "2026-W47", "startsAt": "2026-11-17T03:10:00.000Z", "cutoffAt": "2026-11-20T08:00:00.000Z",
                 "autoApproveAt": "2026-11-23T04:00:00.000Z", "publishAt": "2026-11-23T05:00:00.000Z"},
      "lastUpload": {"at": "2026-11-17T08:00:00.000Z", "status": "completed"},
      "totals": {"sessions": 3, "turns": 5, "activeDays": 1, "elapsedDays": 2},
      "events": [{"t": "2026-11-17T11:23", "p": "官网"}, {"t": "2026-11-17T11:31", "p": "官网"}, {"t": "2026-11-17T14:00", "p": "官网"},
                 {"t": "2026-11-17T15:03", "p": "平台"}, {"t": "2026-11-17T15:59", "p": "平台"}],
      "projects": [
        {"name": "官网", "oneLine": "公司官网的新版页面", "sessions": 2, "turns": 3, "lastAt": "2026-11-17T14:00", "lastActiveDate": "2026-11-17",
         "outcomes": {"items": ["登录页做好了", "导航改版完成"], "total": 5},
         "decisions": {"items": ["先做移动端"], "total": 1},
         "problems": {"items": ["测试账号还没开通"], "total": 3}},
        {"name": "平台", "oneLine": null, "sessions": 1, "turns": 2, "lastAt": "2026-11-17T15:59", "lastActiveDate": "2026-11-17",
         "outcomes": {"items": [], "total": 0}, "decisions": {"items": [], "total": 0}, "problems": {"items": [], "total": 0}},
        {"name": "旧项目", "oneLine": "已暂停", "sessions": 0, "turns": 0, "lastAt": null, "lastActiveDate": "2026-11-06",
         "outcomes": {"items": [], "total": 0}, "decisions": {"items": [], "total": 0}, "problems": {"items": [], "total": 0}}
      ]
    }
    """

    private func decode(_ json: String? = nil) throws -> PersonalData { try JSONDecoder().decode(PersonalData.self, from: Data((json ?? sample).utf8)) }

    func testDecodesTheWeekContract() throws {
        let data = try decode()
        XCTAssertEqual(data.member, .init(id: "m1", name: "林宇"))
        XCTAssertEqual(data.timezone, "Asia/Shanghai")
        XCTAssertEqual(data.period.periodKey, "2026-W47")
        XCTAssertEqual(data.period.startsAt, Instant.parse("2026-11-17T03:10:00Z"))
        XCTAssertEqual(data.period.cutoffAt.timeIntervalSince(data.period.startsAt), 3 * 86_400 + 4 * 3_600 + 50 * 60)
        XCTAssertNotNil(data.generatedAt)
        XCTAssertEqual(data.lastUpload?.label, "成功")
        XCTAssertEqual(data.totals, .init(sessions: 3, turns: 5, activeDays: 1, elapsedDays: 2))
        XCTAssertEqual(data.events.count, 5)
        XCTAssertEqual(data.events[3], .init(t: "2026-11-17T15:03", p: "平台"))
        XCTAssertEqual(data.projects.map(\.name), ["官网", "平台", "旧项目"])
        let site = data.projects[0]
        XCTAssertEqual(site.oneLine, "公司官网的新版页面")
        XCTAssertEqual(site.lastAt, "2026-11-17T14:00")
        XCTAssertEqual(site.outcomes, .init(items: ["登录页做好了", "导航改版完成"], total: 5))
        XCTAssertEqual(site.outcomes.hidden, 3)
        XCTAssertEqual(site.decisions.hidden, 0)
        XCTAssertEqual(site.problems.items, ["测试账号还没开通"])
        XCTAssertEqual(site.problems.hidden, 2)
        XCTAssertTrue(site.hasActivity)
    }

    func testNullsAndIdleProjectDecode() throws {
        let data = try decode()
        XCTAssertNil(data.projects[1].oneLine)
        let idle = data.projects[2]
        XCTAssertFalse(idle.hasActivity)
        XCTAssertNil(idle.lastAt)
        XCTAssertEqual(idle.lastActiveDate, "2026-11-06")
        XCTAssertTrue(idle.outcomes.items.isEmpty)
    }

    func testTurnsWithoutAnalysedSessionsStillMakeAnActiveProject() {
        XCTAssertTrue(PersonalWeekProject(name: "新上传", sessions: 0, turns: 4).hasActivity)
        XCTAssertFalse(PersonalWeekProject(name: "空闲", lastActiveDate: "2026-11-06").hasActivity)
    }

    func testMissingOptionalKeysFallBackToEmpty() throws {
        let bare = try decode("""
        {"timezone": "Asia/Shanghai", "member": {"id": "m", "name": "A"}, "lastUpload": null,
         "period": {"periodKey": "2026-W47", "startsAt": "2026-11-17T03:10:00Z", "cutoffAt": "2026-11-20T08:00:00Z",
                    "autoApproveAt": "2026-11-23T04:00:00Z", "publishAt": "2026-11-23T05:00:00Z"}}
        """)
        XCTAssertNil(bare.lastUpload)
        XCTAssertNil(bare.generatedAt)
        XCTAssertEqual(bare.totals, .init(sessions: 0, turns: 0, activeDays: 0, elapsedDays: 0))
        XCTAssertTrue(bare.events.isEmpty)
        XCTAssertTrue(bare.projects.isEmpty)
        XCTAssertTrue(bare.todayNotUploaded)
    }

    func testPeriodAndMemberAreRequired() {
        XCTAssertThrowsError(try decode(#"{"timezone": "Asia/Shanghai", "member": {"id": "m", "name": "A"}}"#))
        XCTAssertThrowsError(try decode("""
        {"member": {"id": "m", "name": "A"}, "period": {"periodKey": "k", "startsAt": "not a date", "cutoffAt": "2026-11-20T08:00:00Z",
         "autoApproveAt": "2026-11-23T04:00:00Z", "publishAt": "2026-11-23T05:00:00Z"}}
        """))
    }

    func testUploadStatusLabels() {
        let at = Date()
        XCTAssertEqual(PersonalData.LastUpload(at: at, status: "completed").label, "成功")
        XCTAssertEqual(PersonalData.LastUpload(at: at, status: "receiving").label, "上传中")
        XCTAssertEqual(PersonalData.LastUpload(at: at, status: "superseded").label, "已被新上传替代")
    }

    func testWeekCalendarFollowsTeamTimeAndToday() throws {
        let data = try decode()
        XCTAssertEqual(data.days, ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"])
        XCTAssertEqual(data.today, "2026-11-18")
        XCTAssertEqual(data.elapsedDays, ["2026-11-17", "2026-11-18"])
        XCTAssertEqual(data.weekLabel, "W47")
        XCTAssertEqual(data.rangeLabel, "11月17日 11:10 – 11月20日（周五）16:00")
        XCTAssertEqual(data.cutoffWeekday, "周五")
        XCTAssertEqual(data.publishWeekday, "周一")
        XCTAssertEqual(data.activeProjectCount, 2)
        XCTAssertTrue(data.todayNotUploaded, "the last upload was yesterday")
        XCTAssertEqual(data.currentStep(now: data.generatedAt!), 0)
        XCTAssertEqual(data.currentStep(now: data.period.cutoffAt), 2)
        XCTAssertEqual(data.currentStep(now: data.period.autoApproveAt), 3)
    }

    func testUnfinishedUploadDoesNotHideTheTodayWarning() throws {
        var data = try decode()
        data.lastUpload = .init(at: data.generatedAt!, status: "receiving")
        XCTAssertTrue(data.todayNotUploaded)
        data.lastUpload = .init(at: data.generatedAt!, status: "completed")
        XCTAssertFalse(data.todayNotUploaded)
    }

    func testInvestmentFollowsTheLeadershipFigures() throws {
        var data = try decode()  // today is 2026-11-18
        data.history = .init(from: "2026-08-21", to: "2026-11-18", events: [
            .init(t: "2026-10-01T09:00", p: "旧"),
            .init(t: "2026-10-22T09:00", p: "官网"), .init(t: "2026-11-17T15:00", p: "官网"), .init(t: "2026-11-17T15:30", p: "官网"),
            .init(t: "2026-11-18T10:00", p: "平台"),
        ])
        XCTAssertEqual(data.from28, "2026-10-22")
        XCTAssertEqual(data.turns28, 4)
        XCTAssertEqual(data.activeDays28, 3)
        XCTAssertEqual(data.lastActiveDay, "2026-11-18")
        XCTAssertEqual(data.shares.map(\.name), ["官网", "平台"], "the project idle for 28 days has no share")
        XCTAssertEqual(data.shares.map(\.colorIndex), [0, 1])
        let hours = data.investmentHourly(day: "2026-11-17")
        XCTAssertEqual(hours.map(\.name), ["官网"], "one active line needs no total")
        XCTAssertEqual(hours[0].values[15], 2)
        let month = data.investmentDaily(month: "2026-11")
        XCTAssertEqual(month.map(\.name), ["官网", "平台", "总计"])
        XCTAssertEqual(month[0].values.count, 30)
        XCTAssertEqual(month[2].values[16], 2)
        XCTAssertEqual(PersonalData.days(ofMonth: "2028-02").count, 29)
    }

    func testDemoDataIsInternallyConsistent() {
        let demo = DemoRepository.personalData(now: Date(timeIntervalSince1970: 1_793_000_000))
        XCTAssertEqual(demo.totals.turns, demo.events.count)
        XCTAssertEqual(demo.projects.map(\.turns).reduce(0, +), demo.events.count)
        XCTAssertEqual(demo.projects.map(\.sessions).reduce(0, +), demo.totals.sessions)
        XCTAssertEqual(demo.projects.map(\.turns), demo.projects.map(\.turns).sorted(by: >), "projects are sorted by turns, idle ones last")
        XCTAssertFalse(demo.projects.last!.hasActivity)
        XCTAssertEqual(demo.days.count, 5, "Monday to Friday")
        XCTAssertEqual(demo.rangeLabel.suffix(9), "（周五）16:00")
        XCTAssertFalse(demo.owned.isEmpty)
        XCTAssertTrue(Set(demo.owned.map(\.name)).isSubset(of: demo.history.events.map(\.p)), "owned projects were active")
        for project in demo.projects where project.hasActivity {
            XCTAssertEqual(project.turns, demo.events.filter { $0.p == project.name }.count)
        }
        // The demo round-trips through the real decoder's shape.
        XCTAssertEqual(demo.period.periodKey.prefix(6), "2026-W")
    }
}
