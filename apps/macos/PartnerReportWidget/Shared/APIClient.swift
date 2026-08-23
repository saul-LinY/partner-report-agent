import Foundation

struct WidgetAPIClient {
    private let store = SharedStore.shared
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func bind(serverURL: String, bindingCode: String) async throws {
        guard let baseURL = normalizedBaseURL(serverURL) else { throw WidgetClientError.invalidServer }
        let body: [String: Any] = [
            "bindingCode": bindingCode.trimmingCharacters(in: .whitespacesAndNewlines),
            "deviceName": Host.current().localizedName ?? "Mac",
            "pluginVersion": "1.0.0", "clientKind": "widget"
        ]
        let data = try await rawRequest(
            baseURL: baseURL, path: "/v1/plugin-bindings/claim", method: "POST",
            body: try JSONSerialization.data(withJSONObject: body), bearer: nil
        )
        let binding = try decoder.decode(BindingResponse.self, from: data)
        store.serverURL = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        store.credentials = WidgetCredentials(
            accessToken: binding.accessToken, refreshToken: binding.refreshToken,
            accessExpiresAt: binding.expiresAt, pluginInstanceId: binding.pluginInstanceId,
            partnerId: binding.partnerId
        )
        do {
            let connectivity: [String: Any] = [
                "challenge": binding.challenge, "pluginVersion": "1.0.0",
                "clientTime": ISO8601DateFormatter().string(from: Date()), "capabilityVersion": "1.0"
            ]
            _ = try await rawRequest(
                baseURL: baseURL, path: "/v1/plugin-instances/me/connectivity-test", method: "POST",
                body: try JSONSerialization.data(withJSONObject: connectivity), bearer: binding.accessToken
            )
            _ = try await fetchQueue()
        } catch {
            store.disconnect()
            throw error
        }
    }

    func fetchQueue() async throws -> WidgetQueueResponse {
        let data = try await authorizedRequest(path: "/v1/widget/queue", method: "GET", body: nil)
        let queue = try decoder.decode(WidgetQueueResponse.self, from: data)
        store.cachedQueue = queue
        store.lastError = nil
        return queue
    }

    func updatePermissions(_ decisions: [String: String], collection: PermissionCollection) async throws {
        guard let pluginInstanceId = collection.pluginInstanceId, !decisions.isEmpty else {
            throw WidgetClientError.invalidResponse
        }
        let rows = decisions.map { ["scopeKey": $0.key, "decision": $0.value] }
        try await action([
            "kind": "project_scope_batch", "pluginInstanceId": pluginInstanceId,
            "baseVersion": collection.version, "decisions": rows
        ])
    }

    func decide(card: WorkCard, decision: String) async throws {
        try await action([
            "kind": "work_item_decision", "reviewId": card.reviewId,
            "workItemId": card.id, "baseVersion": card.reviewVersion, "decision": decision
        ])
    }

    func regenerate(card: WorkCard, instruction: String) async throws {
        try await action([
            "kind": "work_item_regenerate_custom", "reviewId": card.reviewId,
            "workItemId": card.id, "baseVersion": card.reviewVersion,
            "instruction": instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        ])
    }

    func unbind(bindingCode: String) async throws {
        _ = try await authorizedRequest(
            path: "/v1/widget/unbind", method: "POST",
            body: try encoder.encode([
                "bindingCode": bindingCode.trimmingCharacters(in: .whitespacesAndNewlines)
            ])
        )
    }

    private func action(_ payload: [String: Any]) async throws {
        _ = try await authorizedRequest(
            path: "/v1/widget/actions", method: "POST",
            body: try JSONSerialization.data(withJSONObject: payload)
        )
        _ = try await fetchQueue()
    }

    private func authorizedRequest(path: String, method: String, body: Data?) async throws -> Data {
        guard let base = store.serverURL, let baseURL = normalizedBaseURL(base),
              let credentials = store.credentials else { throw WidgetClientError.notConnected }
        do {
            return try await rawRequest(
                baseURL: baseURL, path: path, method: method, body: body,
                bearer: credentials.accessToken
            )
        } catch let error as HTTPStatusError where error.statusCode == 401 {
            let refreshed = try await refresh(baseURL: baseURL, credentials: credentials)
            return try await rawRequest(
                baseURL: baseURL, path: path, method: method, body: body,
                bearer: refreshed.accessToken
            )
        }
    }

    private func refresh(baseURL: URL, credentials: WidgetCredentials) async throws -> WidgetCredentials {
        let data = try await rawRequest(
            baseURL: baseURL, path: "/v1/plugin-bindings/refresh", method: "POST",
            body: try encoder.encode(["refreshToken": credentials.refreshToken]), bearer: nil
        )
        let response = try decoder.decode(RefreshResponse.self, from: data)
        let updated = WidgetCredentials(
            accessToken: response.accessToken, refreshToken: response.refreshToken,
            accessExpiresAt: response.expiresAt, pluginInstanceId: credentials.pluginInstanceId,
            partnerId: credentials.partnerId
        )
        store.credentials = updated
        return updated
    }

    private func normalizedBaseURL(_ value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil else { return nil }
        return url
    }

    private func rawRequest(baseURL: URL, path: String, method: String, body: Data?, bearer: String?) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw WidgetClientError.invalidServer }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WidgetClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? decoder.decode(ServerErrorBody.self, from: data)
            throw HTTPStatusError(statusCode: http.statusCode, message: body?.message ?? "中台请求失败（\(http.statusCode)）。")
        }
        return data
    }
}

private struct HTTPStatusError: LocalizedError {
    let statusCode: Int
    let message: String
    var errorDescription: String? { message }
}
