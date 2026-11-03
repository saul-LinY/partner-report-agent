import Foundation
import CryptoKit
import Security

public enum SystemNotificationPermission: String, Codable, Sendable {
    case allowed, denied, notConfigured
    var logCode: String {
        switch self {
        case .allowed: "NOTIFICATIONS_ALLOWED"
        case .denied: "NOTIFICATIONS_DENIED"
        case .notConfigured: "NOTIFICATIONS_NOT_CONFIGURED"
        }
    }
}

public struct CollectorPolicy: Codable, Equatable, Sendable {
    public var version: Int
    public var entries: [Entry]
    public var currentPeriod: Period?
    public struct Entry: Codable, Equatable, Identifiable, Sendable {
        public var scopeKey: String
        public var displayName: String
        public var status: ProjectPermission
        public var id: String { scopeKey }
    }
    public struct Period: Codable, Equatable, Sendable {
        public var periodKey: String
        public var startsAt: Date
        public var endsAt: Date
    }
}

public struct CollectorClaim: Decodable, Sendable {
    public var deviceId: String
    public var name: String
    public var policy: CollectorPolicy
}

public struct CollectorSession: Codable, Equatable, Sendable {
    public var id: String
    public var scopeKey: String
    public var agent: Agent
    public var title: String
    public var modifiedAt: Date
    public var turns: [ChatTurn]
}

public struct CollectorPackage: Codable, Sendable {
    public var id: String
    public var periodKey: String
    public var startsAt: Date
    public var endsAt: Date
    public var policyVersion: Int
    public var sessionCount: Int
    public var parts: [Data]
    public var partDigests: [String] { parts.map(Self.digest) }
    public static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    /// `start` may precede the period: older unsent sessions are retained, analysis stays period-bound.
    public init(period: CollectorPolicy.Period, start: Date, end: Date, version: Int, sessions: [CollectorSession], targetBytes: Int = 2 * 1024 * 1024) throws {
        id = UUID().uuidString; periodKey = period.periodKey
        endsAt = min(end, period.endsAt); startsAt = min(start, endsAt); policyVersion = version; sessionCount = sessions.count
        let encoder = CollectorJSON.encoder()
        var chunks: [Data] = [], current: [CollectorSession] = [], size = 2
        for session in sessions {
            let bytes = try encoder.encode(session).count + 1
            guard bytes < 16 * 1024 * 1024 else { throw CollectorError(status: 413, message: "单个会话超过 16 MB，未上传，请联系管理员。") }
            if !current.isEmpty && size + bytes > targetBytes { chunks.append(try encoder.encode(current)); current = []; size = 2 }
            current.append(session); size += bytes
        }
        if !current.isEmpty || chunks.isEmpty { chunks.append(try encoder.encode(current)) }
        parts = chunks
    }
}

public struct CollectorLog: Codable, Sendable {
    public var eventId = UUID().uuidString
    public var occurredAt = Date.now
    public var stage: String
    public var level: String
    public var code: String
    public var uploadId: String?
    public var sessionCount: Int
    public var state: CollectorDeviceState? = nil
    /// Whitelisted diagnostics only. Absent in logs persisted before this field existed, and omitted (never null) on the wire.
    public var details: CollectorLogDetails? = nil
}

/// Mirrors `collectorLogDetailsSchema` in apps/api/src/collector-contracts.ts, which is `.strict()` and
/// optional-not-nullable: every key here is exactly one of its keys and nil values are never encoded.
/// Never put paths, tokens, session text or free-form exception strings in here.
public struct CollectorLogDetails: Codable, Equatable, Sendable {
    public enum ErrorKind: String, Codable, Sendable { case network, auth, policy, server, storage, size, read, unknown }
    public var appVersion: String?
    public var osVersion: String?
    public var durationMs: Int?
    public var httpStatus: Int?
    public var apiErrorCode: String?
    public var errorDomain: String?
    public var errorCode: Int?
    public var errorKind: ErrorKind?
    public var message: String?
    public var projectCount: Int?
    public var sessionCount: Int?
    public var failedSessionCount: Int?
    public var partIndex: Int?
    public var partCount: Int?
    public var bytes: Int?
    public var windowStart: Date?
    public var windowEnd: Date?
    public var periodKey: String?
    public var policyVersion: Int?
    public var agent: Agent?
    public var retryAttempt: Int?

    enum CodingKeys: String, CodingKey, CaseIterable {
        case appVersion, osVersion, durationMs, httpStatus, apiErrorCode, errorDomain, errorCode, errorKind, message
        case projectCount, sessionCount, failedSessionCount, partIndex, partCount, bytes
        case windowStart, windowEnd, periodKey, policyVersion, agent, retryAttempt
    }

    static func milliseconds(since start: ContinuousClock.Instant) -> Int {
        let elapsed = start.duration(to: .now).components
        return Int(elapsed.seconds) * 1000 + Int(elapsed.attoseconds / 1_000_000_000_000_000)
    }

    private static let environment: (appVersion: String, osVersion: String) = {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.2.1",
                "macOS \(version.majorVersion).\(version.minorVersion).\(version.patchVersion)")
    }()

    /// Package-level facts of an upload; derived from our own manifest, never from file contents.
    static func forPackage(_ package: CollectorPackage) -> CollectorLogDetails {
        CollectorLogDetails(durationMs: nil, sessionCount: package.sessionCount, partCount: package.parts.count,
            bytes: package.parts.reduce(0) { $0 + $1.count }, windowStart: package.startsAt, windowEnd: package.endsAt,
            periodKey: package.periodKey, policyVersion: package.policyVersion)
    }

    /// Failure to read local session content: a fixed description, never the underlying error text or file names.
    static let readFailure = CollectorLogDetails(errorKind: .read, message: fixedMessage(for: .read))

    /// Classifies our own error types into kind/status/API code with a fixed localized description. The error's
    /// `localizedDescription` is deliberately not used: it can carry server text, paths or tokens.
    static func failure(_ error: any Error) -> CollectorLogDetails {
        var details = CollectorLogDetails()
        let bridged = error as NSError
        switch error {
        case let error as CollectorError:
            details.httpStatus = error.status; details.apiErrorCode = error.apiCode; details.errorKind = kind(forStatus: error.status)
        case let error as ReviewServiceError:
            details.httpStatus = error.status; details.errorKind = kind(forStatus: error.status)
        case is URLError:
            details.errorKind = .network; details.errorDomain = bridged.domain; details.errorCode = bridged.code
        default:
            details.errorDomain = bridged.domain; details.errorCode = bridged.code
            details.errorKind = bridged.domain == NSCocoaErrorDomain || bridged.domain == NSPOSIXErrorDomain ? .storage : .unknown
        }
        details.message = details.errorKind.map(fixedMessage(for:))
        return details
    }

    static func kind(forStatus status: Int) -> ErrorKind {
        switch status {
        case 401, 403: .auth
        case 409: .policy
        case 413: .size
        case 400...: .server
        default: .unknown
        }
    }

    static func fixedMessage(for kind: ErrorKind) -> String {
        switch kind {
        case .network: "网络连接失败，未能到达系统。"
        case .auth: "绑定凭据无效或已被撤销。"
        case .policy: "采集策略已变更，或请求与系统当前状态冲突。"
        case .server: "系统返回了错误响应。"
        case .storage: "本机文件读写失败。"
        case .size: "上传内容超过大小限制。"
        case .read: "部分会话内容读取失败。"
        case .unknown: "发生未分类的错误。"
        }
    }

    /// Adds app/OS version and enforces the server bounds. The batch endpoint rejects a whole request for one
    /// out-of-range field, which would strand every queued log, so values are clamped or dropped here.
    func sanitized() -> CollectorLogDetails {
        var details = self
        func clamp(_ value: Int?, _ range: ClosedRange<Int>) -> Int? { value.map { min(max($0, range.lowerBound), range.upperBound) } }
        func text(_ value: String?, _ limit: Int) -> String? { value.flatMap { $0.isEmpty ? nil : String($0.prefix(limit)) } }
        func pattern(_ value: String?, _ expression: String) -> String? { value.flatMap { $0.range(of: expression, options: .regularExpression) == nil ? nil : $0 } }
        details.appVersion = text(appVersion ?? Self.environment.appVersion, 40)
        details.osVersion = text(osVersion ?? Self.environment.osVersion, 60)
        details.durationMs = clamp(durationMs, 0...86_400_000)
        details.httpStatus = httpStatus.flatMap { (100...599).contains($0) ? $0 : nil }
        details.apiErrorCode = pattern(apiErrorCode, #"\A[A-Z0-9_]{1,80}\z"#)
        details.errorDomain = pattern(errorDomain, #"\A[A-Za-z0-9_.]{1,80}\z"#)
        details.errorCode = errorCode.flatMap { Int32(exactly: $0) == nil ? nil : $0 }
        details.message = text(message, 300)
        details.projectCount = clamp(projectCount, 0...1_000_000)
        details.sessionCount = clamp(sessionCount, 0...1_000_000)
        details.failedSessionCount = clamp(failedSessionCount, 0...1_000_000)
        details.partIndex = clamp(partIndex, 0...10_000)
        details.partCount = clamp(partCount, 0...10_000)
        details.bytes = clamp(bytes, 0...1_000_000_000)
        details.periodKey = text(periodKey, 120)
        details.policyVersion = clamp(policyVersion, 0...1_000_000)
        details.retryAttempt = clamp(retryAttempt, 0...1_000)
        return details
    }
}

public struct CollectorDeviceState: Codable, Sendable {
    public var startupStage: String
    public var projectCount: Int
    public var allowedProjectCount: Int
    public var sessionCount: Int
    public var unreadableSessionCount: Int
    public var pendingSessionCount: Int
    public var isScanning: Bool
    public var isUploading: Bool
    public var scanProcessed: Int
    public var scanTotal: Int
    public var uploadProcessed: Int
    public var uploadTotal: Int
    public var autoUpload: Bool
    public var frequency: String
    public var uploadHour: Int
    public var uploadMinute: Int
    public var uploadWeekday: Int?
}

public struct CollectorProcessingSummary: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var stage: String
    public var label: String
    public var analysis_completed: Int
    public var analysis_total: Int
    public var pending_cards: Int
    public var approved_cards: Int
    public var error_code: String?
    public var card_error_code: String?
}

public struct CollectorError: LocalizedError, Sendable {
    public var status: Int
    public var message: String
    /// Machine-readable `code` of the API error body, when the server sent one.
    public var apiCode: String? = nil
    public var errorDescription: String? { message }
}

public enum CollectorJSON {
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var container = encoder.singleValueContainer(); try container.encode(formatter.string(from: date))
        }
        encoder.outputFormatting = [.sortedKeys]; return encoder
    }
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: text) else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid timestamp")) }
            return date
        }
        return decoder
    }
}

public struct AppMessage: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let title: String
    public let body: String
    public let targetType: String
    public let targetId: String?
    public let createdAt: Date
}

public protocol CollectorServing: Sendable {
    func pipeline(binding: LocalBinding) async throws -> [CollectorProcessingSummary]
    func claim(binding: LocalBinding, code: String) async throws -> CollectorClaim
    func policy(binding: LocalBinding) async throws -> CollectorPolicy
    func decide(binding: LocalBinding, version: Int, scopeKey: String, permission: ProjectPermission) async throws -> CollectorPolicy
    func register(binding: LocalBinding, scopeKey: String, name: String, periodKey: String, sessionCount: Int) async throws -> CollectorPolicy
    func upload(binding: LocalBinding, package: CollectorPackage) async throws
    func logs(binding: LocalBinding, events: [CollectorLog]) async throws
    func notifications(binding: LocalBinding) async throws -> [AppMessage]
    func acknowledgeNotifications(binding: LocalBinding, ids: [String]) async throws
    func reviews(binding: LocalBinding) async throws -> [ReviewBatch]
    func perform(binding: LocalBinding, action: CardAction, cardID: String, reviewID: String, version: Int) async throws
    /// Events recorded by the transport itself (per-part upload outcomes); returned once and cleared.
    func drainLogs() async -> [CollectorLog]
}

public extension CollectorServing {
    func pipeline(binding: LocalBinding) async throws -> [CollectorProcessingSummary] { [] }
    func notifications(binding: LocalBinding) async throws -> [AppMessage] { [] }
    func acknowledgeNotifications(binding: LocalBinding, ids: [String]) async throws { throw CollectorError(status: 501, message: "通知回执服务不可用。") }
    func reviews(binding: LocalBinding) async throws -> [ReviewBatch] { [] }
    func perform(binding: LocalBinding, action: CardAction, cardID: String, reviewID: String, version: Int) async throws { throw CollectorError(status: 501, message: "审核服务不可用。") }
    func drainLogs() async -> [CollectorLog] { [] }
}

private final class CollectorRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// The bearer token is stored only in Keychain; neither state.json nor diagnostics contain it.
public actor HTTPCollectorService: CollectorServing {
    public func pipeline(binding: LocalBinding) async throws -> [CollectorProcessingSummary] {
        struct Index: Decodable { var uploads: [CollectorProcessingSummary] }
        return try JSONDecoder().decode(Index.self, from: await request(binding, "pipeline")).uploads
    }
    private let session: URLSession
    private var transportLogs: [CollectorLog] = []
    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 60; configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: CollectorRedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    private func credentialQuery(_ binding: LocalBinding) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.weeklyreport.collector", kSecAttrAccount as String: binding.serviceAddress + ":" + (binding.deviceID ?? "")]
    }
    private func token(_ binding: LocalBinding) throws -> String {
        var query = credentialQuery(binding); query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { throw Self.credentialError(status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8), !value.isEmpty else {
            throw Self.credentialError(errSecItemNotFound)
        }
        return value
    }
    static func credentialError(_ status: OSStatus) -> CollectorError {
        if status == errSecItemNotFound { return CollectorError(status: 401, message: "绑定凭据不存在，请重新绑定。") }
        return CollectorError(status: 503, message: "钥匙串暂时不可用，解锁后将自动重试。")
    }
    public func claim(binding: LocalBinding, code: String) async throws -> CollectorClaim {
        let data = try await request(binding, "bindings/claim", body: ["bindingCode": code, "name": binding.name, "deviceName": Host.current().localizedName ?? "Mac", "version": "0.2.1"], authenticated: false)
        struct Secret: Decodable { var token: String }
        let claim = try CollectorJSON.decoder().decode(CollectorClaim.self, from: data)
        let secret = try JSONDecoder().decode(Secret.self, from: data)
        var saved = binding; saved.deviceID = claim.deviceId
        var query = credentialQuery(saved)
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = Data(secret.token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw CollectorError(status: 500, message: "无法安全保存绑定凭据，请重试。") }
        return claim
    }
    public func policy(binding: LocalBinding) async throws -> CollectorPolicy {
        try CollectorJSON.decoder().decode(CollectorPolicy.self, from: await request(binding, "project-scope"))
    }
    public func decide(binding: LocalBinding, version: Int, scopeKey: String, permission: ProjectPermission) async throws -> CollectorPolicy {
        try CollectorJSON.decoder().decode(CollectorPolicy.self, from: await request(binding, "project-scope/decisions", body: ["baseVersion": version, "decisions": [["scopeKey": scopeKey, "decision": permission == .allowed ? "allow" : "deny"]]]))
    }
    public func register(binding: LocalBinding, scopeKey: String, name: String, periodKey: String, sessionCount: Int) async throws -> CollectorPolicy {
        try CollectorJSON.decoder().decode(CollectorPolicy.self, from: await request(binding, "project-scope/candidates", body: ["periodKey": periodKey, "candidates": [["scopeKey": scopeKey, "displayName": name, "sessionCount": sessionCount]]]))
    }
    public func upload(binding: LocalBinding, package: CollectorPackage) async throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        _ = try await request(binding, "uploads", body: ["id": package.id, "periodKey": package.periodKey, "startsAt": formatter.string(from: package.startsAt), "endsAt": formatter.string(from: package.endsAt), "policyVersion": package.policyVersion, "sessionCount": package.sessionCount, "partDigests": package.partDigests])
        let digests = package.partDigests
        for (index, bytes) in package.parts.enumerated() {
            let started = ContinuousClock.now
            do {
                _ = try await request(binding, "uploads/\(package.id)/parts", body: ["partIndex": index, "checksum": digests[index], "data": bytes.base64EncodedString()])
            } catch {
                recordPart(of: package, index: index, bytes: bytes.count, since: started, failure: error)
                throw error
            }
            recordPart(of: package, index: index, bytes: bytes.count, since: started, failure: nil)
        }
        let data = try await request(binding, "uploads/\(package.id)/complete", body: [:])
        struct Receipt: Decodable { var id: String; var status: String; var sessionCount: Int }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.id == package.id, receipt.status == "completed", receipt.sessionCount == package.sessionCount else {
            throw CollectorError(status: 502, message: "系统未确认整批会话接收完成。")
        }
    }
    public func drainLogs() -> [CollectorLog] {
        defer { transportLogs = [] }
        return transportLogs
    }
    private func recordPart(of package: CollectorPackage, index: Int, bytes: Int, since started: ContinuousClock.Instant, failure: (any Error)?) {
        var details = failure.map(CollectorLogDetails.failure) ?? CollectorLogDetails()
        details.partIndex = index; details.partCount = package.parts.count; details.bytes = bytes
        details.durationMs = CollectorLogDetails.milliseconds(since: started)
        transportLogs.append(CollectorLog(stage: "upload", level: failure == nil ? "info" : "error", code: failure == nil ? "UPLOAD_PART_SENT" : "UPLOAD_PART_FAILED",
            uploadId: package.id, sessionCount: package.sessionCount, details: details.sanitized()))
        if transportLogs.count > 500 { transportLogs.removeFirst(transportLogs.count - 500) }
    }
    public func logs(binding: LocalBinding, events: [CollectorLog]) async throws {
        let body = try JSONSerialization.jsonObject(with: CollectorJSON.encoder().encode(["events": events])) as! [String: Any]
        let data = try await request(binding, "logs", body: body)
        struct Receipt: Decodable { var ok: Bool; var accepted: [String] }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.ok, Set(receipt.accepted) == Set(events.map(\.eventId)) else {
            throw CollectorError(status: 502, message: "系统未确认日志接收完成，将重新上传。")
        }
    }
    public func notifications(binding: LocalBinding) async throws -> [AppMessage] {
        struct Index: Decodable { var notifications: [AppMessage] }
        return try CollectorJSON.decoder().decode(Index.self, from: await request(binding, "notifications")).notifications
    }
    public func acknowledgeNotifications(binding: LocalBinding, ids: [String]) async throws {
        let data = try await request(binding, "notifications/delivered", body: ["ids": ids])
        struct Receipt: Decodable { var ok: Bool; var accepted: [String] }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.ok, Set(receipt.accepted) == Set(ids) else { throw CollectorError(status: 502, message: "通知回执尚未确认，将自动重试。") }
    }
    public func reviews(binding: LocalBinding) async throws -> [ReviewBatch] {
        struct Index: Decodable { var reviews: [ReviewBatch.Header] }
        let index = try JSONDecoder().decode(Index.self, from: await request(binding, "v1/partner/work-cards", collectorPath: false))
        var batches: [ReviewBatch] = []
        for header in index.reviews {
            var batch = try JSONDecoder().decode(ReviewBatch.self, from: await request(binding, "v1/reviews/\(header.id)", collectorPath: false))
            batch.review.period_key = header.period_key
            if batch.review.state == "IN_PROGRESS", !batch.items.isEmpty, batch.pendingCards.isEmpty {
                _ = try await request(binding, "v1/reviews/\(header.id)/complete", body: ["baseVersion": batch.review.version], collectorPath: false)
            } else { batches.append(batch) }
        }
        return batches
    }
    public func perform(binding: LocalBinding, action: CardAction, cardID: String, reviewID: String, version: Int) async throws {
        var body: [String: Any] = ["baseVersion": version]
        let command: String
        switch action {
        case .approve: command = "decision"; body["decision"] = "approve"
        case .exclude: command = "decision"; body["decision"] = "exclude"
        case .status(let status): command = "project-status"; body["projectStatus"] = status.rawValue
        case .regenerate(let instruction): command = "regenerate"; body["instruction"] = instruction
        }
        _ = try await request(binding, "v1/reviews/\(reviewID)/items/\(cardID)/\(command)", body: body, collectorPath: false)
    }
    private func request(_ binding: LocalBinding, _ path: String, body: [String: Any]? = nil, authenticated: Bool = true, collectorPath: Bool = true) async throws -> Data {
        guard binding.isValid, let base = URL(string: binding.serviceAddress) else { throw URLError(.badURL) }
        var request = URLRequest(url: base.appending(path: collectorPath ? "v1/collector/" + path : path))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated { request.setValue("Bearer " + (try token(binding)), forHTTPHeaderField: "Authorization") }
        if let body { request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            struct Failure: Decodable { var message: String; var code: String? }
            let failure = try? JSONDecoder().decode(Failure.self, from: data)
            throw CollectorError(status: http.statusCode, message: failure?.message ?? "暂时无法连接系统，请稍后重试。", apiCode: failure?.code)
        }
        return data
    }
}
