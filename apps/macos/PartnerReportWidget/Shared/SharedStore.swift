import Foundation

final class SharedStore {
    static let shared = SharedStore()
    static let appGroup = "9RN69TVL38.partnerreport.shared"
    static let pluginDataDirectoryName = "PartnerReportPluginData"
    static let pluginUnboundMarkerName = "PartnerReportPluginUnbound"

    private enum Key {
        static let serverURL = "server-url.json"
        static let credentials = "credentials.json"
        static let queue = "queue.json"
        static let lastError = "last-error.json"
    }

    private let stateDirectory: URL?
    private let groupContainer: URL?
    private let lock = NSLock()

    private init() {
        groupContainer = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup)
        stateDirectory = groupContainer?.appendingPathComponent("PartnerReportState", isDirectory: true)
        if let stateDirectory {
            try? FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true)
        }
    }

    var serverURL: String? {
        get { read(String.self, from: Key.serverURL) }
        set { write(newValue, to: Key.serverURL) }
    }
    var credentials: WidgetCredentials? {
        get { read(WidgetCredentials.self, from: Key.credentials) }
        set { write(newValue, to: Key.credentials) }
    }
    var cachedQueue: WidgetQueueResponse {
        get { read(WidgetQueueResponse.self, from: Key.queue) ?? .empty }
        set { write(newValue, to: Key.queue) }
    }
    var lastError: String? {
        get { read(String.self, from: Key.lastError) }
        set { write(newValue, to: Key.lastError) }
    }

    func disconnect() {
        credentials = nil
        cachedQueue = .empty
        lastError = nil
    }

    func clearAllLocalData() throws {
        guard let groupContainer else { throw WidgetClientError.localDataUnavailable }
        let marker = groupContainer.appendingPathComponent(Self.pluginUnboundMarkerName)
        try Data("unbound\n".utf8).write(to: marker, options: .atomic)

        let pluginData = groupContainer.appendingPathComponent(Self.pluginDataDirectoryName, isDirectory: true)
        if FileManager.default.fileExists(atPath: pluginData.path) {
            try FileManager.default.removeItem(at: pluginData)
        }
        serverURL = nil
        credentials = nil
        cachedQueue = .empty
        lastError = nil
    }

    private func read<Value: Decodable>(_ type: Value.Type, from fileName: String) -> Value? {
        guard let stateDirectory else { return nil }
        return lock.withLock {
            guard let data = try? Data(contentsOf: stateDirectory.appendingPathComponent(fileName)) else { return nil }
            return try? JSONDecoder().decode(type, from: data)
        }
    }

    private func write<Value: Encodable>(_ value: Value?, to fileName: String) {
        guard let stateDirectory else { return }
        lock.withLock {
            let url = stateDirectory.appendingPathComponent(fileName)
            guard let value else { try? FileManager.default.removeItem(at: url); return }
            guard let data = try? JSONEncoder().encode(value) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }
}
