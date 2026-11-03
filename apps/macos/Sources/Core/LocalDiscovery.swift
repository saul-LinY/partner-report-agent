import Foundation
import SQLite3
import CryptoKit

public struct LocalSessionSource: Codable, Equatable, Sendable {
    public var id: String
    public var agent: Agent
    public var nativeID: String
    public var source: String
    public var cwd: String
    public var projectRoot: String
    public var modifiedAt: Date
    public var fingerprint: String
    public var storeRoot: String? = nil
    public var readabilityIssue: String? = nil
    public var groupID: String {
        guard let storeRoot else { return "\(agent.id):\(nativeID)" }
        return "\(agent.id):\(nativeID):\(storeRoot):\(projectRoot)"
    }
}

public struct DiscoveredProject: Sendable {
    public var root: String
    public var name: String
}

public struct DiscoverySnapshot: Sendable {
    public var projects: [DiscoveredProject]
    public var sessions: [LocalSessionSource]
    public var agentStatus: [Agent: String]
    public var skippedTemporary: Int
    public var issues: [String]
    public var locations: [AgentLocation] = []
}

/// Metadata only: these types intentionally have no message text, title or prompt fields.
private struct MetadataRecord: Decodable {
    var type: String?
    var id: String?
    var sessionId: String?
    var cwd: String?
    var directory: String?
    var workDir: String?
    var relocatedCwd: String?
    var parentID: String?
    var parent_session_id: String?
    var isSidechain: Bool?
    var payload: MetadataPayload?
    var info: MetadataPayload?
    var custom: MetadataPayload?
    var archived: Bool?
    var time: ArchiveTime?
    struct ArchiveTime: Decodable { var archived: Double? }
    struct MetadataPayload: Decodable {
        var id: String?
        var cwd: String?
        var parentID: String?
        var session_kind: String?
    }
}

public struct LocalDiscovery: Sendable {
    public let home: URL
    public let registeredRoots: [String]
    public let pathOverrides: [String: String]
    public let temporaryRoots: [String]?
    public let environment: [String: String]
    public let metadataReader: URL?
    public let rememberedLocations: [AgentLocation]
    public let scanWindow: SessionScanWindow?
    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser, registeredRoots: [String] = [], pathOverrides: [String: String] = [:], temporaryRoots: [String]? = nil, environment: [String: String] = ProcessInfo.processInfo.environment, metadataReader: URL? = Bundle.main.url(forResource: "cc-session-reader", withExtension: nil), rememberedLocations: [AgentLocation] = [], scanWindow: SessionScanWindow? = nil) {
        self.home = home; self.registeredRoots = registeredRoots; self.pathOverrides = pathOverrides; self.temporaryRoots = temporaryRoots
        self.environment = environment; self.metadataReader = metadataReader
        self.rememberedLocations = rememberedLocations
        self.scanWindow = scanWindow
    }
    public func scan(progress: @Sendable (DiscoveryProgress) -> Void = { _ in }) -> DiscoverySnapshot {
        var sources: [LocalSessionSource] = []
        var issues: [String] = []
        var status: [Agent: String] = [:]
        var skipped = 0
        var rootCache: [String: String] = [:]
        var directoryFingerprints: [String: String] = [:]
        let fm = FileManager.default
        func inWindow(_ file: URL) -> Bool { scanWindow?.contains(modified(file)) ?? true }
        func root(_ cwd: String) -> String? {
            if let cached = rootCache[cwd] { return cached.isEmpty ? nil : cached }
            let found = projectRoot(for: cwd)
            rootCache[cwd] = found ?? ""
            return found
        }
        func append(_ agent: Agent, _ nativeID: String, _ source: String, _ cwd: String, _ modified: Date, readabilityIssue: String? = nil) {
            guard scanWindow?.contains(modified) ?? true else { return }
            guard !SessionSourcePolicy.isArchived(source) else { return }
            guard let project = root(cwd) else { skipped += 1; return }
            let sourcePath: String
            if source.hasPrefix("sqlite:") {
                let tail = String(source.dropFirst(7))
                if agent == .opencode, let range = tail.range(of: ":ses_", options: .backwards) { sourcePath = String(tail[..<range.lowerBound]) }
                else if let index = tail.lastIndex(of: "#") { sourcePath = String(tail[..<index]) }
                else { sourcePath = source }
            } else { sourcePath = source }
            let path = URL(fileURLWithPath: sourcePath)
            let values = try? path.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let wal = try? URL(fileURLWithPath: sourcePath + "-wal").resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            var fingerprint = "\(values?.fileSize ?? 0):\(values?.contentModificationDate?.timeIntervalSince1970 ?? modified.timeIntervalSince1970):\(wal?.fileSize ?? 0):\(wal?.contentModificationDate?.timeIntervalSince1970 ?? 0)"
            if agent == .agy {
                let database = path.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appending(path: "conversation_summaries.db")
                for candidate in [database, URL(fileURLWithPath: database.path + "-wal")] {
                    if let value = try? candidate.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) { fingerprint += ":\(value.fileSize ?? 0):\(value.contentModificationDate?.timeIntervalSince1970 ?? 0)" }
                }
            }
            if agent == .grokbuild {
                for name in ["chat_history.jsonl", "events.jsonl"] {
                    if let value = try? path.deletingLastPathComponent().appending(path: name).resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) { fingerprint += ":\(value.fileSize ?? 0):\(value.contentModificationDate?.timeIntervalSince1970 ?? 0)" }
                }
            }
            if agent == .opencode && !source.hasPrefix("sqlite:") {
                var storage = path.deletingLastPathComponent()
                while storage.path != "/" && storage.lastPathComponent != "storage" { storage.deleteLastPathComponent() }
                if storage.lastPathComponent == "storage" {
                    for folder in [storage.appending(path: "message/\(nativeID)"), storage.appending(path: "part")] {
                        if directoryFingerprints[folder.path] == nil {
                            let stats = files(in: folder, maximumDepth: 4).sorted { $0.path < $1.path }.map { file in
                                let info = try? file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
                                return "\(file.path):\(info?.fileSize ?? 0):\(info?.contentModificationDate?.timeIntervalSince1970 ?? 0)"
                            }.joined(separator: "|")
                            directoryFingerprints[folder.path] = SHA256.hash(data: Data(stats.utf8)).map { String(format: "%02x", $0) }.joined()
                        }
                        fingerprint += ":" + directoryFingerprints[folder.path]!
                    }
                }
            }
            let normalizedPath = path.standardizedFileURL.resolvingSymlinksInPath().path
            let id = "\(agent.id):\(nativeID):\(normalizedPath)"
            let location = resolution.locations.filter { $0.agent == agent && (normalizedPath == $0.sessionPath || normalizedPath.hasPrefix($0.sessionPath + "/")) }.max { $0.sessionPath.count < $1.sessionPath.count }
            let storeRoot = location.map { [.codex, .grok, .transcript].contains($0.kind) ? $0.agentDirectory : $0.sessionPath } ?? path.deletingLastPathComponent().path
            sources.append(.init(id: id, agent: agent, nativeID: nativeID, source: source, cwd: cwd, projectRoot: project, modifiedAt: modified, fingerprint: fingerprint, storeRoot: storeRoot, readabilityIssue: readabilityIssue))
        }
        let resolution = SourceLocations(home: home, overrides: pathOverrides, environment: environment, remembered: rememberedLocations).resolve()
        func report(_ step: Int, _ message: String) {
            progress(DiscoveryProgress(completedSteps: step, message: message,
                                       toolsFound: Set(resolution.locations.filter(\.exists).map(\.agent)).count,
                                       projectsFound: Set(sources.map(\.projectRoot)).count))
        }
        report(1, "正在检查会话索引")
        issues += resolution.issues
        var pendingHeaders: [(Agent, URL)] = []
        var failedAgents: Set<Agent> = []
        func existing(_ agent: Agent, _ kind: AgentLocation.Kind) -> [AgentLocation] {
            resolution.locations.filter { $0.agent == agent && $0.kind == kind && $0.exists }
        }
        func fail(_ agent: Agent, _ detail: String) {
            failedAgents.insert(agent); issues.append("\(agent.name)：\(detail)")
        }
        // All state DBs supplement file discovery; an index is no longer a prerequisite.
        var codexKnown: [String: [String: String]] = [:]
        var archivedCodexIDs: Set<String> = []
        var inspectedDBs: Set<String> = []
        for location in resolution.locations where location.agent == .codex {
            for folder in SourceLocations.codexDatabaseDirectories(agentDirectory: URL(fileURLWithPath: location.agentDirectory), home: home, environment: environment) {
                let databases = ((try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [])
                    .filter { $0.lastPathComponent.hasPrefix("state_") && $0.pathExtension == "sqlite" }
                for database in databases where inspectedDBs.insert(database.path).inserted {
                    do {
                        let columns = try MetadataDatabase.columns(database, table: "threads")
                        guard columns.contains("id"), columns.contains("cwd"), columns.contains("rollout_path") else { throw CocoaError(.fileReadCorruptFile) }
                        let source = columns.contains("source") ? "source" : "NULL AS source"
                        let updated = columns.contains("updated_at") ? "updated_at" : "0 AS updated_at"
                        let archived = columns.contains("archived") ? "archived" : "0 AS archived"
                        let rows = try MetadataDatabase.rows(database, sql: "SELECT id, rollout_path, cwd, \(source), \(updated), \(archived) FROM threads")
                        for row in rows {
                            guard let id = row["id"], let cwd = row["cwd"], let source = row["rollout_path"], !(row["source"] ?? "").contains("subagent") else { continue }
                            if row["archived"] == "1" || SessionSourcePolicy.isArchived(source) { archivedCodexIDs.insert(id); continue }
                            let actual = fm.fileExists(atPath: source) ? source : source + ".zst"
                            guard fm.fileExists(atPath: actual) else { continue }
                            codexKnown[id] = row
                            append(.codex, id, actual, cwd, Date(timeIntervalSince1970: Double(row["updated_at"] ?? "") ?? 0))
                        }
                    } catch { fail(.codex, "无法读取索引 \(database.path)") }
                }
            }
        }
        report(2, "正在查找会话文件")
        let pattern = try! NSRegularExpression(pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        var codexPaths = Set(sources.filter { $0.agent == .codex }.map(\.source))
        for location in existing(.codex, .codex) {
            for file in files(in: URL(fileURLWithPath: location.sessionPath), maximumDepth: 8) where file.pathExtension == "jsonl" || file.lastPathComponent.hasSuffix(".jsonl.zst") {
                guard inWindow(file) else { continue }
                if file.pathExtension == "zst" && fm.fileExists(atPath: String(file.path.dropLast(4))) { continue }
                guard codexPaths.insert(file.path).inserted else { continue }
                let name = file.lastPathComponent
                if let match = pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)), let range = Range(match.range, in: name), archivedCodexIDs.contains(String(name[range])) { continue }
                if let match = pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)), let range = Range(match.range, in: name), let row = codexKnown[String(name[range])], let id = row["id"], let cwd = row["cwd"] {
                    append(.codex, id, file.path, cwd, modified(file))
                } else { pendingHeaders.append((.codex, file)) }
            }
        }
        for agent in [Agent.claude, .pi, .omp] {
            for location in existing(agent, .transcript) {
                for file in files(in: URL(fileURLWithPath: location.sessionPath), maximumDepth: 3) where file.pathExtension == "jsonl" && !file.lastPathComponent.hasPrefix("agent-") && file.lastPathComponent != "journal.jsonl" {
                    guard inWindow(file) else { continue }
                    pendingHeaders.append((agent, file))
                }
            }
        }
        // Schema-aware queries use only identity, directory, relationship and time columns.
        for agent in [Agent.opencode, .hermes] {
            for location in existing(agent, .database) {
                let db = URL(fileURLWithPath: location.sessionPath)
                do {
                    let tables = agent == .opencode ? ["session_v2", "session"] : ["sessions"]
                    var nativeIDs: Set<String> = []
                    for table in tables {
                        let columns = try MetadataDatabase.columns(db, table: table)
                        guard columns.contains("id") else { continue }
                        let cwd = columns.contains("directory") ? "directory" : columns.contains("cwd") ? "cwd" : nil
                        guard let cwd else { continue }
                        let parent = columns.contains("parent_id") ? "parent_id" : columns.contains("parent_session_id") ? "parent_session_id" : nil
                        let time = ["time_updated", "updated_at", "started_at", "created_at"].first { columns.contains($0) }
                        let archiveColumn = ["time_archived", "archived_at", "archived"].first { columns.contains($0) }
                        let archive = archiveColumn ?? "0"
                        let rows = try MetadataDatabase.rows(db, sql: "SELECT id, \(cwd) AS cwd, \(parent ?? "NULL") AS parent, \(time ?? "0") AS modified, \(archive) AS archived FROM \(table)")
                        for row in rows {
                            // A V2 ID owns its history even if it is a child or lacks project metadata.
                            guard let id = row["id"], nativeIDs.insert(id).inserted else { continue }
                            guard (Double(row["archived"] ?? "") ?? 0) == 0 else { continue }
                            guard (row["parent"] ?? "").isEmpty, let folder = row["cwd"], !folder.isEmpty else { continue }
                            let value = Double(row["modified"] ?? "") ?? 0
                            append(agent, id, agent == .opencode ? "sqlite:\(db.path):\(id)" : "sqlite:\(db.path)#\(id)", folder, Date(timeIntervalSince1970: value > 1e12 ? value / 1000 : value))
                        }
                    }
                } catch { fail(agent, "无法读取数据库 \(db.path)") }
            }
        }
        for location in existing(.opencode, .openCodeJSON) {
            for file in files(in: URL(fileURLWithPath: location.sessionPath).appending(path: "session"), maximumDepth: 4) where file.pathExtension == "json" {
                guard inWindow(file) else { continue }
                if let metadata = try? JSONDecoder().decode(MetadataRecord.self, from: Data(contentsOf: file)),
                   metadata.archived == true || (metadata.time?.archived ?? 0) != 0 { continue }
                pendingHeaders.append((.opencode, file))
            }
        }
        for location in existing(.hermes, .transcript) {
            for file in files(in: URL(fileURLWithPath: location.sessionPath), maximumDepth: 3) where ["jsonl", "json"].contains(file.pathExtension) {
                guard inWindow(file) else { continue }
                pendingHeaders.append((.hermes, file))
            }
        }
        // Antigravity CLI and Desktop have separate brains; neither is a substitute for the other.
        let agyBrains = existing(.agy, .brain).map { URL(fileURLWithPath: $0.sessionPath) }
        var agyRoots: Set<String> = []
        var agyOrigins: Set<String> = []
        for brain in agyBrains where fm.fileExists(atPath: brain.path) {
            let actual = brain.resolvingSymlinksInPath()
            guard agyRoots.insert(actual.path).inserted else { continue }
            let database = actual.deletingLastPathComponent().appending(path: "conversation_summaries.db")
            do {
                let rows = try MetadataDatabase.rows(database, sql: "SELECT conversation_id, workspace_uris, last_modified_time, parent_conversation_id FROM conversation_summaries")
                for row in rows where (row["parent_conversation_id"] ?? "").isEmpty {
                    guard let id = row["conversation_id"], !id.isEmpty, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }),
                          let uris = row["workspace_uris"], let bytes = uris.data(using: .utf8), let workspaces = try? JSONDecoder().decode([String].self, from: bytes), !workspaces.isEmpty else { continue }
                    let paths = workspaces.compactMap { URL(string: $0) }.filter(\.isFileURL).map(\.path)
                    let mapped = Set(paths.compactMap(root))
                    guard mapped.count == 1, paths.allSatisfy({ root($0) != nil }), paths.count == workspaces.count, let cwd = paths.first else { continue }
                    let transcript = actual.appending(path: "\(id)/.system_generated/logs/transcript_full.jsonl")
                    guard transcript.resolvingSymlinksInPath().path.hasPrefix(actual.path + "/") else { continue }
                    let available = fm.fileExists(atPath: transcript.path)
                    append(.agy, id, transcript.path, cwd, modified(transcript), readabilityIssue: available ? nil : "已找到 Antigravity 会话，但该客户端尚未生成可读取的文本记录。")
                }
                agyOrigins.insert(brain.path.contains("antigravity-cli") ? "CLI" : "桌面端")
                status[.agy] = "已发现 " + agyOrigins.sorted().joined(separator: "／")
            } catch { fail(.agy, "无法读取来源 \(brain.path)") }
        }
        // Other formats are only discovered from independent project metadata.
        for location in existing(.grokbuild, .grok) {
            for file in files(in: URL(fileURLWithPath: location.sessionPath), maximumDepth: 4) where file.lastPathComponent == "summary.json" {
                let activity = max(modified(file), modified(file.deletingLastPathComponent().appending(path: "chat_history.jsonl")))
                guard scanWindow?.contains(activity) ?? true else { continue }
                if let data = try? Data(contentsOf: file), let record = try? JSONDecoder().decode(MetadataRecord.self, from: data), let cwd = record.info?.cwd {
                    append(.grokbuild, record.info?.id ?? file.deletingLastPathComponent().lastPathComponent, file.path, cwd, activity)
                }
            }
        }
        report(3, "正在识别项目位置")
        let headers = locate(pendingHeaders)
        for header in headers.records {
            // SQLite is authoritative for legacy copies of the same session in this store.
            let normalizedPath = header.file.standardizedFileURL.resolvingSymlinksInPath().path
            let context = resolution.locations.filter { $0.agent == header.agent && normalizedPath.hasPrefix($0.sessionPath + "/") }.max { $0.sessionPath.count < $1.sessionPath.count }
            if [.opencode, .hermes].contains(header.agent), sources.contains(where: { source in
                guard source.agent == header.agent, source.nativeID == header.id, source.source.hasPrefix("sqlite:"), source.cwd == header.cwd,
                      let database = source.storeRoot, let context else { return false }
                return URL(fileURLWithPath: database).deletingLastPathComponent().path == context.agentDirectory
            }) { continue }
            append(header.agent, header.id, header.file.path, header.cwd, modified(header.file))
        }
        issues += headers.issues
        report(4, "正在整理扫描结果")
        for agent in Agent.allCases {
            let found = sources.contains { $0.agent == agent }
            if failedAgents.contains(agent) { status[agent] = found ? "部分读取受限" : "读取受限" }
            else if issues.contains(where: { $0.hasPrefix(agent.name + "：") }) { status[agent] = found ? "已发现 · 部分记录待定位" : "需要配置来源" }
            else if found { if agent != .agy { status[agent] = "已发现" } }
            else if resolution.locations.contains(where: { $0.agent == agent && $0.exists }) { status[agent] = "暂无项目会话" }
            else if resolution.locations.contains(where: { $0.agent == agent && fm.fileExists(atPath: $0.agentDirectory) }) { status[agent] = "已找到工具目录" }
            else { status[agent] = "未发现" }
        }
        let roots = Set(sources.map(\.projectRoot)).union(scanWindow == nil ? registeredRoots.filter { projectRoot(for: $0) != nil } : [])
        let uniqueSources = Dictionary(sources.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }).values
        report(5, "正在保存扫描结果")
        return DiscoverySnapshot(projects: roots.sorted().map { .init(root: $0, name: URL(fileURLWithPath: $0).lastPathComponent) }, sessions: uniqueSources.sorted { $0.modifiedAt > $1.modifiedAt }, agentStatus: status, skippedTemporary: skipped, issues: issues, locations: resolution.locations)
    }

    public func projectRoot(for folder: String) -> String? {
        guard folder.hasPrefix("/") else { return nil }
        let canonical = URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath()
        let excluded = temporaryRoots ?? ["/tmp", "/private/tmp", "/var/tmp", "/private/var", home.appending(path: "Documents/Codex").path, home.appending(path: ".codex/worktrees").path]
        guard canonical != home, !excluded.contains(where: { canonical.path == $0 || canonical.path.hasPrefix($0 + "/") }) else { return nil }
        let matching = registeredRoots.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath() }
            .filter { canonical.path == $0.path || canonical.path.hasPrefix($0.path + "/") }.sorted { $0.path.count > $1.path.count }
        if let match = matching.first { return match.path }
        var path = canonical
        var gitRoot: String?
        while path.path != "/", path != home {
            if FileManager.default.fileExists(atPath: path.appending(path: ".git").path) { gitRoot = path.path }
            path.deleteLastPathComponent()
        }
        return gitRoot
    }
    private func modified(_ url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }
    private struct HeaderLocation {
        var agent: Agent; var id: String; var file: URL; var cwd: String
    }
    private struct LocateJob: Codable { var provider: String; var source: String }
    private struct LocateResult: Decodable {
        var provider: String; var source: String; var status: String
        var session_id: String?; var cwd: String?
    }
    private func locate(_ candidates: [(Agent, URL)]) -> (records: [HeaderLocation], issues: [String]) {
        var seen: Set<String> = []
        let jobs = candidates.filter { seen.insert("\($0.0.id):\($0.1.path)").inserted }
        guard !jobs.isEmpty else { return ([], []) }
        let fm = FileManager.default
        if let metadataReader, fm.isExecutableFile(atPath: metadataReader.path) {
            let work = fm.temporaryDirectory.appending(path: "weekly-locate-\(UUID())")
            defer { try? fm.removeItem(at: work) }
            do {
                try fm.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let input = work.appending(path: "input.json"), output = work.appending(path: "output.json")
                try JSONEncoder().encode(jobs.map { LocateJob(provider: $0.0.id, source: $0.1.path) }).write(to: input)
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: input.path)
                let process = Process(); process.executableURL = metadataReader
                process.arguments = ["--locate", input.path, output.path]
                process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
                try process.run(); process.waitUntilExit()
                guard process.terminationStatus == 0 else { throw CocoaError(.executableRuntimeMismatch) }
                let result = try JSONDecoder().decode([LocateResult].self, from: Data(contentsOf: output))
                let requested = Set(jobs.map { "\($0.0.id):\($0.1.path)" })
                var records: [HeaderLocation] = [], failures: [Agent: Int] = [:]
                for row in result {
                    guard let agent = Agent(rawValue: row.provider), requested.contains("\(row.provider):\(row.source)") else { continue }
                    if row.status == "located", let id = row.session_id, let cwd = row.cwd {
                        records.append(.init(agent: agent, id: id, file: URL(fileURLWithPath: row.source), cwd: cwd))
                    } else if row.status != "excluded" { failures[agent, default: 0] += 1 }
                }
                return (records, failures.keys.sorted { $0.id < $1.id }.map { "\($0.name)：\(failures[$0]!) 个文件的项目定位信息不足或不可读。" })
            } catch {
                // Command-line fixture tools can run without the bundled executable.
                // The fallback only supports uncompressed, typed metadata; it never guesses cwd.
            }
        }
        var records: [HeaderLocation] = [], issues: [String] = []
        for (agent, file) in jobs {
            do {
                let record: MetadataRecord?
                if agent == .opencode { record = try JSONDecoder().decode(MetadataRecord.self, from: Data(contentsOf: file)) }
                else if file.pathExtension == "zst" { issues.append("Codex：压缩历史需要本机定位组件。") ; continue }
                else { record = try leadingMetadata(file, maximumLines: agent == .claude || agent == .hermes ? 30 : 5) }
                guard let record, record.archived != true, (record.time?.archived ?? 0) == 0, record.isSidechain != true, (record.parentID ?? record.parent_session_id ?? "").isEmpty,
                      let cwd = record.cwd ?? record.directory ?? record.payload?.cwd else { continue }
                let id = record.sessionId ?? record.id ?? record.payload?.id ?? file.deletingPathExtension().lastPathComponent
                records.append(.init(agent: agent, id: id, file: file, cwd: cwd))
            } catch { issues.append("\(agent.name)：无法读取定位文件 \(file.lastPathComponent)") }
        }
        return (records, issues)
    }
    private func files(in root: URL, maximumDepth: Int) -> [URL] {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: []) else { return [] }
        var result: [URL] = []
        for case let url as URL in enumerator {
            let depth = enumerator.level
            let flags = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            if flags?.isSymbolicLink == true { enumerator.skipDescendants(); continue }
            if flags?.isDirectory == true {
                if depth >= maximumDepth || SessionSourcePolicy.isArchived(url.path) || ["subagents", "subagent-artifacts", "node_modules"].contains(url.lastPathComponent) { enumerator.skipDescendants() }
            } else if depth <= maximumDepth { result.append(url) }
        }
        return result
    }
    private func leadingMetadata(_ file: URL, maximumLines: Int) throws -> MetadataRecord? {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var buffer = Data()
        var lines = 0
        while lines < maximumLines {
            let data = try handle.read(upToCount: 8192) ?? Data()
            if data.isEmpty {
                if let record = try? JSONDecoder().decode(MetadataRecord.self, from: buffer), (record.cwd ?? record.directory ?? record.payload?.cwd) != nil { return record }
                break
            }
            buffer.append(data)
            if buffer.count > 8 * 1024 * 1024 { return nil }
            while let newline = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: newline)
                lines += 1
                if let record = try? JSONDecoder().decode(MetadataRecord.self, from: line), (record.cwd ?? record.directory ?? record.payload?.cwd) != nil { return record }
                buffer.removeSubrange(...newline)
                if lines >= maximumLines { return nil }
            }
        }
        return nil
    }
}

enum MetadataDatabase {
    static func columns(_ file: URL, table: String) throws -> Set<String> {
        // Table names are internal constants, never user input.
        Set(try rows(file, sql: "PRAGMA table_info(\(table))").compactMap { $0["name"] })
    }
    static func rows(_ file: URL, sql: String, parameters: [String] = []) throws -> [[String: String]] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }; throw CocoaError(.fileReadNoPermission)
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 2000)
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw NSError(domain: "ProjectMetadata", code: 1, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))]) }
        defer { sqlite3_finalize(statement) }
        for (index, value) in parameters.enumerated() {
            let result = value.withCString { sqlite3_bind_text(statement, Int32(index + 1), $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
            guard result == SQLITE_OK else { throw CocoaError(.fileReadUnknown) }
        }
        var rows: [[String: String]] = []
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
            var row: [String: String] = [:]
            for column in 0..<sqlite3_column_count(statement) {
                if let value = sqlite3_column_text(statement, column) { row[String(cString: sqlite3_column_name(statement, column))] = String(cString: value) }
            }
            rows.append(row); step = sqlite3_step(statement)
        }
        guard step == SQLITE_DONE else { throw CocoaError(.fileReadUnknown) }
        return rows
    }
}
