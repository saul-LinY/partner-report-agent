import Foundation
import CryptoKit

/// A receipt records only message digests, so new answers and edits remain pending.
public struct UploadCheckpoint: Codable, Equatable, Sendable {
    public var uploadedAt: Date
    public var messages: [String: String]
    public init(turns: [ChatTurn], uploadedAt: Date = .now) {
        self.uploadedAt = uploadedAt
        messages = Dictionary(uniqueKeysWithValues: Self.messages(in: turns).map { ($0.id, Self.digest($0.text)) })
    }
    /// Digests reported by the system. They cover the redacted text that actually left this Mac.
    public init(messages: [String: String], uploadedAt: Date) {
        self.uploadedAt = uploadedAt; self.messages = messages
    }
    /// What was uploaded is the redacted text, so a message is up to date only when its digest equals that of
    /// the text as it would be uploaded now. A newly marked term or rule therefore makes older uploads pending.
    public func contains(_ message: ConversationMessage, hiding terms: [String] = []) -> Bool {
        guard let stored = messages[message.id] else { return false }
        return stored == Self.uploadedDigest(of: message.text, hiding: terms)
    }
    public func pendingMessages(in turns: [ChatTurn], hiding terms: [String] = []) -> [ConversationMessage] {
        Self.messages(in: turns).filter { !contains($0, hiding: terms) }
    }
    /// Redacting is the costly part and the same text is compared on every refresh, so remember the result.
    nonisolated(unsafe) private static let digestCache: NSCache<NSString, NSString> = { let cache = NSCache<NSString, NSString>(); cache.countLimit = 20_000; return cache }()
    private static func uploadedDigest(of text: String, hiding terms: [String]) -> String {
        let key = (digest(terms.joined(separator: "\u{1}")) + digest(text)) as NSString
        if let cached = digestCache.object(forKey: key) { return cached as String }
        let value = digest(SecretScrubber.redact(text, hiding: terms))
        digestCache.setObject(value as NSString, forKey: key)
        return value
    }
    public static func messages(in turns: [ChatTurn]) -> [ConversationMessage] {
        turns.flatMap { turn in
            var result = [ConversationMessage(id: turn.id + ":prompt", text: turn.prompt, isAnswer: false, time: turn.questionTime, model: nil)]
            if let answer = turn.answer { result.append(.init(id: turn.id + ":answer", text: answer, isAnswer: true, time: turn.answerTime, model: turn.model)) }
            return result
        }
    }
    private static func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
}

public struct ConversationMessage: Identifiable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var isAnswer: Bool
    public var time: String?
    public var model: String?
}

public struct ConversationTimeline: Equatable, Sendable {
    public let messages: [ConversationMessage]
    public let uploadBoundaryID: String?

    public init(turns: [ChatTurn], checkpoint: UploadCheckpoint?, hiding terms: [String] = []) {
        messages = UploadCheckpoint.messages(in: turns)
        var firstPending: String?
        var hasUploadedMessage = false
        if let checkpoint {
            for message in messages {
                if checkpoint.contains(message, hiding: terms) { hasUploadedMessage = true }
                else if firstPending == nil { firstPending = message.id }
            }
        }
        uploadBoundaryID = hasUploadedMessage ? firstPending : nil
    }
}

public enum SessionSourcePolicy {
    public static func isArchived(_ path: String) -> Bool {
        let components = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().pathComponents
        return components.contains { ["archived_sessions", "archived", "archives", ".archive"].contains($0.lowercased()) }
    }
}
