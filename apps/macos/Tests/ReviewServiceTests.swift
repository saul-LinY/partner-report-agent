import XCTest
@testable import WeeklyReportCore

private final class ReviewHTTPState: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [(Int, Data)] = []
    private var requests: [URLRequest] = []
    func reset(_ responses: [(Int, Data)]) { lock.lock(); defer { lock.unlock() }; self.responses = responses; requests = [] }
    func take(_ request: URLRequest) -> (Int, Data) {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
        return responses.isEmpty ? (500, Data()) : responses.removeFirst()
    }
    func recorded() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}
private final class ReviewHTTPProtocol: URLProtocol, @unchecked Sendable {
    static let state = ReviewHTTPState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data) = Self.state.take(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ReviewServiceTests: XCTestCase, @unchecked Sendable {
    private func service() -> HTTPReviewService {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReviewHTTPProtocol.self]
        return HTTPReviewService(baseURL: URL(string: "https://review.example.test")!, configuration: configuration)
    }
    private func json(_ text: String) -> Data { Data(text.utf8) }
    private func body(_ request: URLRequest) throws -> [String: Any] {
        var bytes = request.httpBody ?? Data()
        if bytes.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                bytes.append(buffer, count: count)
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }
    func testLoadsEveryPendingReviewNotOnlyLatestPeriod() async throws {
        var second = DemoRepository.reviewBatches[0]
        second.review.id = "older-review"
        let headers = [DemoRepository.reviewBatches[0].review, second.review]
        struct Index: Encodable { var reviews: [ReviewBatch.Header] }
        ReviewHTTPProtocol.state.reset([
            (200, try JSONEncoder().encode(Index(reviews: headers))),
            (200, try JSONEncoder().encode(DemoRepository.reviewBatches[0])),
            (200, try JSONEncoder().encode(second))
        ])
        let batches = try await service().loadReviews()
        XCTAssertEqual(batches.map(\.id), ["demo-review", "older-review"])
        XCTAssertEqual(ReviewHTTPProtocol.state.recorded().map { $0.url!.path }, ["/v1/partner/work-cards", "/v1/reviews/demo-review", "/v1/reviews/older-review"])
    }
    func testDecisionCarriesBaseVersionAndUsesNativeWebEndpoint() async throws {
        ReviewHTTPProtocol.state.reset([(200, json("{}"))])
        try await service().perform(.approve, cardID: "card", reviewID: "review", version: 7)
        let request = try XCTUnwrap(ReviewHTTPProtocol.state.recorded().first)
        XCTAssertEqual(request.url?.path, "/v1/reviews/review/items/card/decision")
        XCTAssertEqual(request.httpMethod, "POST")
        let values = try body(request)
        XCTAssertEqual(values["baseVersion"] as? Int, 7)
        XCTAssertEqual(values["decision"] as? String, "approve")
    }
    func testStatusAndRegenerationUseSameVersionedContract() async throws {
        ReviewHTTPProtocol.state.reset([(200, json("{}")), (200, json("{}"))])
        let service = service()
        try await service.perform(.status(.paused), cardID: "card", reviewID: "review", version: 2)
        try await service.perform(.regenerate("Update summary"), cardID: "card", reviewID: "review", version: 3)
        let requests = ReviewHTTPProtocol.state.recorded()
        XCTAssertEqual(requests[0].url?.lastPathComponent, "project-status")
        XCTAssertEqual(try body(requests[0])["projectStatus"] as? String, "paused")
        XCTAssertEqual(try body(requests[1])["instruction"] as? String, "Update summary")
        XCTAssertEqual(try body(requests[1])["baseVersion"] as? Int, 3)
    }
    func testConflictIsNotRetriedOrReportedAsSuccess() async throws {
        ReviewHTTPProtocol.state.reset([(409, json(#"{"message":"内容已更新"}"#))])
        do {
            try await service().perform(.approve, cardID: "card", reviewID: "review", version: 1)
            XCTFail("Expected conflict")
        } catch let error as ReviewServiceError {
            XCTAssertEqual(error.status, 409)
            XCTAssertEqual(error.message, "内容已更新")
        }
        XCTAssertEqual(ReviewHTTPProtocol.state.recorded().count, 1)
    }
    func testInterruptedCompletionIsResumedWithoutInventingPendingCards() async throws {
        var batch = DemoRepository.reviewBatches[0]
        for index in batch.items.indices { batch.items[index].review_status = "approved" }
        struct Index: Encodable { var reviews: [ReviewBatch.Header] }
        ReviewHTTPProtocol.state.reset([
            (200, try JSONEncoder().encode(Index(reviews: [batch.review]))),
            (200, try JSONEncoder().encode(batch)),
            (200, json("{}"))
        ])
        let batches = try await service().loadReviews()
        XCTAssertTrue(batches.isEmpty)
        XCTAssertEqual(ReviewHTTPProtocol.state.recorded().last?.url?.lastPathComponent, "complete")
    }
}
