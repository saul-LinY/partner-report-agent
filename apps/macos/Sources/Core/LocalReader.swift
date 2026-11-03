import Foundation

public struct ReadSession: Sendable {
    public var turns: [ChatTurn]
    public var warnings: [String]
}

public protocol LocalSessionReading: Sendable {
    func read(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession
}

/// Runs the extracted Rust reader bundled with the app. No shell and no network.
public actor LocalReader: LocalSessionReading {
    private let executable: URL
    private let workingDirectory: URL
    public init(executable: URL, workingDirectory: URL) {
        self.executable = executable; self.workingDirectory = workingDirectory
    }
    private struct Manifest: Encodable {
        var authorized_root: String
        var jobs: [Job]
        struct Job: Encodable { var provider: String; var session_id: String; var source: String; var project: String; var allowed = true }
    }
    private struct ResultRow: Decodable {
        var status: String
        var error: String?
        var turns: [Turn]?
        struct Turn: Decodable {
            var turn_id: String
            var prompt_parts: [String]
            var final_answer_parts: [String]
            var state: String
            var model: String?
            var question_ts: Double?
            var answer_ts: Double?
        }
    }
    public func read(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession {
        guard !sources.contains(where: { SessionSourcePolicy.isArchived($0.source) }) else { throw readerError("归档内容不读取、不上传。") }
        if let issue = sources.compactMap(\.readabilityIssue).first { throw readerError(issue) }
        // Pi/OMP validate a flat directory. Each source directory gets its own process context.
        let batches = Dictionary(grouping: sources) { source in
            [.pi, .omp].contains(source.agent) ? "\(source.agent.id):\(URL(fileURLWithPath: source.source).deletingLastPathComponent().path)" : "native"
        }
        var turns: [ChatTurn] = [], warnings: [String] = []
        let keys = batches.keys.sorted { left, right in
            (batches[left]?.map(\.modifiedAt).max() ?? .distantPast) < (batches[right]?.map(\.modifiedAt).max() ?? .distantPast)
        }
        for key in keys {
            let result = try await readBatch(sources: batches[key]!, authorizedRoot: authorizedRoot)
            turns += result.turns; warnings += result.warnings
        }
        var order: [String] = [], byID: [String: ChatTurn] = [:]
        for turn in turns {
            if byID[turn.id] == nil { order.append(turn.id) }
            byID[turn.id] = turn
        }
        return ReadSession(turns: order.compactMap { byID[$0] }, warnings: warnings)
    }
    private func readBatch(sources: [LocalSessionSource], authorizedRoot: String) async throws -> ReadSession {
        try Task.checkCancellation()
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw readerError("未找到本机会话读取组件，请重新构建应用。")
        }
        let fm = FileManager.default
        let folder = workingDirectory.appending(path: UUID().uuidString)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: folder) }
        let input = folder.appending(path: "manifest.json"), output = folder.appending(path: "results.json")
        let jobs = sources.map { Manifest.Job(provider: $0.agent.id, session_id: $0.nativeID, source: $0.source, project: authorizedRoot) }
        try JSONEncoder().encode(Manifest(authorized_root: authorizedRoot, jobs: jobs)).write(to: input, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: input.path)
        let process = Process()
        process.executableURL = executable
        process.arguments = [input.path, output.path]
        if let source = sources.first, [.pi, .omp].contains(source.agent) {
            var environment = ProcessInfo.processInfo.environment
            environment["PI_CODING_AGENT_SESSION_DIR"] = URL(fileURLWithPath: source.source).deletingLastPathComponent().path
            process.environment = environment
        }
        process.standardOutput = FileHandle.nullDevice
        let errors = Pipe(); process.standardError = errors
        try process.run()
        process.waitUntilExit()
        try Task.checkCancellation()
        guard process.terminationStatus == 0 else { throw readerError("本机会话解析失败，请刷新重试。") }
        let results = try JSONDecoder().decode([ResultRow].self, from: Data(contentsOf: output))
        var byID: [String: ChatTurn] = [:], order: [String] = [], warnings: [String] = []
        for result in results {
            guard result.status == "parsed" else {
                let error = result.error ?? "会话读取受限：\(result.status)"
                warnings.append(result.status == "cross_project_metadata_blocked" ? "此会话包含其他项目的目录，已停止读取。" : error.contains("authorized metadata discovery adapter not yet validated") ? "此工具的正文读取尚未接通。" : error)
                continue
            }
            for turn in result.turns ?? [] {
                if byID[turn.turn_id] == nil { order.append(turn.turn_id) }
                let answer = turn.state == "complete" && !turn.final_answer_parts.isEmpty ? turn.final_answer_parts.joined(separator: "\n\n") : nil
                byID[turn.turn_id] = ChatTurn(id: turn.turn_id, prompt: turn.prompt_parts.joined(separator: "\n\n"), answer: answer, questionTime: time(turn.question_ts) ?? "时间未记录", answerTime: time(turn.answer_ts), model: turn.model)
            }
        }
        guard !order.isEmpty || warnings.isEmpty else { throw readerError(warnings.joined(separator: "\n")) }
        return ReadSession(turns: order.compactMap { byID[$0] }, warnings: warnings)
    }
    private func time(_ milliseconds: Double?) -> String? {
        guard let milliseconds, milliseconds > 0 else { return nil }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "zh_CN"); formatter.dateFormat = "MM月dd日 HH:mm"
        return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
    }
    private func readerError(_ text: String) -> NSError { NSError(domain: "WeeklyReportReader", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
}
