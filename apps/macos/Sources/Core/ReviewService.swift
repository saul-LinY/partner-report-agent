import Foundation

private final class ReviewRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // API endpoints do not redirect; never forward login bodies to a different origin.
        completionHandler(nil)
    }
}

/// Uses the same authenticated, version-checked commands as the web app.
public actor HTTPReviewService: ReviewServing {
    private let baseURL: URL
    private let session: URLSession
    public init(baseURL: URL, configuration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        configuration.timeoutIntervalForRequest = 20
        configuration.urlCache = nil
        self.session = URLSession(configuration: configuration, delegate: ReviewRedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func login(email: String, password: String) async throws {
        _ = try await request("v1/auth/login", body: ["email": email, "password": password])
    }
    public func logout() async throws {
        defer { session.configuration.httpCookieStorage?.removeCookies(since: .distantPast) }
        _ = try await request("v1/auth/logout", body: [:])
    }
    public func loadReviews() async throws -> [ReviewBatch] {
        struct Index: Decodable { var reviews: [ReviewBatch.Header] }
        let index = try JSONDecoder().decode(Index.self, from: await request("v1/partner/work-cards"))
        var batches: [ReviewBatch] = []
        for header in index.reviews {
            let data = try await request("v1/reviews/\(header.id)")
            var batch = try JSONDecoder().decode(ReviewBatch.self, from: data)
            batch.review.period_key = header.period_key
            // Resume a review whose final decision succeeded before a prior client disconnected.
            if batch.review.state == "IN_PROGRESS", !batch.items.isEmpty, batch.pendingCards.isEmpty {
                _ = try await request("v1/reviews/\(header.id)/complete", body: ["baseVersion": batch.review.version])
                continue
            }
            batches.append(batch)
        }
        return batches
    }
    public func perform(_ action: CardAction, cardID: String, reviewID: String, version: Int) async throws {
        var body: [String: Any] = ["baseVersion": version]
        let command: String
        switch action {
        case .approve: command = "decision"; body["decision"] = "approve"
        case .exclude: command = "decision"; body["decision"] = "exclude"
        case .status(let status): command = "project-status"; body["projectStatus"] = status.rawValue
        case .regenerate(let instruction): command = "regenerate"; body["instruction"] = instruction
        }
        _ = try await request("v1/reviews/\(reviewID)/items/\(cardID)/\(command)", body: body)
    }
    private func request(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            struct Failure: Decodable { var message: String }
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.message ?? "暂时无法连接，请重试。"
            throw ReviewServiceError(status: http.statusCode, message: message)
        }
        return data
    }
}
