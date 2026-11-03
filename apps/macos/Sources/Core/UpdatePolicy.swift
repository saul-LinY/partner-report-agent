import Foundation
import Combine

public struct PendingAppUpdate: Codable, Equatable, Sendable {
    public let version: String
    public let detectedAt: Date
    public var automaticInstallAt: Date { detectedAt.addingTimeInterval(24 * 60 * 60) }
}

@MainActor
public final class UpdatePolicy: ObservableObject {
    @Published public private(set) var available: PendingAppUpdate?
    @Published public private(set) var isInstalling = false
    public private(set) var persistenceError: String?
    private let stateURL: URL?
    private var remembered: PendingAppUpdate?
    private var installAction: (() -> Void)?

    public init(stateURL: URL? = nil, installedVersion: String) {
        self.stateURL = stateURL
        if let stateURL, let data = try? Data(contentsOf: stateURL),
           let saved = try? JSONDecoder().decode(PendingAppUpdate.self, from: data),
           saved.version.compare(installedVersion, options: .numeric) == .orderedDescending {
            remembered = saved
        }
        // A saved deadline is not proof that an update is still available.
        available = nil
    }

    public func offer(version: String, now: Date = Date(), install: @escaping () -> Void) {
        guard !isInstalling else { return }
        let notice = PendingAppUpdate(version: version, detectedAt: remembered?.detectedAt ?? now)
        remembered = notice
        available = notice
        installAction = install
        if let stateURL {
            do {
                try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try JSONEncoder().encode(notice).write(to: stateURL, options: .atomic)
                persistenceError = nil
            } catch { persistenceError = error.localizedDescription }
        }
        installIfDue(now: now)
    }

    @discardableResult public func requestInstall() -> Bool {
        guard !isInstalling, let installAction else { return false }
        self.installAction = nil
        isInstalling = true
        installAction()
        return true
    }

    public func installIfDue(now: Date = Date()) {
        if let available, now >= available.automaticInstallAt { requestInstall() }
    }

    public func finishAttempt() {
        installAction = nil
        isInstalling = false
    }

    public func clear() {
        available = nil
        remembered = nil
        finishAttempt()
        if let stateURL, FileManager.default.fileExists(atPath: stateURL.path) {
            do { try FileManager.default.removeItem(at: stateURL) }
            catch { persistenceError = error.localizedDescription }
        }
    }
}
