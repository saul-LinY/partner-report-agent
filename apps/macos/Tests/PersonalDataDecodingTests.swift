import XCTest
@testable import WeeklyReportCore

final class PersonalDataDecodingTests: XCTestCase {
    /// Shaped like the API response: `undefined` keys are absent, nullable ones are null, and the server sends keys the App ignores.
    private let sample = """
    {
      "generatedAt": "2026-11-05T02:00:00.000Z", "today": "2026-11-05", "timezone": "Asia/Shanghai", "futureKey": 1,
      "member": {"id": "m1", "name": "林宇"},
      "headline": {"projectCount": 2, "attention": 1, "activeDays28": 9, "lastActiveDate": null},
      "calendar": {"month": "2026-11", "from": "2026-11-01", "to": "2026-11-05"},
      "activity": {"timezone": "Asia/Shanghai", "from": "2026-08-07", "to": "2026-11-05", "days": 90,
        "events": [{"t": "2026-11-04T10:15", "p": "官网"}, {"t": "2026-11-05T09:02", "p": "平台"}]},
      "projects": [
        {"project": {"partnerId": "m1", "projectId": "p1", "projectName": "官网", "projectDescription": null, "version": 3,
           "events": [{"date": "2026-10-01", "type": "start", "reason": "立项", "stage": "development"}],
           "metrics": {"elapsedDays": 30}, "days": [{"date": "2026-11-04", "entries": [{"id": "e1", "summary": "完成登录页", "source": "reviewed", "reviewId": null, "periodKey": null}]}],
           "contributionDays": 12, "undatedCount": 1, "currentFocus": null,
           "outlook": {"goal": "上线新官网", "roadmap": [{"name": "开发实现", "state": "current"}], "position": "开发中", "periodKey": null, "reviewId": null},
           "keyEvents": [{"date": "2026-10-20", "type": "blocker", "title": "缺少账号", "detail": "等待开通", "step": null, "periodKey": null, "reviewId": null}],
           "latestProgress": {"date": "2026-11-04", "summary": "完成登录页", "source": "reviewed"}},
         "profile": {"id": "pf1", "sessions": 4, "note": {"oneLine": {"text": "公司官网", "refs": []}, "intro": {"text": "简介", "refs": []},
           "features": [{"text": "展示", "refs": []}], "openIssues": [], "status": {"text": "进行中", "refs": []}}},
         "steps": [{"name": "需求梳理", "state": "done"}, {"name": "开发实现", "state": "current"}], "done": 1,
         "current": {"name": "开发实现", "state": "current"},
         "blocker": {"date": "2026-10-20", "type": "blocker", "title": "缺少账号", "detail": "等待开通", "step": "开发实现", "periodKey": null, "reviewId": null},
         "state": "blocked", "idle": 1, "focus": "完成登录页"},
        {"project": {"partnerId": "m1", "projectId": "p2", "projectName": "平台", "events": [], "days": [], "contributionDays": 0,
           "undatedCount": 0, "currentFocus": null, "outlook": null, "keyEvents": []},
         "steps": [], "done": 0, "state": "someFutureState", "idle": null, "focus": "暂无已审核的工作进展。"}
      ]
    }
    """

    private func decode() throws -> PersonalData { try JSONDecoder().decode(PersonalData.self, from: Data(sample.utf8)) }

    func testDecodesFullProjectCard() throws {
        let data = try decode()
        XCTAssertEqual(data.member.name, "林宇")
        let card = data.projects[0]
        XCTAssertEqual(card.state, .blocked)
        XCTAssertEqual(card.profile?.note.oneLine?.text, "公司官网")
        XCTAssertEqual(card.profile?.note.features.map(\.text), ["展示"])
        XCTAssertEqual(card.current?.name, "开发实现")
        XCTAssertEqual(card.blocker?.step, "开发实现")
        XCTAssertEqual(card.project.outlook?.roadmap.first?.state.label, "进行中")
        XCTAssertEqual(card.project.activity(on: "2026-11-04").entries.map(\.summary), ["完成登录页"])
        XCTAssertEqual(card.project.events.first?.label, "开始")
        XCTAssertEqual(card.project.keyEvents.first?.typeLabel, "问题阻塞")
    }

    func testMissingOptionalKeysAndNullsDecode() throws {
        let data = try decode()
        XCTAssertNil(data.headline.lastActiveDate)
        let bare = data.projects[1]
        XCTAssertNil(bare.profile)
        XCTAssertNil(bare.current)
        XCTAssertNil(bare.blocker)
        XCTAssertNil(bare.idle)
        XCTAssertNil(bare.project.outlook)
        XCTAssertNil(bare.project.projectDescription)
        // An unknown state from a newer server must not blank the whole page.
        XCTAssertEqual(bare.state, .ok)
    }

    func testFocusFallsBackFromReviewedFocusToLatestProgressToSentence() throws {
        let data = try decode()
        XCTAssertEqual(data.projects[0].project.focusText, "完成登录页")
        XCTAssertEqual(data.projects[1].project.focusText, "暂无已审核的工作进展。")
        var focused = data.projects[0].project
        focused.currentFocus = .init(text: "联调")
        XCTAssertEqual(focused.focusText, "联调")
    }

    func testPickerOrdersByMostRecentProgress() throws {
        let data = try decode()
        XCTAssertEqual(data.projectsByRecency.map(\.id), ["p1", "p2"])
        var reversed = data
        reversed.projects[1].project.latestProgress = .init(date: "2026-11-05", summary: "x")
        XCTAssertEqual(reversed.projectsByRecency.map(\.id), ["p2", "p1"])
    }

    func testDemoDataIsInternallyConsistent() {
        let demo = DemoRepository.personalData()
        XCTAssertEqual(demo.headline.projectCount, demo.projects.count)
        XCTAssertEqual(demo.headline.lastActiveDate, PersonalActivity.lastEventDay(demo.activity.events))
        XCTAssertEqual(DemoRepository.personalData(month: "2026-02").calendar.to, "2026-02-28")
    }
}
