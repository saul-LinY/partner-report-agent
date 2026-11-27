import Foundation

/// What `GET /v1/collector/personal-data` returns: the member's own progress and data for the team's current weekly period.
/// Mirrors `PersonalData` in packages/contracts/src/member-overview.ts. Decoding is tolerant by design: counters and lists
/// the server omits become 0 or empty, unknown keys are ignored, so a newer server never blanks the page. The period and
/// member identity are required: without them the page has nothing to say.
public struct PersonalData: Decodable, Equatable, Sendable {
    public struct Member: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
        public init(id: String, name: String) { self.id = id; self.name = name }
    }

    /// The weekly period the page is about. All four instants are absolute (ISO 8601 on the wire).
    public struct Period: Decodable, Equatable, Sendable {
        public var periodKey: String
        public var startsAt: Date
        public var cutoffAt: Date
        public var autoApproveAt: Date
        public var publishAt: Date
        public init(periodKey: String, startsAt: Date, cutoffAt: Date, autoApproveAt: Date, publishAt: Date) {
            self.periodKey = periodKey; self.startsAt = startsAt; self.cutoffAt = cutoffAt
            self.autoApproveAt = autoApproveAt; self.publishAt = publishAt
        }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            periodKey = try c.decode(String.self, forKey: .periodKey)
            startsAt = try Instant.decode(c, .startsAt)
            cutoffAt = try Instant.decode(c, .cutoffAt)
            autoApproveAt = try Instant.decode(c, .autoApproveAt)
            publishAt = try Instant.decode(c, .publishAt)
        }
        private enum Keys: String, CodingKey { case periodKey, startsAt, cutoffAt, autoApproveAt, publishAt }
    }

    public struct LastUpload: Decodable, Equatable, Sendable {
        public var at: Date
        /// The server's raw upload status: only "completed" is a success; "receiving", "superseded" and the rest are not.
        public var status: String
        public init(at: Date, status: String) { self.at = at; self.status = status }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            at = try Instant.decode(c, .at)
            status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        }
        private enum Keys: String, CodingKey { case at, status }
        /// `receiving` is a batch still arriving; `superseded` was replaced by a newer batch. Neither is a failure.
        public var label: String {
            switch status {
            case "completed": "成功"
            case "receiving": "上传中"
            case "superseded": "已被新上传替代"
            default: status
            }
        }
    }

    public struct Totals: Decodable, Equatable, Sendable {
        public var sessions: Int
        public var turns: Int
        /// Days this period with at least one turn.
        public var activeDays: Int
        /// Calendar days from the period's first day to today (inclusive, capped at the cutoff day).
        public var elapsedDays: Int
        public init(sessions: Int, turns: Int, activeDays: Int, elapsedDays: Int) {
            self.sessions = sessions; self.turns = turns; self.activeDays = activeDays; self.elapsedDays = elapsedDays
        }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            sessions = try c.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
            turns = try c.decodeIfPresent(Int.self, forKey: .turns) ?? 0
            activeDays = try c.decodeIfPresent(Int.self, forKey: .activeDays) ?? 0
            elapsedDays = try c.decodeIfPresent(Int.self, forKey: .elapsedDays) ?? 0
        }
        private enum Keys: String, CodingKey { case sessions, turns, activeDays, elapsedDays }
    }

    /// One conversation turn at its own minute: `t` is "YYYY-MM-DDTHH:mm" in team time, `p` the project name.
    public struct ActivityEvent: Decodable, Equatable, Sendable {
        public var t: String
        public var p: String
        public init(t: String, p: String) { self.t = t; self.p = p }
    }

    /// 工作投入: the member's turns over the activity window (about 90 days up to now), allowed projects only.
    public struct History: Decodable, Equatable, Sendable {
        /// First and last team day of the window, "YYYY-MM-DD".
        public var from: String
        public var to: String
        public var events: [ActivityEvent]
        public init(from: String = "", to: String = "", events: [ActivityEvent] = []) { self.from = from; self.to = to; self.events = events }
        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            from = try c.decodeIfPresent(String.self, forKey: .from) ?? ""
            to = try c.decodeIfPresent(String.self, forKey: .to) ?? ""
            events = try c.decodeIfPresent([ActivityEvent].self, forKey: .events) ?? []
        }
        private enum Keys: String, CodingKey { case from, to, events }
    }

    public var generatedAt: Date?
    public var timezone: String
    public var member: Member
    public var period: Period
    public var lastUpload: LastUpload?
    public var totals: Totals
    public var events: [ActivityEvent]
    public var projects: [PersonalWeekProject]
    public var history: History
    public var owned: [PersonalOwnedProject]

    public init(generatedAt: Date? = nil, timezone: String, member: Member, period: Period, lastUpload: LastUpload?, totals: Totals, events: [ActivityEvent], projects: [PersonalWeekProject], history: History = .init(), owned: [PersonalOwnedProject] = []) {
        self.generatedAt = generatedAt; self.timezone = timezone; self.member = member; self.period = period
        self.lastUpload = lastUpload; self.totals = totals; self.events = events; self.projects = projects
        self.history = history; self.owned = owned
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        generatedAt = try c.decodeIfPresent(String.self, forKey: .generatedAt).flatMap(Instant.parse)
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone) ?? ""
        member = try c.decode(Member.self, forKey: .member)
        period = try c.decode(Period.self, forKey: .period)
        lastUpload = try c.decodeIfPresent(LastUpload.self, forKey: .lastUpload)
        totals = try c.decodeIfPresent(Totals.self, forKey: .totals) ?? Totals(sessions: 0, turns: 0, activeDays: 0, elapsedDays: 0)
        events = try c.decodeIfPresent([ActivityEvent].self, forKey: .events) ?? []
        projects = try c.decodeIfPresent([PersonalWeekProject].self, forKey: .projects) ?? []
        history = try c.decodeIfPresent(History.self, forKey: .history) ?? .init()
        owned = try c.decodeIfPresent([PersonalOwnedProject].self, forKey: .owned) ?? []
    }
    private enum Keys: String, CodingKey { case generatedAt, timezone, member, period, lastUpload, totals, events, projects, history, owned }
}

/// 负责的项目: the leadership page's moving projects (正常推进 or 有卡点), computed live, limited to ones the member still allows.
public struct PersonalOwnedProject: Decodable, Equatable, Identifiable, Sendable {
    public var name: String
    public var oneLine: String?
    /// The newest approved work card's focus, else the profile's status.
    public var focus: String?
    public var intro: String?
    public var contributionDays: Int
    public var features: [String]
    public var openIssues: [String]
    public var id: String { name }
    public init(name: String, oneLine: String? = nil, focus: String? = nil, intro: String? = nil, contributionDays: Int = 0, features: [String] = [], openIssues: [String] = []) {
        self.name = name; self.oneLine = oneLine; self.focus = focus; self.intro = intro
        self.contributionDays = contributionDays; self.features = features; self.openIssues = openIssues
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = try c.decode(String.self, forKey: .name)
        oneLine = try c.decodeIfPresent(String.self, forKey: .oneLine)
        focus = try c.decodeIfPresent(String.self, forKey: .focus)
        intro = try c.decodeIfPresent(String.self, forKey: .intro)
        contributionDays = try c.decodeIfPresent(Int.self, forKey: .contributionDays) ?? 0
        features = try c.decodeIfPresent([String].self, forKey: .features) ?? []
        openIssues = try c.decodeIfPresent([String].self, forKey: .openIssues) ?? []
    }
    private enum Keys: String, CodingKey { case name, oneLine, focus, intro, contributionDays, features, openIssues }
}

/// A list of at most a few shown items plus how many the project has in all.
public struct PersonalWeekItems: Decodable, Equatable, Sendable {
    public var items: [String]
    public var total: Int
    public init(items: [String] = [], total: Int = 0) { self.items = items; self.total = total }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        items = try c.decodeIfPresent([String].self, forKey: .items) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? items.count
    }
    private enum Keys: String, CodingKey { case items, total }
    /// Items the project has beyond the ones shown.
    public var hidden: Int { max(0, total - items.count) }
}

/// One project card of the week.
public struct PersonalWeekProject: Decodable, Equatable, Identifiable, Sendable {
    public var name: String
    public var oneLine: String?
    public var sessions: Int
    public var turns: Int
    /// The last turn this period, "YYYY-MM-DDTHH:mm" in team time.
    public var lastAt: String?
    /// The last activity ever, "YYYY-MM-DD"; shown when the project has no session this week.
    public var lastActiveDate: String?
    public var outcomes: PersonalWeekItems
    public var decisions: PersonalWeekItems
    public var problems: PersonalWeekItems
    public var id: String { name }
    /// A project with neither a kept session nor turns this week gets the grey "还没有会话" card. Turns without a session
    /// are real: the upload has not been analysed yet, so the card shows its stats with empty groups.
    public var hasActivity: Bool { sessions > 0 || turns > 0 }

    public init(name: String, oneLine: String? = nil, sessions: Int = 0, turns: Int = 0, lastAt: String? = nil, lastActiveDate: String? = nil, outcomes: PersonalWeekItems = .init(), decisions: PersonalWeekItems = .init(), problems: PersonalWeekItems = .init()) {
        self.name = name; self.oneLine = oneLine; self.sessions = sessions; self.turns = turns; self.lastAt = lastAt
        self.lastActiveDate = lastActiveDate; self.outcomes = outcomes; self.decisions = decisions; self.problems = problems
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = try c.decode(String.self, forKey: .name)
        oneLine = try c.decodeIfPresent(String.self, forKey: .oneLine)
        sessions = try c.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
        turns = try c.decodeIfPresent(Int.self, forKey: .turns) ?? 0
        lastAt = try c.decodeIfPresent(String.self, forKey: .lastAt)
        lastActiveDate = try c.decodeIfPresent(String.self, forKey: .lastActiveDate)
        outcomes = try c.decodeIfPresent(PersonalWeekItems.self, forKey: .outcomes) ?? .init()
        decisions = try c.decodeIfPresent(PersonalWeekItems.self, forKey: .decisions) ?? .init()
        problems = try c.decodeIfPresent(PersonalWeekItems.self, forKey: .problems) ?? .init()
    }
    private enum Keys: String, CodingKey { case name, oneLine, sessions, turns, lastAt, lastActiveDate, outcomes, decisions, problems }
}

/// ISO 8601 instants as the server writes them (`2026-11-20T08:00:00.000Z`), with or without fractional seconds.
enum Instant {
    static func parse(_ value: String) -> Date? {
        (try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(value, strategy: Date.ISO8601FormatStyle()))
    }
    static func decode<K: CodingKey>(_ container: KeyedDecodingContainer<K>, _ key: K) throws -> Date {
        let value = try container.decode(String.self, forKey: key)
        guard let date = parse(value) else {
            throw DecodingError.dataCorruptedError(forKey: key, in: container, debugDescription: "Not an ISO 8601 instant: \(value)")
        }
        return date
    }
}
