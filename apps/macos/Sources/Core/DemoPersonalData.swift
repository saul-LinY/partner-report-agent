import Foundation

/// A small, self-consistent sample of the personal-data response for demo and screenshot mode, so the page renders
/// without a server. It follows the approved 本周进展 preview: a week that started on Monday at 11:10 and is cut off on
/// Friday at 16:00 (Asia/Shanghai), with one day of recorded turns.
extension DemoRepository {
    public static func personalData(now: Date = .now) -> PersonalData {
        let timezone = "Asia/Shanghai"
        // ISO weeks start on Monday and number like the server's period keys.
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: timezone) ?? .current
        let monday = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? calendar.startOfDay(for: now)
        func at(day offset: Int, _ hour: Int, _ minute: Int) -> Date {
            let day = calendar.date(byAdding: .day, value: offset, to: monday) ?? monday
            return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
        }
        let eventDay = PersonalActivity.day(of: monday, timezone: timezone)
        let lastRecorded = PersonalActivity.day(of: calendar.date(byAdding: .day, value: -11, to: monday) ?? monday, timezone: timezone)

        let partner = "partner-report-agent", novel = "app_novel", headroom = "Headroom_MVP"
        let turnTimes: [(String, String)] = [
            ("11:23", headroom), ("11:31", novel), ("11:52", novel), ("11:53", novel), ("11:59", headroom), ("12:10", novel),
            ("14:00", novel), ("14:01", headroom), ("14:14", novel), ("14:29", novel), ("14:30", novel),
            ("15:03", partner), ("15:04", partner), ("15:06", partner), ("15:30", partner), ("15:36", partner),
            ("15:51", partner), ("15:55", partner), ("15:56", partner), ("15:59", partner),
        ]
        let events = turnTimes.map { PersonalData.ActivityEvent(t: "\(eventDay)T\($0.0)", p: $0.1) }

        let projects = [
            PersonalWeekProject(
                name: partner, oneLine: "团队AI会话采集与leader汇报系统", sessions: 2, turns: 9, lastAt: "\(eventDay)T15:59",
                outcomes: .init(items: [
                    "重启后出现 1 次模型请求超时，系统自动切换到下一个模型并成功；此前的 404 属于更换配置前的旧记录。",
                    "历史累计完成 166 个分析任务，33 个因来源被新数据替代而取消，失败为 0 个。",
                    "此前因模型输出超长而失败的任务被自动拆分为 2 段分析后完成，提取 4 条信息；结果表明超长自动拆分在真实数据上有效。",
                ], total: 14),
                decisions: .init(items: [
                    "图表配色刻意避开红、黄、绿，避免与页面中表示卡点、停滞、正常的状态色混淆。",
                    "为避免异步流程把改名误判为账号切换，姓名同步没有直接改写 App 本地绑定姓名，而是新增独立显示名并优先使用服务端姓名。",
                ], total: 2),
                problems: .init(items: [
                    "自动恢复机制本次未被触发，缺少新的模型故障任务需要重新排队的场景，因此其真实故障下的表现尚未验证。",
                    "完整预览的图表除 11 月 17 日外为规则生成的示意数据，卡点与“需要你/建议”内容也为示例，尚未接入真实数据。",
                ], total: 6)),
            PersonalWeekProject(
                name: novel, oneLine: "面向欧美读者的英文故事阅读与创作应用", sessions: 1, turns: 8, lastAt: "\(eventDay)T14:30",
                outcomes: .init(items: [
                    "新定价方案已完成实现并提交推送，服务器测试 619 项、App 测试 568 项全部通过；服务器和模拟器上的 App 已更新为新版本。",
                    "代码已推送至公司仓库，模拟器 App 已更新为新版本。",
                    "最新一轮服务端 615 项、App 567 项测试全部通过。",
                ], total: 16),
                decisions: .init(items: [
                    "为控制成本设置不显示的每月互动总额度：Basic 100 段、Plus 160 段、Pro 330 段，免费用户终身 120 段；额度用完后每段 2 金币。",
                    "故事达到 100% 后继续在结局后扩展，按每段 2 金币计费；发送按钮显示 2 coins，首次扣币前弹窗确认一次。",
                ], total: 11),
                problems: .init(items: [
                    "存在旧存档收费例外：改动前已读到结局的存档重开后暂不收取 2 金币，需再次到达结局后才开始收费；目前只影响本地测试数据。",
                    "Basic 重度阅读用户约玩到第 3 本结局时月度互动额度会用完，之后更频繁看到每段 2 金币的提示；若额度过紧，需要提高 Basic 价格或接受最坏情况下少量亏损。",
                ], total: 5)),
            PersonalWeekProject(
                name: headroom, oneLine: "个人月度预算规划与记账应用", sessions: 1, turns: 3, lastAt: "\(eventDay)T14:01",
                outcomes: .init(items: [
                    "App 已编译、安装并启动在 iPhone 17e 模拟器（iOS 27.0），模拟器窗口已打开。",
                    "修复撤销提示与系统保存通知联动导致提示刚出现即关闭的问题；改为清点自身发出的保存次数，相关 UI 测试已通过。",
                    "修复 AX-L 大字号问题：类别名不再在单词中间断开、类别详情徽章可换行、引导页底部固定区缩小为仅固定按钮。",
                ], total: 5),
                decisions: .init(items: [
                    "决定不照搬 stitch 技能中建立文件夹结构、加预览等清单项，因为该 App 已有完整结构。",
                    "更新命令未找到已安装技能，因此改用首次安装命令完成 iphone-ui 0.9.0 的全局安装。",
                ], total: 2),
                problems: .init(items: [
                    "本轮仅修改 App，HTML 原型未补充流体交互。",
                    "模拟器无法验证实际触觉、VoiceOver 实际朗读、系统手势及“降低透明度”后的弹窗效果，需要真机验证。",
                ], total: 3)),
            PersonalWeekProject(name: "AI_novel", oneLine: "短篇改编为分支互动小说", lastActiveDate: lastRecorded),
        ]

        // 工作投入: four weeks of earlier turns before this week's, deterministic so screenshots stay stable.
        let mix = [novel, novel, partner, novel, headroom, partner, novel]
        let earlier = (1...27).flatMap { back -> [PersonalData.ActivityEvent] in
            let day = PersonalActivity.shift(eventDay, by: -back)
            let count = back % 6 == 0 ? 0 : (back * 7) % 11 + 2
            return (0..<count).map { i in .init(t: "\(day)T\(String(format: "%02d", 9 + (i * 5 + back) % 9)):\(String(format: "%02d", (i * 13) % 60))", p: mix[(i + back) % mix.count]) }
        }
        let history = PersonalData.History(from: PersonalActivity.shift(eventDay, by: -89), to: PersonalActivity.day(of: now, timezone: timezone),
                                           events: (earlier + events).sorted { $0.t < $1.t })
        let owned = [
            PersonalOwnedProject(
                name: novel, oneLine: "面向欧美读者的英文故事阅读与创作应用", focus: "打通会员付费闭环，准备商店上架",
                intro: "一款面向欧美读者的英文故事应用：登录后可读管理员上架的完结故事，也能自己创作互动故事。用金币解锁更多内容，免费用户也能先读几本。",
                contributionDays: 6,
                features: ["订阅会员可与AI一起写完整故事", "把写好的故事变成能玩的互动故事", "在书架看到进度，接着读或玩，也可删除"],
                openIssues: ["年龄靠用户自己填，未满18岁的孩子可能填假年龄绕过限制。", "免费额度用完后如何引导订阅，还在摸索。"]),
            PersonalOwnedProject(
                name: partner, oneLine: "团队AI会话采集与领导汇报系统", focus: "让成员完成本周工作卡核对发布",
                intro: "面向团队的AI会话采集与领导汇报助手。成员授权后自动采集会话，滤除测试与闲聊，隐私内容标记并在上传前隐去。",
                contributionDays: 12, features: ["按项目授权采集会话", "周五生成工作卡并由本人审核"]),
            PersonalOwnedProject(
                name: headroom, oneLine: "个人月度预算规划与记账应用", focus: "打磨交互反馈，准备真机验证",
                intro: "面向欧美市场的本地预算应用：无需注册，首次填写收入和固定支出，之后按类别规划当月预算。",
                contributionDays: 33, features: ["查看本月及每日可自由支配金额与明细", "设定各类消费的每月预算并查看剩余"],
                openIssues: ["升级订阅入口目前只是空壳，需要确定上线购买流程还是先隐藏。"]),
        ]

        let elapsed = min(4, max(1, (calendar.dateComponents([.day], from: monday, to: calendar.startOfDay(for: now)).day ?? 0) + 1))
        return PersonalData(
            generatedAt: now, timezone: timezone, member: .init(id: "demo-member", name: "预览用户"),
            period: .init(periodKey: "\(calendar.component(.yearForWeekOfYear, from: monday))-W\(String(format: "%02d", calendar.component(.weekOfYear, from: monday)))",
                          startsAt: at(day: 0, 11, 10), cutoffAt: at(day: 4, 16, 0), autoApproveAt: at(day: 7, 12, 0), publishAt: at(day: 7, 13, 0)),
            lastUpload: .init(at: at(day: 0, 16, 0), status: "completed"),
            totals: .init(sessions: 4, turns: events.count, activeDays: 1, elapsedDays: elapsed),
            events: events, projects: projects, history: history, owned: owned)
    }
}
