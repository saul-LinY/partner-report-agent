import Foundation
import Darwin

/// Invoked only with sources whose project has already been locally allowed.
public struct AuthorizedTitles: Sendable {
    public var home: URL
    public var pathOverrides: [String: String]
    public var environment: [String: String]
    public init(home: URL, pathOverrides: [String: String], environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.home = home; self.pathOverrides = pathOverrides; self.environment = environment
    }

    public func read(sources: [LocalSessionSource], allowedRoots: Set<String>) -> [String: String] {
        readWithValidation(sources: sources, allowedRoots: allowedRoots).titles
    }

    func readWithValidation(sources: [LocalSessionSource], allowedRoots: Set<String>) -> (titles: [String: String], validatedClaudeKeys: Set<String>) {
        let authorized = sources.filter { !SessionSourcePolicy.isArchived($0.source) && allowedRoots.contains($0.projectRoot) && within($0.cwd, root: $0.projectRoot) }
        guard !authorized.isEmpty else { return ([:], []) }
        let locations = SourceLocations(home: home, overrides: pathOverrides, environment: environment).resolve().locations
        let contexts = authorized.map { $0.agent == .codex ? codexRoots($0, locations: locations) : [] }
        var indexIDs: [String: Set<String>] = [:]
        for (source, roots) in zip(authorized, contexts) {
            for root in roots { indexIDs[root.path, default: []].insert(source.nativeID) }
        }
        var result: [String: String] = [:], indexCache: [String: [String: String]] = [:]
        var rejectedClaude: Set<String> = []
        var validatedClaude: Set<String> = []
        for (source, roots) in zip(authorized, contexts) {
            let key = source.groupID
            if source.agent == .codex {
                if result[key] == nil, let title = codexTitle(source, roots: roots, indexIDs: indexIDs, indexCache: &indexCache) { result[key] = title }
                continue
            }
            if source.source.hasPrefix("sqlite:") {
                if source.agent == .opencode {
                    if let title = openCodeSQLTitle(source) { result[key] = title }
                } else if let (db, table) = sqliteSource(source), let row = try? MetadataDatabase.rows(db, sql: "SELECT title FROM \(table) WHERE id=?1", parameters: [source.nativeID]).first, let title = clean(row["title"]) { result[key] = title }
                continue
            }
            let file = URL(fileURLWithPath: source.source)
            if source.agent == .opencode {
                if let title = openCodeJSONTitle(source) { result[key] = title }
                continue
            }
            if source.agent == .grokbuild, let bytes = try? Data(contentsOf: file), let record = try? JSONDecoder().decode(GrokTitle.self, from: bytes), let title = clean(record.generated_title) { result[key] = title }
            if source.agent == .agy {
                let database = file.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appending(path: "conversation_summaries.db")
                if let row = try? MetadataDatabase.rows(database, sql: "SELECT title FROM conversation_summaries WHERE conversation_id=?1", parameters: [source.nativeID]).first, let title = clean(row["title"]) { result[key] = title }
            }
            if [.claude, .pi, .omp].contains(source.agent) {
                let before = stamp(file)
                if source.agent == .claude, before == nil || !claudeMetadataAllows(file, source: source) || before != stamp(file) {
                    rejectedClaude.insert(key)
                    continue
                }
                var title: String?
                let complete = lines(file) { line in
                    guard let record = try? JSONDecoder().decode(TitleMetadata.self, from: line) else { return true }
                    switch record.type {
                    case "custom-title": title = clean(record.customTitle) ?? title
                    case "title", "session": title = clean(record.title) ?? title
                    case "session_info": title = clean(record.name) ?? title
                    default: break
                    }
                    return true
                }
                if source.agent == .claude, title == nil, complete {
                    let index = file.deletingLastPathComponent().appending(path: "sessions-index.json")
                    if let bytes = try? Data(contentsOf: index), let entries = try? JSONDecoder().decode(ClaudeIndex.self, from: bytes).entries,
                       let entry = entries.first(where: { $0.sessionId == source.nativeID }) { title = clean(entry.summary) }
                }
                // Reject a file replaced or appended between metadata preflight and title parsing.
                if source.agent == .claude, before == nil || before != stamp(file) || !complete {
                    rejectedClaude.insert(key)
                    continue
                }
                if source.agent == .claude { validatedClaude.insert(key) }
                if complete, let title { result[key] = title }
            }
        }
        for key in rejectedClaude { result.removeValue(forKey: key) }
        return (result, validatedClaude.subtracting(rejectedClaude))
    }

    private func codexRoots(_ source: LocalSessionSource, locations: [AgentLocation]) -> [URL] {
        let sourceFile = URL(fileURLWithPath: source.source).standardizedFileURL.resolvingSymlinksInPath()
        let codex = locations.filter { $0.agent == .codex }
        var roots: [URL] = []
        // A source can outlive the CODEX_HOME / CC Switch setting that originally created it.
        if source.source.hasPrefix("/") {
            var ancestor = sourceFile.deletingLastPathComponent()
            while ancestor.path != "/" {
                if ["sessions", "archived_sessions"].contains(ancestor.lastPathComponent) {
                    roots.append(ancestor.deletingLastPathComponent())
                    break
                }
                if FileManager.default.fileExists(atPath: ancestor.appending(path: "session_index.jsonl").path) || !stateDatabases(ancestor).isEmpty {
                    roots.append(ancestor)
                    break
                }
                ancestor.deleteLastPathComponent()
            }
        }
        let matching = codex.filter { within(sourceFile.path, root: $0.sessionPath) || source.storeRoot == $0.sessionPath }
            .sorted { $0.sessionPath.count > $1.sessionPath.count }
        // Prefer the most specific resolved source context over a directory name heuristic.
        if let location = matching.first { roots = [URL(fileURLWithPath: location.agentDirectory)] }
        // Legacy callers may supply only ID/cwd. Never borrow an unrelated home's index
        // for an absolute source whose actual storage root is unknown.
        if roots.isEmpty, !source.source.hasPrefix("/") { roots = codex.map { URL(fileURLWithPath: $0.agentDirectory) } }
        return unique(roots)
    }

    private func codexTitle(_ source: LocalSessionSource, roots: [URL], indexIDs: [String: Set<String>], indexCache: inout [String: [String: String]]) -> String? {
        var storedName: String?, indexedTitle: String?, storedTitle: String?
        for root in roots {
            let cacheKey = root.path
            if indexCache[cacheKey] == nil {
                var indexed: [String: String] = [:]
                let complete = lines(root.appending(path: "session_index.jsonl")) { line in
                    guard let head = try? JSONDecoder().decode(IndexID.self, from: line), indexIDs[cacheKey]?.contains(head.id) == true,
                          let record = try? JSONDecoder().decode(IndexTitle.self, from: line), let title = clean(record.thread_name) else { return true }
                    indexed[record.id] = title
                    return true
                }
                indexCache[cacheKey] = complete ? indexed : [:]
            }
            indexedTitle = indexedTitle ?? indexCache[cacheKey]?[source.nativeID]
            let databaseRoots = SourceLocations.codexDatabaseDirectories(agentDirectory: root, home: home, environment: environment)
            for database in unique(databaseRoots).flatMap(stateDatabases) {
                // Both projections bind the discovered ID AND cwd, including old schemas without name.
                if let row = try? MetadataDatabase.rows(database, sql: "SELECT name, title FROM threads WHERE id=?1 AND cwd=?2", parameters: [source.nativeID, source.cwd]).first {
                    storedName = storedName ?? clean(row["name"])
                    storedTitle = storedTitle ?? clean(row["title"])
                } else if let row = try? MetadataDatabase.rows(database, sql: "SELECT title FROM threads WHERE id=?1 AND cwd=?2", parameters: [source.nativeID, source.cwd]).first {
                    storedTitle = storedTitle ?? clean(row["title"])
                }
            }
        }
        return storedName ?? indexedTitle ?? storedTitle
    }

    private func stateDatabases(_ root: URL) -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.range(of: "^state_[0-9]+\\.sqlite$", options: .regularExpression) != nil }
            .sorted { $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending }
    }

    private func openCodeSQLTitle(_ source: LocalSessionSource) -> String? {
        guard let (database, _) = sqliteSource(source) else { return nil }
        for table in ["session_v2", "session"] {
            // V2 owns an existing ID even when its cwd differs or its title is empty.
            // Falling back to obsolete V1 metadata would disagree with the real reader.
            guard let row = try? MetadataDatabase.rows(database, sql: "SELECT id, directory FROM \(table) WHERE id=?1", parameters: [source.nativeID]).first else { continue }
            guard row["directory"] == source.cwd else { return nil }
            let titled = try? MetadataDatabase.rows(database, sql: "SELECT title FROM \(table) WHERE id=?1 AND directory=?2", parameters: [source.nativeID, source.cwd]).first
            return clean(titled?["title"])
        }
        return nil
    }

    private func openCodeJSONTitle(_ source: LocalSessionSource) -> String? {
        let path = URL(fileURLWithPath: source.source).standardizedFileURL.resolvingSymlinksInPath()
        var candidates: [URL] = []
        if path.pathExtension == "json" { candidates = [path] }
        else if path.lastPathComponent == source.nativeID, path.deletingLastPathComponent().lastPathComponent == "message" {
            let sessions = path.deletingLastPathComponent().deletingLastPathComponent().appending(path: "session")
            if let enumerator = FileManager.default.enumerator(at: sessions, includingPropertiesForKeys: [.isSymbolicLinkKey]) {
                for case let file as URL in enumerator {
                    if (try? file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true { enumerator.skipDescendants(); continue }
                    if file.lastPathComponent == source.nativeID + ".json" { candidates.append(file) }
                }
            }
        }
        for file in candidates.sorted(by: { $0.path < $1.path }) {
            guard let bytes = try? Data(contentsOf: file), let metadata = try? JSONDecoder().decode(OpenCodeMetadata.self, from: bytes),
                  metadata.id == source.nativeID, metadata.directory == source.cwd,
                  (metadata.parentID ?? "").isEmpty, within(metadata.directory, root: source.projectRoot) else { continue }
            if let record = try? JSONDecoder().decode(OpenCodeTitle.self, from: bytes), let title = clean(record.title) { return title }
        }
        return nil
    }

    private func claudeMetadataAllows(_ file: URL, source: LocalSessionSource) -> Bool {
        lines(file) { line in
            if line.allSatisfy({ [9, 13, 32].contains($0) }) { return true }
            guard let metadata = try? JSONDecoder().decode(ClaudeMetadata.self, from: line) else { return false }
            if let id = metadata.sessionId, id != source.nativeID { return false }
            for path in [metadata.cwd, metadata.relocatedCwd].compactMap({ $0 }) {
                if !within(path, root: source.projectRoot) { return false }
            }
            return true
        }
    }

    private func within(_ path: String, root: String) -> Bool {
        guard path.hasPrefix("/"), root.hasPrefix("/") else { return false }
        let actual = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        let base = URL(fileURLWithPath: root).standardizedFileURL.resolvingSymlinksInPath().path
        return actual == base || actual.hasPrefix(base == "/" ? "/" : base + "/")
    }
    private func unique(_ paths: [URL]) -> [URL] {
        var seen: Set<String> = []
        return paths.map { $0.standardizedFileURL.resolvingSymlinksInPath() }.filter { seen.insert($0.path).inserted }
    }
    private func clean(_ value: String?) -> String? {
        guard let text = value?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
    private func stamp(_ file: URL) -> FileStamp? {
        guard let values = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = values[.size] as? NSNumber, let modified = values[.modificationDate] as? Date else { return nil }
        return FileStamp(size: size.uint64Value, modified: modified, inode: (values[.systemFileNumber] as? NSNumber)?.uint64Value)
    }
    @discardableResult
    private func lines(_ file: URL, _ body: (Data) -> Bool) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        defer { try? handle.close() }
        var pending = Data()
        let maximumLineBytes = 32 * 1024 * 1024
        do {
            while let bytes = try handle.read(upToCount: 65536), !bytes.isEmpty {
                // Search each incoming byte once; a large partial line is never scanned again.
                let complete = bytes.withUnsafeBytes { (chunk: UnsafeRawBufferPointer) -> Bool in
                    guard let base = chunk.baseAddress else { return true }
                    var offset = 0
                    while offset < chunk.count, let newline = memchr(base.advanced(by: offset), 10, chunk.count - offset) {
                        let end = base.distance(to: UnsafeRawPointer(newline))
                        let count = end - offset
                        guard pending.count + count <= maximumLineBytes else { return false }
                        let start = base.advanced(by: offset)
                        if pending.isEmpty {
                            guard body(Data(bytes: start, count: count)) else { return false }
                        } else {
                            pending.append(start.assumingMemoryBound(to: UInt8.self), count: count)
                            guard body(pending) else { return false }
                            pending.removeAll(keepingCapacity: true)
                        }
                        offset = end + 1
                    }
                    let remaining = chunk.count - offset
                    guard pending.count + remaining <= maximumLineBytes else { return false }
                    if remaining > 0 { pending.append(base.advanced(by: offset).assumingMemoryBound(to: UInt8.self), count: remaining) }
                    return true
                }
                if !complete { return false }
            }
            return pending.isEmpty || body(pending)
        } catch { return false }
    }
    private func sqliteSource(_ source: LocalSessionSource) -> (URL, String)? {
        let tail = String(source.source.dropFirst(7))
        if source.agent == .opencode, let range = tail.range(of: ":ses_", options: .backwards), String(tail[range.lowerBound...].dropFirst()) == source.nativeID { return (URL(fileURLWithPath: String(tail[..<range.lowerBound])), "session") }
        if source.agent == .hermes, let index = tail.lastIndex(of: "#") { return (URL(fileURLWithPath: String(tail[..<index])), "sessions") }
        return nil
    }
    private struct FileStamp: Equatable { var size: UInt64; var modified: Date; var inode: UInt64? }
    private struct IndexID: Decodable { var id: String }
    private struct GrokTitle: Decodable { var generated_title: String? }
    private struct IndexTitle: Decodable { var id: String; var thread_name: String }
    private struct OpenCodeMetadata: Decodable { var id: String; var directory: String; var parentID: String? }
    private struct OpenCodeTitle: Decodable { var title: String? }
    // Never project type, title, summary, message or content during the preflight.
    private struct ClaudeMetadata: Decodable { var cwd: String?; var relocatedCwd: String?; var sessionId: String? }
    private struct TitleMetadata: Decodable { var type: String?; var title: String?; var name: String?; var customTitle: String? }
    private struct ClaudeIndex: Decodable {
        var entries: [Entry]
        struct Entry: Decodable { var sessionId: String; var summary: String? }
    }
}
