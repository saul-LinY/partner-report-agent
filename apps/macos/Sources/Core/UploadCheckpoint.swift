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
    /// Text is redacted before upload, so a stored digest may describe either the raw or the redacted form.
    public func contains(_ message: ConversationMessage) -> Bool {
        guard let stored = messages[message.id] else { return false }
        return stored == Self.digest(message.text) || stored == Self.digest(SecretScrubber.redact(message.text))
    }
    public func pendingMessages(in turns: [ChatTurn]) -> [ConversationMessage] { Self.messages(in: turns).filter { !contains($0) } }
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

    public init(turns: [ChatTurn], checkpoint: UploadCheckpoint?) {
        messages = UploadCheckpoint.messages(in: turns)
        var firstPending: String?
        var hasUploadedMessage = false
        if let checkpoint {
            for message in messages {
                if checkpoint.contains(message) { hasUploadedMessage = true }
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
