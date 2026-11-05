import Foundation

/// A small, self-consistent sample of the personal-data response for demo and screenshot mode, so the page renders without a server.
extension DemoRepository {
    public static func personalData(month requested: String? = nil, now: Date = .now) -> PersonalData {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        func day(_ offset: Int) -> String {
            let date = calendar.date(byAdding: .day, value: -offset, to: now) ?? now
            return String(format: "%04d-%02d-%02d", calendar.component(.year, from: date), calendar.component(.month, from: date), calendar.component(.day, from: date))
        }
        let today = day(0)
        let month = requested ?? String(today.prefix(7))
        let names = ["官网重构", "内部平台"]
        let events: [PersonalData.ActivityEvent] = (0..<60).filter { $0 % 3 != 2 }.flatMap { offset in
            (0..<(3 + offset % 4)).map { turn in
                PersonalData.ActivityEvent(t: String(format: "%@T%02d:%02d", day(offset), 9 + (turn * 2 + offset) % 10, (turn * 17 + offset * 7) % 60), p: names[(turn + offset) % 2])
            }
        }
        let days28 = Set(events.map { String($0.t.prefix(10)) }).filter { $0 >= day(27) }
        func entries(_ project: Int, _ stride: Int) -> [ProgressDay] {
            PersonalActivity.dates(in: month).filter { $0 <= today && (Int($0.suffix(2)) ?? 0) % stride == project }.map {
                ProgressDay(date: $0, entries: [ProgressDayEntry(id: "\(names[project])-\($0)", summary: project == 0 ? "完成项目筛选与登录异常提示，调整移动端导航。" : "补充项目详情的成员权限校验，核对报表字段与统计口径。")])
            }
        }
        let blocker = ProjectKeyEvent(date: day(6), type: "blocker", title: "测试环境账号权限未开通", detail: "联调需要的测试账号尚未开通，等待运维处理。", step: "联调测试")
        let website = MemberProject(
            project: ProgressProject(partnerId: "demo-member", projectId: "demo-website", projectName: names[0],
                projectDescription: "公司官网的新版页面，包含产品介绍、案例展示和联系入口，同时改造移动端导航与登录体验。",
                events: [ProgressEvent(date: day(40), type: "start", reason: "立项")], days: entries(0, 3), contributionDays: 18,
                currentFocus: .init(text: "完成项目筛选与登录异常提示，准备移动端导航验收。"),
                outlook: ProjectOutlook(goal: "上线新版官网，移动端访问体验与桌面端一致。", roadmap: stages(done: 1, current: 1), position: "已完成需求梳理，目前在开发实现阶段，页面主体基本完成。"),
                keyEvents: [ProjectKeyEvent(date: day(20), type: "stage_change", title: "进入开发实现", detail: "需求确认完毕，开始页面开发。", step: "开发实现"),
                            ProjectKeyEvent(date: day(35), type: "goal_change", title: "增加移动端导航改造", detail: "目标从单纯换版扩展到移动端导航一并改造。")]),
            profile: ProjectProfile(note: ProjectProfileNote(oneLine: .init(text: "公司官网的新版页面与移动端改造"), intro: .init(text: "面向访客展示产品与案例，并提供联系入口。"),
                features: [.init(text: "产品与案例展示"), .init(text: "移动端导航")], openIssues: [.init(text: "登录异常提示文案待确认")])),
            steps: stages(done: 1, current: 1), done: 1, current: ProjectStep(name: "开发实现", state: .current), state: .ok, idle: 1, focus: "完成项目筛选与登录异常提示，准备移动端导航验收。")
        let platform = MemberProject(
            project: ProgressProject(partnerId: "demo-member", projectId: "demo-platform", projectName: names[1],
                events: [ProgressEvent(date: day(55), type: "start", reason: "立项"), ProgressEvent(date: day(12), type: "pause", reason: "等待测试环境")], days: entries(1, 4), contributionDays: 26,
                outlook: ProjectOutlook(goal: "内部报表与成员管理统一到一个平台。", roadmap: stages(done: 2, current: 1), position: "开发已完成，联调受测试账号权限影响。"),
                keyEvents: [blocker], latestProgress: .init(date: day(1), summary: "补充项目详情的成员权限校验，核对报表字段与统计口径。")),
            profile: nil, steps: stages(done: 2, current: 1), done: 2, current: ProjectStep(name: "联调测试", state: .current), blocker: blocker, state: .blocked, idle: 3,
            focus: "补充项目详情的成员权限校验，核对报表字段与统计口径。")
        return PersonalData(
            today: today, timezone: "Asia/Shanghai", member: .init(id: "demo-member", name: "预览用户"),
            headline: MemberHeadline(projectCount: 2, attention: 1, activeDays28: days28.count, lastActiveDate: events.map(\.t).max().map { String($0.prefix(10)) }),
            projects: [website, platform], calendar: .init(month: month, from: "\(month)-01", to: "\(month)-\(String(format: "%02d", PersonalActivity.daysInMonth(month)))"),
            activity: .init(timezone: "Asia/Shanghai", from: day(89), to: today, days: 90, events: events))
    }

    private static func stages(done: Int, current: Int) -> [ProjectStep] {
        ["需求梳理", "开发实现", "联调测试", "交付验收"].enumerated().map { index, name in
            ProjectStep(name: name, state: index < done ? .done : index < done + current ? .current : .todo)
        }
    }
}
