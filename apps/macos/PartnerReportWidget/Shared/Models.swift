import Foundation

struct WidgetCredentials: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    let accessExpiresAt: String
    let pluginInstanceId: String
    let partnerId: String
}

struct WidgetQueueResponse: Codable, Equatable {
    let generatedAt: String
    let totalCount: Int
    let items: [WidgetQueueItem]
    let permissions: PermissionCollection?
    let workCards: [WorkCard]?
    let connectionRecoveries: [ConnectionRecovery]?
    let dashboard: WidgetDashboardSummary?

    static let empty = WidgetQueueResponse(
        generatedAt: ISO8601DateFormatter().string(from: Date()),
        totalCount: 0, items: [], permissions: nil, workCards: [],
        connectionRecoveries: [], dashboard: nil
    )
}

struct PermissionCollection: Codable, Equatable {
    let pluginInstanceId: String?
    let version: Int
    let items: [ProjectPermission]
}

struct ProjectPermission: Codable, Identifiable, Equatable {
    var id: String { scopeKey }
    let scopeKey: String
    let displayName: String
    let status: String
    let sessionCount: Int
    let firstSeenAt: String
    let lastSeenAt: String
    let effectiveFrom: String?
    let periodKey: String?
}

struct WorkCard: Codable, Identifiable, Equatable {
    let id: String
    let reviewId: String
    let projectName: String
    let title: String
    let status: String
    let reviewStatus: String
    let reviewState: String
    let reviewVersion: Int
    let payload: WorkCardPayload
    let sourceCount: Int
    let periodKey: String
    let periodStartsAt: String
    let periodEndsAt: String
    let busy: Bool
    let versions: [WorkCardVersion]
}

struct WorkCardPayload: Codable, Equatable {
    let summary: String?
    let overview: String?
    let projectDescription: String?
    let outcomes: [String]?
    let blockers: [String]?
    let nextSteps: [String]?
    let dailyProgress: [WidgetDailyProgress]?
}

struct WorkCardVersion: Codable, Identifiable, Equatable {
    var id: Int { version }
    let version: Int
    let title: String
    let status: String
    let payload: WorkCardPayload
    let instruction: String?
    let source: String
    let createdAt: String
}

struct ConnectionRecovery: Codable, Identifiable, Equatable {
    let id: String
    let deviceName: String
    let pluginVersion: String
    let pluginInstanceId: String
    let createdAt: String
    let expiresAt: String
}

struct WidgetQueueItem: Codable, Identifiable, Equatable {
    let id: String
    let kind: String
    let title: String
    let subtitle: String
    let detail: String
    let projectDescription: String?
    let overview: String?
    let dailyProgress: [WidgetDailyProgress]?
    let sourceCount: Int?
    let periodKey: String?
    let busy: Bool
    let action: WidgetQueueAction
}

struct WidgetDailyProgress: Codable, Equatable { let date: String; let summary: String }

struct WidgetDashboardSummary: Codable, Equatable {
    let status: String
    let lastRunAt: String?
    let nextRunAt: String?
    let errorCode: String?
    let errorMessage: String?
    let today: WidgetTodaySummary
    let week: WidgetWeekSummary
}

struct WidgetTodaySummary: Codable, Equatable {
    let discovered: Int
    let useful: Int
    let uploaded: Int
    let unchanged: Int
    let failed: Int
}

struct WidgetWeekSummary: Codable, Equatable {
    let periodKey: String?
    let totalUseful: Int
    let days: [WidgetDaySummary]
}

struct WidgetDaySummary: Codable, Equatable, Identifiable {
    var id: String { date }
    let date: String
    let label: String
    let useful: Int
    let status: String
}

struct WidgetQueueAction: Codable, Equatable {
    let pluginInstanceId: String?
    let scopeKey: String?
    let baseVersion: Int?
    let reviewId: String?
    let workItemId: String?
}

struct BindingResponse: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: String
    let pluginInstanceId: String
    let partnerId: String
    let challenge: String
}

struct RefreshResponse: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: String
}

struct ServerErrorBody: Codable { let code: String?; let message: String? }

enum WidgetClientError: LocalizedError {
    case notConnected, invalidServer, invalidResponse, localDataUnavailable
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "工作看板尚未连接。"
        case .invalidServer: return "中台地址无效。"
        case .invalidResponse: return "中台返回了无法识别的数据。"
        case .localDataUnavailable: return "无法访问本机插件数据，请重新启动应用后再试。"
        case .server(let message): return message
        }
    }
}
