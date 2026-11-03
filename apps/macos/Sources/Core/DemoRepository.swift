import Foundation

public struct DemoRepository: SessionRepository {
    public init() {}
    public static var notification: AppMessage {
        AppMessage(id: "demo-notification", kind: "project_scope.candidates.changed", title: "项目待审批", body: "3 个项目等待你确认采集权限。", targetType: "projects", targetId: nil, createdAt: .now)
    }
    public static var reviewBatches: [ReviewBatch] {
        [ReviewBatch(review: .init(id: "demo-review", state: "IN_PROGRESS", version: 1, period_key: "2026-W44"), items: [
            ReviewCard(id: "demo-card-website", title: "官网重构", project_name: "官网重构", status: "in_progress", review_status: "pending", payload: .init(overview: "完成项目筛选与登录异常提示，调整移动端导航。", dailyProgress: [
                .init(date: "2026-10-29", summary: "调整移动端导航，补齐小屏菜单的展开状态。"),
                .init(date: "2026-10-30", summary: "新增项目状态筛选，保留上次选择；细分登录失败提示。")
            ], projectStatus: .development)),
            ReviewCard(id: "demo-card-platform", title: "内部平台", project_name: "内部平台", status: "awaiting_validation", review_status: "pending", payload: .init(overview: "补充项目详情的成员权限校验，核对报表字段与统计口径。", dailyProgress: [
                .init(date: "2026-10-30", summary: "完成团队范围校验；整理报表字段中需要业务确认的口径。")
            ], projectStatus: .delivery))
        ], regenerationJobs: [])]
    }
    public func projects() -> [Project] {
        [
            Project(id: "website", name: "官网重构", folder: "~/Work/website", permission: .allowed),
            Project(id: "content", name: "内容运营", folder: "~/Work/content", permission: .allowed),
            Project(id: "platform", name: "内部平台", folder: "~/Work/platform", permission: .allowed),
            Project(id: "mobile", name: "移动端规划", folder: "~/Work/mobile", permission: .pending),
        ]
    }
    public func sessions() -> [AgentSession] {
        [
            AgentSession(id: "s1", projectID: "website", agent: .codex, title: "优化项目列表的筛选体验", updatedLabel: "今天 15:42", uploaded: false, turns: [
                ChatTurn(id: "t1", prompt: "在项目列表中增加状态筛选，并保留用户上次的选择。", answer: "已完成状态筛选，并保留上次选择。\n\n- **筛选范围**：全部、进行中、已暂停、已完成。\n- **选择恢复**：重新打开页面时恢复上次状态。\n- **验证结果**：筛选切换、空列表及刷新恢复均已验证。", questionTime: "今天 15:38", answerTime: "15:40", model: "gpt-6-astra"),
                ChatTurn(id: "t2", prompt: "如果保存的状态已经不存在，就回到“全部”。", answer: "已增加**无效状态回退**。历史保存值无法识别时，默认显示“全部”。\n\n筛选值先经过 `isValidStatus()` 校验，旧版本保存的值也能正常回退。", questionTime: "15:41", answerTime: "15:42", model: "gpt-6-astra"),
            ]),
            AgentSession(id: "s2", projectID: "website", agent: .claude, title: "梳理登录流程和异常提示", updatedLabel: "今天 15:18", uploaded: true, turns: [
                ChatTurn(id: "t3", prompt: "帮我梳理登录失败时的几种提示，避免所有错误都显示密码错误。", answer: "已调整登录失败提示：\n\n- **账号或密码错误**：提示核对登录信息。\n- **网络连接失败**：保留填写内容，允许重试。\n- **服务暂不可用**：提示稍后重试。\n- **账号被停用**：提示联系管理员。\n\n原有登录流程保持可用。", questionTime: "今天 15:16", answerTime: "15:18", model: "claude-sonnet"),
            ]),
            AgentSession(id: "s3", projectID: "website", agent: .grokbuild, title: "调整移动端导航", updatedLabel: "昨天 17:10", uploaded: true, turns: [
                ChatTurn(id: "t4", prompt: "让移动端的导航菜单在小屏上也能正常展开。", answer: "已调整小屏导航的布局与展开状态。长标题会自动换行，菜单操作区域保持可用。", questionTime: "昨天 17:08", answerTime: "17:10"),
            ]),
            AgentSession(id: "s4", projectID: "content", agent: .omp, title: "分析内容导入失败的原因", updatedLabel: "今天 14:56", uploaded: true, turns: [
                ChatTurn(id: "t5", prompt: "分析一下这批内容导入失败的原因。", answer: nil, questionTime: "今天 14:56"),
            ]),
            AgentSession(id: "s5", projectID: "content", agent: .pi, title: "整理内容发布检查项", updatedLabel: "今天 13:45", uploaded: true, turns: [
                ChatTurn(id: "t6", prompt: "根据项目现有文档整理一份发布前检查项。", answer: "### 发布前检查\n\n- 内容标题、摘要和正文完整。\n- 图片与链接可以正常打开。\n- 可见范围和发布时间正确。\n- 预览页面在手机和桌面均可阅读。", questionTime: "今天 13:40", answerTime: "13:45"),
            ]),
            AgentSession(id: "s6", projectID: "content", agent: .codex, title: "清理失效的图片引用", updatedLabel: "昨天 16:05", uploaded: true, turns: [
                ChatTurn(id: "t7", prompt: "找出内容页面中已经不存在的图片引用。", answer: "已整理失效图片引用及对应页面，生成待处理清单。需要补充替换素材的位置均已标记。", questionTime: "昨天 16:02", answerTime: "16:05"),
            ]),
            AgentSession(id: "s7", projectID: "platform", agent: .opencode, title: "补充成员权限校验", updatedLabel: "今天 14:30", uploaded: true, turns: [
                ChatTurn(id: "t8", prompt: "检查项目详情接口是否验证了成员所属团队。", answer: "已补充团队与成员范围校验。\n\n```text\n校验登录成员 → 匹配团队 → 检查项目权限\n```\n\n无权限的项目详情请求返回访问受限，正常成员访问保持可用。", questionTime: "今天 14:25", answerTime: "14:30"),
            ]),
            AgentSession(id: "s8", projectID: "platform", agent: .hermes, title: "核对报表字段含义", updatedLabel: "今天 11:20", uploaded: true, turns: [
                ChatTurn(id: "t9", prompt: "梳理这几个报表字段分别代表什么。", answer: "已对照项目字段定义补充说明，并标记需要业务确认的统计口径。", questionTime: "今天 11:16", answerTime: "11:20"),
            ]),
        ]
    }
    public static var uploadRecords: [UploadRecord] {
        [
            UploadRecord(id: "u1", time: "今天 15:30", kind: "手动上传", projectsAndAgents: "3 个项目", content: "32 条新增对话", status: .complete, details: [], createdAt: .now.addingTimeInterval(-1800), projects: [
                .init(id: "website", name: "官网重构", sessionCount: 4, messageCount: 18),
                .init(id: "platform", name: "内部平台", sessionCount: 2, messageCount: 7),
                .init(id: "content", name: "内容运营", sessionCount: 2, messageCount: 7)
            ], isSample: true),
            UploadRecord(id: "u2", time: "今天 14:00", kind: "自动补传", projectsAndAgents: "2 个项目", content: "12 条新增对话", status: .complete, details: [], createdAt: .now.addingTimeInterval(-7200), projects: [
                .init(id: "website", name: "官网重构", sessionCount: 2, messageCount: 8),
                .init(id: "platform", name: "内部平台", sessionCount: 1, messageCount: 4)
            ], isSample: true),
            UploadRecord(id: "u3", time: "昨天 16:02", kind: "自动上传", projectsAndAgents: "2 个项目", content: "12 条新增对话", status: .failed, details: [], createdAt: .now.addingTimeInterval(-86400), projects: [
                .init(id: "website", name: "官网重构", sessionCount: 2, messageCount: 8),
                .init(id: "platform", name: "内部平台", sessionCount: 1, messageCount: 4)
            ], errorMessage: "连接超时，新增内容已保留；恢复连接后自动重试。", isSample: true),
            UploadRecord(id: "u4", time: "昨天 16:00", kind: "自动上传", projectsAndAgents: "2 个项目", content: "24 条新增对话", status: .complete, details: [], createdAt: .now.addingTimeInterval(-86520), projects: [
                .init(id: "content", name: "内容运营", sessionCount: 3, messageCount: 16),
                .init(id: "platform", name: "内部平台", sessionCount: 2, messageCount: 8)
            ], isSample: true),
        ]
    }
}
