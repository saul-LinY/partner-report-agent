import Foundation

public enum StartupStage: Equatable, Sendable {
    case binding, permissions, welcome, scanning, ready
}

public struct SessionScanWindow: Codable, Equatable, Sendable {
    public let start: Date
    public let end: Date
    public init(start: Date, end: Date) { self.start = start; self.end = end }
    public init(endingAt date: Date, calendar: Calendar = .current) {
        end = date
        start = calendar.date(byAdding: .month, value: -1, to: date) ?? date.addingTimeInterval(-30 * 24 * 60 * 60)
    }
    public func contains(_ date: Date) -> Bool { date >= start && date <= end }
}

public struct DiscoveryProgress: Equatable, Sendable {
    public var completedSteps: Int
    public var totalSteps: Int
    public var message: String
    public var toolsFound: Int
    public var projectsFound: Int
    public var fraction: Double { min(1, max(0, Double(completedSteps) / Double(max(1, totalSteps)))) }
    public init(completedSteps: Int = 0, totalSteps: Int = 6, message: String = "正在识别会话目录", toolsFound: Int = 0, projectsFound: Int = 0) {
        self.completedSteps = completedSteps
        self.totalSteps = totalSteps
        self.message = message
        self.toolsFound = toolsFound
        self.projectsFound = projectsFound
    }
}

public struct SessionCollectionFailure: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var message: String
    public init(id: String, title: String, message: String) {
        self.id = id; self.title = title; self.message = message
    }
}

public struct SessionCollectionProgress: Equatable, Sendable {
    public var message: String
    public var total: Int
    public var processed: Int
    public var completed: Int
    public var excluded: Int
    public var failures: [SessionCollectionFailure]
    public var fraction: Double { total == 0 ? 0 : min(1, max(0, Double(completed) / Double(total))) }
    public init(message: String = "正在加载会话内容", total: Int = 0, processed: Int = 0, completed: Int = 0, excluded: Int = 0, failures: [SessionCollectionFailure] = []) {
        self.message = message
        self.total = total; self.processed = processed; self.completed = completed; self.excluded = excluded; self.failures = failures
    }
}
