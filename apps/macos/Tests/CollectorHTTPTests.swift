import XCTest
import Security
@testable import WeeklyReportCore

private final class CollectorHTTPState: @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [(Int, Data)] = []
    private var requests: [URLRequest] = []
    func reset(_ replies: [(Int, String)]) { lock.lock(); defer { lock.unlock() }; self.replies = replies.map { ($0.0, Data($0.1.utf8)) }; requests = [] }
    func take(_ request: URLRequest) -> (Int, Data) { lock.lock(); defer { lock.unlock() }; requests.append(request); return replies.isEmpty ? (500, Data()) : replies.removeFirst() }
    func recorded() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}
private final class CollectorHTTPProtocol: URLProtocol, @unchecked Sendable {
    static let state = CollectorHTTPState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data) = Self.state.take(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class CollectorHTTPTests: XCTestCase, @unchecked Sendable {
    func testRestartReusesPersistedCredentialWithoutClaimingAgain() async throws {
        let device = UUID().uuidString
        var binding = LocalBinding(serviceAddress: "https://collector-\(UUID()).example.test", name: "Member")
        CollectorHTTPProtocol.state.reset([(200, claimReply(device))])
        binding.deviceID = try await service().claim(binding: binding, code: "TEST-CODE").deviceId
        binding.savedAt = .now
        defer { removeCredential(binding) }
        let restored = try JSONDecoder().decode(LocalBinding.self, from: JSONEncoder().encode(binding))
        CollectorHTTPProtocol.state.reset([(200, #"{"version":7,"entries":[]}"#)])
        _ = try await service().policy(binding: restored)
        let requests = CollectorHTTPProtocol.state.recorded()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.url?.path, "/v1/collector/project-scope")
        XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer test-token-only")
        XCTAssertTrue(restored.isBound)
    }
    private func service() -> HTTPCollectorService {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [CollectorHTTPProtocol.self]
        return HTTPCollectorService(configuration: configuration)
    }
    private func claimReply(_ device: String) -> String {
        #"{"token":"test-token-only","deviceId":""# + device + #"","name":"Member","policy":{"version":7,"entries":[],"currentPeriod":{"periodKey":"test","startsAt":"2026-10-31T00:00:00.123Z","endsAt":"2026-11-01T00:00:00.456Z"}}}"#
    }
    private func removeCredential(_ binding: LocalBinding) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.weeklyreport.collector", kSecAttrAccount as String: binding.serviceAddress + ":" + (binding.deviceID ?? "")] as CFDictionary)
    }
    func testNativeTransportUsesIndependentBearerTokenAndRequiresWholeBatchReceipt() async throws {
        let service = service(), device = UUID().uuidString
        var binding = LocalBinding(serviceAddress: "https://collector-\(UUID()).example.test", name: "Member")
        CollectorHTTPProtocol.state.reset([(200, claimReply(device))])
        let claim = try await service.claim(binding: binding, code: "TEST-CODE")
        binding.deviceID = claim.deviceId
        defer { removeCredential(binding) }
        XCTAssertNil(CollectorHTTPProtocol.state.recorded()[0].value(forHTTPHeaderField: "Authorization"))
        let period = try XCTUnwrap(claim.policy.currentPeriod)
        let package = try CollectorPackage(period: period, start: period.startsAt, end: period.endsAt, version: 7, sessions: [])
        CollectorHTTPProtocol.state.reset([(200, "{}"), (200, "{}"), (200, #"{"id":"wrong","status":"completed","sessionCount":0}"#)])
        do { try await service.upload(binding: binding, package: package); XCTFail("Missing receipt must not be accepted") }
        catch let error as CollectorError { XCTAssertEqual(error.status, 502) }
        let requests = CollectorHTTPProtocol.state.recorded()
        XCTAssertEqual(requests.map { $0.url!.path }, ["/v1/collector/uploads", "/v1/collector/uploads/\(package.id)/parts", "/v1/collector/uploads/\(package.id)/complete"])
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer test-token-only" })
        CollectorHTTPProtocol.state.reset([(200, "{}"), (200, "{}"), (200, "{\"id\":\"\(package.id)\",\"status\":\"completed\",\"sessionCount\":0}")])
        try await service.upload(binding: binding, package: package)
    }
    func testNativeLogTransportDoesNotAcceptPartialAcknowledgements() async throws {
        let service = service(), device = UUID().uuidString
        var binding = LocalBinding(serviceAddress: "https://collector-\(UUID()).example.test", name: "Member")
        CollectorHTTPProtocol.state.reset([(200, claimReply(device))])
        let claim = try await service.claim(binding: binding, code: "TEST-CODE")
        binding.deviceID = claim.deviceId
        defer { removeCredential(binding) }
        let event = CollectorLog(stage: "heartbeat", level: "info", code: "ALIVE", sessionCount: 0)
        CollectorHTTPProtocol.state.reset([(200, #"{"ok":true,"accepted":[]}"#)])
        do { try await service.logs(binding: binding, events: [event]); XCTFail("Partial log receipt must not be accepted") }
        catch let error as CollectorError { XCTAssertEqual(error.status, 502) }
        CollectorHTTPProtocol.state.reset([(200, "{\"ok\":true,\"accepted\":[\"\(event.eventId)\"]}")])
        try await service.logs(binding: binding, events: [event])
    }
    func testNativePipelineUsesBoundIdentityAndDecodesProcessingProgress() async throws {
        let service = service(), device = UUID().uuidString
        var binding = LocalBinding(serviceAddress: "https://collector-\(UUID()).example.test", name: "Member")
        CollectorHTTPProtocol.state.reset([(200, claimReply(device))])
        binding.deviceID = try await service.claim(binding: binding, code: "TEST-CODE").deviceId
        defer { removeCredential(binding) }
        CollectorHTTPProtocol.state.reset([(200, #"{"uploads":[{"id":"batch","stage":"review","label":"待审核","analysis_completed":2,"analysis_total":2,"pending_cards":1,"approved_cards":0,"error_code":null,"card_error_code":null}]}"#)])
        let pipeline = try await service.pipeline(binding: binding)
        XCTAssertEqual(pipeline.first?.pending_cards, 1)
        XCTAssertEqual(pipeline.first?.stage, "review")
        let request = try XCTUnwrap(CollectorHTTPProtocol.state.recorded().first)
        XCTAssertEqual(request.url?.path, "/v1/collector/pipeline")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token-only")
    }

    func testPersonalDataSendsMonthAsQueryNotPathAndDecodesTheReply() async throws {
        let service = service(), device = UUID().uuidString
        var binding = LocalBinding(serviceAddress: "https://collector-\(UUID()).example.test", name: "Member")
        CollectorHTTPProtocol.state.reset([(200, claimReply(device))])
        binding.deviceID = try await service.claim(binding: binding, code: "TEST-CODE").deviceId
        defer { removeCredential(binding) }
        let reply = #"{"today":"2026-11-05","timezone":"Asia/Shanghai","member":{"id":"m","name":"林宇"},"headline":{"projectCount":0,"attention":0,"activeDays28":0,"lastActiveDate":null},"projects":[],"calendar":{"month":"2026-10","from":"2026-10-01","to":"2026-10-31"},"activity":{"timezone":"Asia/Shanghai","from":"2026-08-07","to":"2026-11-05","days":90,"events":[]}}"#
        CollectorHTTPProtocol.state.reset([(200, reply), (200, reply)])
        let october = try await service.personalData(binding: binding, month: "2026-10")
        _ = try await service.personalData(binding: binding, month: nil)
        XCTAssertEqual(october.member.name, "林宇")
        let requests = CollectorHTTPProtocol.state.recorded()
        XCTAssertEqual(requests[0].url?.path, "/v1/collector/personal-data")
        XCTAssertEqual(requests[0].url?.query, "month=2026-10")
        XCTAssertNil(requests[1].url?.query)
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer test-token-only")
    }
}
