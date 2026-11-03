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
    public struct Progress: Codable, Equatable, Sendable {
        public var date: String
        public var summary: String
    }
    public struct Payload: Codable, Equatable, Sendable {
        public var overview: String?
        public var summary: String?
        public var dailyProgress: [Progress]?
        public var projectStatus: CardProjectStatus?
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
    public var review: Header
    public var items: [ReviewCard]
    public var regenerationJobs: [Job]
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
