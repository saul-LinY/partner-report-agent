import Foundation

public enum AppPage: String, CaseIterable, Identifiable, Sendable {
    // Declaration order is the sidebar order and the ⌘1…⌘5 shortcuts.
    case approvals, sessions, uploads, settings, privacy
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .sessions: "项目会话"
        case .approvals: "待审批项"
        case .uploads: "上传记录"
        case .privacy: "隐私说明"
        case .settings: "系统设置"
        }
    }
    public var symbol: String {
        switch self {
        case .sessions: "bubble.left.and.bubble.right"
        case .approvals: "checklist"
        case .uploads: "icloud.and.arrow.up"
        case .privacy: "lock.shield"
        case .settings: "slider.horizontal.3"
        }
    }
}

/// What will happen to a session at the next upload.
public enum SessionUploadState: Sendable {
    case uploaded, pending
    /// The member chose not to upload this session.
    case excluded
}

public enum SessionUploadFilter: CaseIterable, Sendable {
    case all, pending, excluded
    func includes(_ state: SessionUploadState) -> Bool {
        switch self {
        case .all: true
        case .pending: state == .pending
        case .excluded: state == .excluded
        }
    }
}

public enum Agent: String, Codable, CaseIterable, Identifiable, Sendable {
    case codex, claude, opencode, pi, hermes, omp, grokbuild, agy
    public var id: String { rawValue }
    public var name: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude Code"
        case .opencode: "OpenCode"
        case .pi: "Pi"
        case .omp: "Oh My Pi"
        case .hermes: "Hermes"
        case .grokbuild: "Grok Build"
        case .agy: "Antigravity"
        }
    }
    public var defaultPath: String {
        switch self {
        case .codex: "~/.codex/sessions"
        case .claude: "~/.claude/projects"
        case .opencode: "~/.local/share/opencode"
        case .pi: "~/.pi/agent/sessions"
        case .omp: "~/.omp/agent/sessions"
        case .hermes: "~/.hermes"
        case .grokbuild: "~/.grok/sessions"
        case .agy: "~/.gemini/antigravity-cli/brain"
        }
    }
    /// A detected directory is not evidence that the complete reading flow works.
    public var readingLimitation: String? {
        nil
    }
}

public enum ProjectPermission: String, Codable, Sendable {
    case allowed, pending, denied
    public var label: String {
        switch self {
        case .allowed: "已允许"
        case .pending: "待确认"
        case .denied: "已拒绝"
        }
    }
}

public struct Project: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var folder: String
    public var permission: ProjectPermission
    public var isDemo: Bool
    public var discoveredAt: Date? = nil
    public var scopeKey: String? = nil
    public init(id: String, name: String, folder: String, permission: ProjectPermission, isDemo: Bool = true) {
        self.id = id; self.name = name; self.folder = folder; self.permission = permission; self.isDemo = isDemo
    }
}

public struct ChatTurn: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var prompt: String
    public var answer: String?
    public var questionTime: String
    public var answerTime: String?
    public var model: String?
    public init(id: String, prompt: String, answer: String?, questionTime: String, answerTime: String? = nil, model: String? = nil) {
        self.id = id; self.prompt = prompt; self.answer = answer; self.questionTime = questionTime; self.answerTime = answerTime; self.model = model
    }
}

public struct AgentSession: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var projectID: String
    public var agent: Agent
    public var title: String
    public var updatedLabel: String
    public var uploaded: Bool
    public var turns: [ChatTurn]
    public var hasModelReply: Bool {
        turns.contains { !($0.answer ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
    public init(id: String, projectID: String, agent: Agent, title: String, updatedLabel: String, uploaded: Bool, turns: [ChatTurn]) {
        self.id = id; self.projectID = projectID; self.agent = agent; self.title = title; self.updatedLabel = updatedLabel; self.uploaded = uploaded; self.turns = turns
    }
}

public enum UploadStatus: String, Codable, Sendable {
    case complete, backfilled, failed, queued
    public var label: String {
        switch self {
        case .complete: "成功"
        case .backfilled: "已补传"
        case .failed: "失败"
        case .queued: "待上传"
        }
    }
}

public struct UploadRecord: Identifiable, Codable, Equatable, Sendable {
    public var id: String
    public var time: String
    public var kind: String
    public var projectsAndAgents: String
    public var content: String
    public var status: UploadStatus
    public var details: [String]
    public var createdAt: Date? = nil
    public var projects: [UploadProjectSummary]? = nil
    public var errorMessage: String? = nil
    public var isSample: Bool? = nil
    public init(id: String = UUID().uuidString, time: String, kind: String, projectsAndAgents: String, content: String, status: UploadStatus, details: [String], createdAt: Date? = nil, projects: [UploadProjectSummary]? = nil, errorMessage: String? = nil, isSample: Bool = false) {
        self.id = id; self.time = time; self.kind = kind; self.projectsAndAgents = projectsAndAgents; self.content = content; self.status = status; self.details = details
        self.createdAt = createdAt; self.projects = projects; self.errorMessage = errorMessage; self.isSample = isSample
    }
    public var sessionCount: Int { projects?.reduce(0) { $0 + $1.sessionCount } ?? 0 }
    public var messageCount: Int { projects?.reduce(0) { $0 + $1.messageCount } ?? 0 }
}

public struct UploadProjectSummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var sessionCount: Int
    public var messageCount: Int
    public init(id: String, name: String, sessionCount: Int, messageCount: Int) {
        self.id = id; self.name = name; self.sessionCount = sessionCount; self.messageCount = messageCount
    }
}

public enum SettingsTab: String, CaseIterable, Identifiable, Sendable {
    case account, sources, upload
    public var id: String { rawValue }
    public var title: String {
        switch self { case .account: "账户连接"; case .sources: "采集来源"; case .upload: "自动上传" }
    }
}

public struct LocalBinding: Codable, Equatable, Sendable {
    public var serviceAddress = ""
    public var name = ""
    public var deviceID: String?
    public var savedAt: Date?
    public init(serviceAddress: String = "", name: String = "") {
        self.serviceAddress = serviceAddress
        self.name = name
    }
    private enum CodingKeys: String, CodingKey { case serviceAddress, name, deviceID, savedAt }
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        serviceAddress = try values.decodeIfPresent(String.self, forKey: .serviceAddress) ?? ""
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        deviceID = try values.decodeIfPresent(String.self, forKey: .deviceID)
        savedAt = try values.decodeIfPresent(Date.self, forKey: .savedAt)
    }
    public var isBound: Bool { isValid && deviceID != nil && savedAt != nil }
    public var isValid: Bool {
        guard let url = URL(string: serviceAddress.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return false }
        return !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            (url.scheme == "https" || ["localhost", "127.0.0.1", "::1"].contains(url.host ?? ""))
    }
    public func matchesSavedConfiguration(_ candidate: LocalBinding) -> Bool {
        savedAt != nil && isValid &&
        serviceAddress.trimmingCharacters(in: .whitespacesAndNewlines) == candidate.serviceAddress.trimmingCharacters(in: .whitespacesAndNewlines) &&
        name.trimmingCharacters(in: .whitespacesAndNewlines) == candidate.name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public enum UploadFrequency: String, Codable, CaseIterable, Sendable {
    case daily, weekly
    public var label: String {
        switch self {
        case .daily: "每天一次"
        case .weekly: "每周一次"
        }
    }
    public init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .daily
    }
}

public struct AppPreferences: Codable, Equatable, Sendable {
    public var frequency: UploadFrequency = .daily
    public var uploadHour = 16
    public var uploadMinute = 0
    public var uploadWeekday: Int? = 6
    public var autoUpload = true
    public var launchAtLogin = true
    public var keepInMenuBar = true
    public var automaticUpdates = true
    public var agentPaths: [String: String] = [:]
    public init() {}
    public var scheduleLabel: String {
        guard autoUpload else { return "自动上传已暂停" }
        if frequency == .daily { return String(format: "每天 %02d:%02d 上传", uploadHour, uploadMinute) }
        let days = [1: "周日", 2: "周一", 3: "周二", 4: "周三", 5: "周四", 6: "周五", 7: "周六"]
        return String(format: "每%@ %02d:%02d 上传", days[uploadWeekday ?? 6] ?? "周五", uploadHour, uploadMinute)
    }
}

/// Future Rust-backed sources implement this boundary. The preview never scans user folders.
public protocol SessionRepository: Sendable {
    func sessions() -> [AgentSession]
    func projects() -> [Project]
}

public enum ProjectRegistrationError: Error, LocalizedError, Equatable {
    case emptyName, emptyFolder, duplicateName, duplicateFolder
    public var errorDescription: String? {
        switch self {
        case .emptyName: "请填写项目名称。"
        case .emptyFolder: "请选择项目文件夹。"
        case .duplicateName: "此项目名称已经登记。"
        case .duplicateFolder: "此文件夹已经登记。"
        }
    }
}
