import Foundation

public enum ApprovalTarget: Hashable, Sendable {
    case project(String), card(String)
    public var key: String {
        switch self {
        case .project(let id): "project:\(id)"
        case .card(let id): "card:\(id)"
        }
    }
    public init?(key: String) {
        if key.hasPrefix("project:") { self = .project(String(key.dropFirst(8))) }
        else if key.hasPrefix("card:") { self = .card(String(key.dropFirst(5))) }
        else { return nil }
    }
}

public struct ApprovalReminderGroup: Equatable, Sendable {
    public let identifier: String
    public let keys: Set<String>
    public let freshKeys: Set<String>
    public let isProject: Bool
    public static func groups(targets: [ApprovalTarget], notified: Set<String>) -> [Self] {
        [true, false].map { isProject in
            let keys = Set(targets.compactMap { target -> String? in
                switch target {
                case .project: isProject ? target.key : nil
                case .card: isProject ? nil : target.key
                }
            })
            return Self(identifier: isProject ? "approval-projects" : "approval-cards", keys: keys, freshKeys: keys.subtracting(notified), isProject: isProject)
        }
    }
}

public enum CardProjectStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case research, development, delivery, paused
    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .research: "调研中"
        case .development: "开发中"
        case .delivery: "交付中"
        case .paused: "已暂停"
        }
    }
}

public struct ReviewCard: Codable, Identifiable, Equatable, Sendable {
    public struct Payload: Codable, Equatable, Sendable {
        /// A blocker the card reports this week; `neededSupport` is what leadership must decide or provide.
        public struct Blocker: Codable, Equatable, Sendable {
            public var type: String
            public var title: String
            public var detail: String?
            public var neededSupport: String?
        }
        /// A blocker from an earlier week that the card says is resolved, with the one-line reason.
        public struct ResolvedBlocker: Codable, Equatable, Sendable {
            public var title: String
            public var resolvedOn: String?
            public var evidence: String?
        }
        public var overview: String?
        public var summary: String?
        public var currentFocus: String?
        public var keyEvents: [Blocker]?
        public var resolvedBlockers: [ResolvedBlocker]?
        public var projectStatus: CardProjectStatus?
        public var blockers: [Blocker] { (keyEvents ?? []).filter { $0.type == "blocker" } }
    }
    public var id: String
    public var title: String
    public var project_name: String?
    public var status: String
    public var review_status: String
    public var payload: Payload
    public var displayName: String { project_name ?? title }
    public var projectStatus: CardProjectStatus {
        payload.projectStatus ?? (["discussion", "planned"].contains(status) ? .research : .development)
    }
}

public struct ReviewBatch: Codable, Identifiable, Equatable, Sendable {
    public struct Header: Codable, Equatable, Sendable {
        public var id: String
        public var state: String
        public var version: Int
        public var period_key: String?
    }
    public struct Job: Codable, Equatable, Sendable {
        public var work_item_id: String
        public var status: String
        public var error_message: String?
    }
    /// The weekly schedule of this review; every instant is an ISO timestamp.
    public struct Period: Codable, Equatable, Sendable {
        public var periodKey: String
        public var startsAt: String
        public var cutoffAt: String
        public var autoApproveAt: String
        public var publishAt: String
        public var timezone: String
        public var autoApproveDate: Date? { Self.date(autoApproveAt) }
        public var publishDate: Date? { Self.date(publishAt) }
        public var startsDate: Date? { Self.date(startsAt) }
        public var cutoffDate: Date? { Self.date(cutoffAt) }
        static func date(_ value: String) -> Date? {
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        }
        private func text(_ date: Date?, _ format: String) -> String {
            guard let date else { return "" }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "zh_CN")
            formatter.timeZone = TimeZone(identifier: timezone) ?? .current
            formatter.dateFormat = format
            return formatter.string(from: date)
        }
        /// "11月16日（周一）13:00": when approved cards reach the leadership panel.
        public var publishText: String { text(publishDate, "M月d日（EEE）HH:mm") }
        /// "11月16日 12:00": the moment pending cards are approved as they are.
        public var autoApproveText: String { text(autoApproveDate, "M月d日 HH:mm") }
        /// "2 天 20 小时" until the automatic approval; nil once it has passed.
        public func countdown(now: Date) -> String? {
            guard let deadline = autoApproveDate, deadline > now else { return nil }
            let minutes = Int(deadline.timeIntervalSince(now) / 60)
            let (days, hours, rest) = (minutes / 1440, minutes % 1440 / 60, minutes % 60)
            if days > 0 { return "\(days) 天 \(hours) 小时" }
            if hours > 0 { return "\(hours) 小时 \(rest) 分钟" }
            return "\(max(rest, 1)) 分钟"
        }
    }
    public var review: Header
    public var items: [ReviewCard]
    public var regenerationJobs: [Job]
    public var period: Period?
    public var id: String { review.id }
    public var pendingCards: [ReviewCard] {
        review.state == "IN_PROGRESS" ? items.filter { $0.review_status == "pending" } : []
    }
    public func job(for cardID: String) -> Job? { regenerationJobs.first { $0.work_item_id == cardID } }
    public func isRegenerating(_ cardID: String) -> Bool {
        ["PENDING", "LEASED", "RETRY_WAIT"].contains(job(for: cardID)?.status ?? "")
    }
}

public enum CardAction: Sendable, Equatable {
    case approve, exclude, status(CardProjectStatus), regenerate(String)
}

public protocol ReviewServing: Sendable {
    func login(email: String, password: String) async throws
    func logout() async throws
    func loadReviews() async throws -> [ReviewBatch]
    func perform(_ action: CardAction, cardID: String, reviewID: String, version: Int) async throws
}

public struct ReviewServiceError: Error, LocalizedError, Sendable {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }
    public init(status: Int, message: String) { self.status = status; self.message = message }
}
