import Foundation

/// What `GET /v1/collector/personal-data` returns: the member's own version of the leadership member page.
/// Mirrors `PersonalData` in packages/contracts/src/member-overview.ts. Decoding is tolerant by design: keys the
/// server omits (`undefined` is dropped from JSON) become nil or empty, unknown keys are ignored, and unknown
/// enum values fall back to a neutral case so a newer server never blanks the page.
public struct PersonalData: Decodable, Equatable, Sendable {
    public struct Member: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
    }
    public struct CalendarRange: Decodable, Equatable, Sendable {
        /// "YYYY-MM": the month `projects[].project.days` covers.
        public var month: String
        public var from: String
        public var to: String
    }
    /// One conversation turn at its own minute: `t` is "YYYY-MM-DDTHH:mm" in team time.
    public struct ActivityEvent: Decodable, Equatable, Sendable {
        public var t: String
        public var p: String
        public init(t: String, p: String) { self.t = t; self.p = p }
    }
    public struct Activity: Decodable, Equatable, Sendable {
        public var timezone: String
        public var from: String
        public var to: String
        public var days: Int
        public var events: [ActivityEvent]
        public init(timezone: String, from: String, to: String, days: Int, events: [ActivityEvent]) {
            self.timezone = timezone; self.from = from; self.to = to; self.days = days; self.events = events
        }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            timezone = try c.decodeIfPresent(String.self, forKey: .timezone) ?? ""
            from = try c.decodeIfPresent(String.self, forKey: .from) ?? ""
            to = try c.decodeIfPresent(String.self, forKey: .to) ?? ""
            days = try c.decodeIfPresent(Int.self, forKey: .days) ?? 0
            events = try c.decodeIfPresent([ActivityEvent].self, forKey: .events) ?? []
        }
        private enum Keys: String, CodingKey { case timezone, from, to, days, events }
    }

    public var generatedAt: String?
    public var today: String
    public var timezone: String
    public var member: Member
    public var headline: MemberHeadline
    public var projects: [MemberProject]
    public var calendar: CalendarRange
    public var activity: Activity

    public init(generatedAt: String? = nil, today: String, timezone: String, member: Member, headline: MemberHeadline, projects: [MemberProject], calendar: CalendarRange, activity: Activity) {
        self.generatedAt = generatedAt; self.today = today; self.timezone = timezone; self.member = member
        self.headline = headline; self.projects = projects; self.calendar = calendar; self.activity = activity
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        generatedAt = try c.decodeIfPresent(String.self, forKey: .generatedAt)
        today = try c.decode(String.self, forKey: .today)
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone) ?? ""
        member = try c.decode(Member.self, forKey: .member)
        headline = try c.decode(MemberHeadline.self, forKey: .headline)
        projects = try c.decodeIfPresent([MemberProject].self, forKey: .projects) ?? []
        calendar = try c.decode(CalendarRange.self, forKey: .calendar)
        activity = try c.decodeIfPresent(Activity.self, forKey: .activity) ?? Activity(timezone: timezone, from: "", to: "", days: 0, events: [])
    }
    private enum Keys: String, CodingKey { case generatedAt, today, timezone, member, headline, projects, calendar, activity }

    /// The order of the 项目详细进展 picker: most recently progressed first, as on the Web page.
    public var projectsByRecency: [MemberProject] {
        projects.enumerated().sorted { lhs, rhs in
            let (a, b) = (lhs.element.project.lastProgressDate, rhs.element.project.lastProgressDate)
            return a == b ? lhs.offset < rhs.offset : a > b
        }.map(\.element)
    }
}

public struct MemberHeadline: Decodable, Equatable, Sendable {
    public var projectCount: Int
    /// Projects that are blocked or stalled.
    public var attention: Int
    public var activeDays28: Int
    /// "YYYY-MM-DD", nil when the member has no activity.
    public var lastActiveDate: String?
    public init(projectCount: Int, attention: Int, activeDays28: Int, lastActiveDate: String?) {
        self.projectCount = projectCount; self.attention = attention; self.activeDays28 = activeDays28; self.lastActiveDate = lastActiveDate
    }
}

public enum ProjectState: String, Decodable, Equatable, Sendable {
    case ok, stalled, blocked
    public init(from decoder: any Decoder) throws {
        self = ProjectState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .ok
    }
    /// `stateLabels` in member-overview.ts.
    public var label: String {
        switch self {
        case .ok: "进行中"
        case .stalled: "停滞"
        case .blocked: "有卡点"
        }
    }
}

public enum StepState: String, Decodable, Equatable, Sendable {
    case done, current, todo
    public init(from decoder: any Decoder) throws {
        self = StepState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .todo
    }
    /// `roadmapStateLabels` in apps/web/src/project-progress.tsx.
    public var label: String {
        switch self {
        case .done: "已完成"
        case .current: "进行中"
        case .todo: "未开始"
        }
    }
}

public struct ProjectStep: Decodable, Equatable, Sendable {
    public var name: String
    public var state: StepState
    public init(name: String, state: StepState) { self.name = name; self.state = state }
}

public struct ProfileClaim: Decodable, Equatable, Sendable {
    public var text: String
    public init(text: String) { self.text = text }
}

public struct ProjectProfileNote: Decodable, Equatable, Sendable {
    public var oneLine: ProfileClaim?
    public var intro: ProfileClaim?
    public var features: [ProfileClaim]
    public var openIssues: [ProfileClaim]
    public var status: ProfileClaim?
    public init(oneLine: ProfileClaim? = nil, intro: ProfileClaim? = nil, features: [ProfileClaim] = [], openIssues: [ProfileClaim] = [], status: ProfileClaim? = nil) {
        self.oneLine = oneLine; self.intro = intro; self.features = features; self.openIssues = openIssues; self.status = status
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        oneLine = try c.decodeIfPresent(ProfileClaim.self, forKey: .oneLine)
        intro = try c.decodeIfPresent(ProfileClaim.self, forKey: .intro)
        features = try c.decodeIfPresent([ProfileClaim].self, forKey: .features) ?? []
        openIssues = try c.decodeIfPresent([ProfileClaim].self, forKey: .openIssues) ?? []
        status = try c.decodeIfPresent(ProfileClaim.self, forKey: .status)
    }
    private enum Keys: String, CodingKey { case oneLine, intro, features, openIssues, status }
}

/// The project profile attached to a card; the server sends more keys (id, sessions, …) that the App does not show.
public struct ProjectProfile: Decodable, Equatable, Sendable {
    public var note: ProjectProfileNote
    public init(note: ProjectProfileNote) { self.note = note }
}

/// One project card on the member's page.
public struct MemberProject: Decodable, Equatable, Identifiable, Sendable {
    public var project: ProgressProject
    public var profile: ProjectProfile?
    public var steps: [ProjectStep]
    public var done: Int
    public var current: ProjectStep?
    public var blocker: ProjectKeyEvent?
    public var state: ProjectState
    /// Days since the project's last activity; nil when it has none.
    public var idle: Int?
    public var focus: String
    public var id: String { project.projectId }

    public init(project: ProgressProject, profile: ProjectProfile? = nil, steps: [ProjectStep] = [], done: Int = 0, current: ProjectStep? = nil, blocker: ProjectKeyEvent? = nil, state: ProjectState = .ok, idle: Int? = nil, focus: String = "") {
        self.project = project; self.profile = profile; self.steps = steps; self.done = done; self.current = current
        self.blocker = blocker; self.state = state; self.idle = idle; self.focus = focus
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        project = try c.decode(ProgressProject.self, forKey: .project)
        profile = try c.decodeIfPresent(ProjectProfile.self, forKey: .profile)
        steps = try c.decodeIfPresent([ProjectStep].self, forKey: .steps) ?? []
        done = try c.decodeIfPresent(Int.self, forKey: .done) ?? 0
        current = try c.decodeIfPresent(ProjectStep.self, forKey: .current)
        blocker = try c.decodeIfPresent(ProjectKeyEvent.self, forKey: .blocker)
        state = try c.decodeIfPresent(ProjectState.self, forKey: .state) ?? .ok
        idle = try c.decodeIfPresent(Int.self, forKey: .idle)
        focus = try c.decodeIfPresent(String.self, forKey: .focus) ?? ""
    }
    private enum Keys: String, CodingKey { case project, profile, steps, done, current, blocker, state, idle, focus }
}

public struct ProgressEvent: Decodable, Equatable, Sendable {
    public var date: String
    /// start, pause, resume, complete, reopen or milestone; kept as sent so a new type still shows.
    public var type: String
    public var reason: String
    public init(date: String, type: String, reason: String = "") { self.date = date; self.type = type; self.reason = reason }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        date = try c.decode(String.self, forKey: .date)
        type = try c.decode(String.self, forKey: .type)
        reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? ""
    }
    private enum Keys: String, CodingKey { case date, type, reason }
    /// `progressEventLabels` in packages/contracts/src/project-progress.ts.
    public var label: String {
        ["start": "开始", "pause": "暂停", "resume": "恢复", "complete": "完成", "reopen": "重新开启", "milestone": "里程碑"][type] ?? type
    }
}

public struct ProgressDayEntry: Decodable, Equatable, Identifiable, Sendable {
    public var id: String
    public var summary: String
    public init(id: String, summary: String) { self.id = id; self.summary = summary }
}

public struct ProgressDay: Decodable, Equatable, Sendable {
    public var date: String
    public var entries: [ProgressDayEntry]
    public init(date: String, entries: [ProgressDayEntry]) { self.date = date; self.entries = entries }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        date = try c.decode(String.self, forKey: .date)
        entries = try c.decodeIfPresent([ProgressDayEntry].self, forKey: .entries) ?? []
    }
    private enum Keys: String, CodingKey { case date, entries }
}

public struct ProjectKeyEvent: Decodable, Equatable, Identifiable, Sendable {
    public var date: String
    /// goal_change, milestone, decision, blocker or stage_change.
    public var type: String
    public var title: String
    public var detail: String
    /// The roadmap stage the event belongs to.
    public var step: String?
    public var id: String { "\(date)|\(type)|\(title)|\(detail)" }
    public init(date: String, type: String, title: String, detail: String = "", step: String? = nil) {
        self.date = date; self.type = type; self.title = title; self.detail = detail; self.step = step
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        date = try c.decode(String.self, forKey: .date)
        type = try c.decode(String.self, forKey: .type)
        title = try c.decode(String.self, forKey: .title)
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
        step = try c.decodeIfPresent(String.self, forKey: .step)
    }
    private enum Keys: String, CodingKey { case date, type, title, detail, step }
    /// `keyEventTypeLabels` in apps/web/src/project-progress.tsx.
    public var typeLabel: String {
        ["goal_change": "目标调整", "milestone": "里程碑", "decision": "重要决定", "blocker": "问题阻塞", "stage_change": "阶段切换"][type] ?? type
    }
}

public struct ProjectOutlook: Decodable, Equatable, Sendable {
    public var goal: String
    public var roadmap: [ProjectStep]
    public var position: String
    public init(goal: String, roadmap: [ProjectStep], position: String = "") { self.goal = goal; self.roadmap = roadmap; self.position = position }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        goal = try c.decodeIfPresent(String.self, forKey: .goal) ?? ""
        roadmap = try c.decodeIfPresent([ProjectStep].self, forKey: .roadmap) ?? []
        position = try c.decodeIfPresent(String.self, forKey: .position) ?? ""
    }
    private enum Keys: String, CodingKey { case goal, roadmap, position }
}

public struct ProgressProject: Decodable, Equatable, Identifiable, Sendable {
    public struct Focus: Decodable, Equatable, Sendable {
        public var text: String
        public init(text: String) { self.text = text }
    }
    public struct Latest: Decodable, Equatable, Sendable {
        public var date: String
        public var summary: String
        public init(date: String, summary: String) { self.date = date; self.summary = summary }
    }
    public var partnerId: String
    public var projectId: String
    public var projectName: String
    public var projectDescription: String?
    public var events: [ProgressEvent]
    /// Only the calendar month the request asked for.
    public var days: [ProgressDay]
    public var contributionDays: Int
    public var undatedCount: Int
    public var currentFocus: Focus?
    public var outlook: ProjectOutlook?
    public var keyEvents: [ProjectKeyEvent]
    public var latestProgress: Latest?
    public var id: String { projectId }

    public init(partnerId: String = "", projectId: String, projectName: String, projectDescription: String? = nil, events: [ProgressEvent] = [], days: [ProgressDay] = [], contributionDays: Int = 0, undatedCount: Int = 0, currentFocus: Focus? = nil, outlook: ProjectOutlook? = nil, keyEvents: [ProjectKeyEvent] = [], latestProgress: Latest? = nil) {
        self.partnerId = partnerId; self.projectId = projectId; self.projectName = projectName; self.projectDescription = projectDescription
        self.events = events; self.days = days; self.contributionDays = contributionDays; self.undatedCount = undatedCount
        self.currentFocus = currentFocus; self.outlook = outlook; self.keyEvents = keyEvents; self.latestProgress = latestProgress
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        partnerId = try c.decodeIfPresent(String.self, forKey: .partnerId) ?? ""
        projectId = try c.decode(String.self, forKey: .projectId)
        projectName = try c.decode(String.self, forKey: .projectName)
        projectDescription = try c.decodeIfPresent(String.self, forKey: .projectDescription)
        events = try c.decodeIfPresent([ProgressEvent].self, forKey: .events) ?? []
        days = try c.decodeIfPresent([ProgressDay].self, forKey: .days) ?? []
        contributionDays = try c.decodeIfPresent(Int.self, forKey: .contributionDays) ?? 0
        undatedCount = try c.decodeIfPresent(Int.self, forKey: .undatedCount) ?? 0
        currentFocus = try c.decodeIfPresent(Focus.self, forKey: .currentFocus)
        outlook = try c.decodeIfPresent(ProjectOutlook.self, forKey: .outlook)
        keyEvents = try c.decodeIfPresent([ProjectKeyEvent].self, forKey: .keyEvents) ?? []
        latestProgress = try c.decodeIfPresent(Latest.self, forKey: .latestProgress)
    }
    private enum Keys: String, CodingKey {
        case partnerId, projectId, projectName, projectDescription, events, days, contributionDays, undatedCount
        case currentFocus, outlook, keyEvents, latestProgress
    }

    /// The latest reviewed entry's date, else the last lifecycle event's; empty when there is neither.
    public var lastProgressDate: String { latestProgress?.date ?? events.last?.date ?? "" }
    /// 当前重点: the reviewed focus, else the latest reviewed entry, else a fixed sentence (as on the Web page).
    public var focusText: String {
        for text in [currentFocus?.text, latestProgress?.summary] {
            if let text, !text.isEmpty { return text }
        }
        return "暂无已审核的工作进展。"
    }
    /// What happened on `date` (YYYY-MM-DD): the day's entries and the lifecycle events recorded for it.
    public func activity(on date: String) -> (entries: [ProgressDayEntry], events: [ProgressEvent]) {
        (days.first { $0.date == date }?.entries ?? [], events.filter { $0.date == date })
    }
}
