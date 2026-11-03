import Foundation

public struct AgentLocation: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case codex, transcript, database, openCodeJSON, grok, brain }
    public var agent: Agent
    public var agentDirectory: String
    public var sessionPath: String
    public var origin: String
    public var kind: Kind
    public var exists: Bool
}

/// Resolves known configuration locations without running a shell, client or model.
/// Only directory fields are decoded; credentials and conversation text are never projected.
public struct SourceLocations: Sendable {
    public var home: URL
    public var overrides: [String: String]
    public var environment: [String: String]
    public var remembered: [AgentLocation]
    public init(home: URL, overrides: [String: String] = [:], environment: [String: String] = ProcessInfo.processInfo.environment, remembered: [AgentLocation] = []) {
        self.home = home; self.overrides = overrides; self.environment = environment; self.remembered = remembered
    }
    private struct SwitchSettings: Decodable {
        var codexConfigDir: String?; var claudeConfigDir: String?; var piConfigDir: String?
        var ompConfigDir: String?; var hermesConfigDir: String?; var grokConfigDir: String?
        var opencodeConfigDir: String?
    }
    private struct PiSettings: Decodable { var sessionDir: String? }
    private struct AppPaths: Decodable { var app_config_dir_override: String? }
    public func resolve() -> (locations: [AgentLocation], issues: [String]) {
        let fm = FileManager.default
        var locations: [AgentLocation] = [], issues: [String] = [], seen: Set<String> = []
        func path(_ raw: String, relativeTo base: URL? = nil) -> URL {
            if raw == "~" { return home }
            if raw.hasPrefix("~/") { return home.appending(path: String(raw.dropFirst(2))).standardizedFileURL }
            return (raw.hasPrefix("/") ? URL(fileURLWithPath: raw) : (base ?? home).appending(path: raw)).standardizedFileURL
        }
        func env(_ key: String) -> String? { environment[key].flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 } }
        func add(_ agent: Agent, _ agentDir: URL, _ session: URL, _ origin: String, _ kind: AgentLocation.Kind) {
            guard !SessionSourcePolicy.isArchived(session.path) else { return }
            let actual = session.resolvingSymlinksInPath()
            guard seen.insert("\(agent.id):\(kind.rawValue):\(actual.path)").inserted else { return }
            locations.append(.init(agent: agent, agentDirectory: agentDir.resolvingSymlinksInPath().path, sessionPath: actual.path, origin: origin, kind: kind, exists: fm.fileExists(atPath: actual.path)))
        }
        func children(_ folder: URL) -> [URL] {
            ((try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isDirectoryKey])) ?? [])
                .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }.sorted { $0.path < $1.path }
        }
        func settings<T: Decodable>(_ type: T.Type, _ file: URL) -> T? {
            guard fm.fileExists(atPath: file.path) else { return nil }
            do {
                let decoder = JSONDecoder(); decoder.allowsJSON5 = true
                return try decoder.decode(type, from: Data(contentsOf: file))
            } catch { issues.append("目录配置无法读取：\(file.path)"); return nil }
        }
        let switchHome = home.appending(path: ".cc-switch")
        var switchDataRoots = [switchHome]
        let appPaths = home.appending(path: "Library/Application Support/com.ccswitch.desktop/app_paths.json")
        if let custom = settings(AppPaths.self, appPaths)?.app_config_dir_override, !custom.isEmpty {
            let actual = path(custom)
            if fm.fileExists(atPath: actual.path) { switchDataRoots.insert(actual, at: 0) }
        }
        let ccs = settings(SwitchSettings.self, switchHome.appending(path: "settings.json"))
        let ompContext = environment["OMP_PROFILE"] != nil || environment["PI_PROFILE"] != nil || env("PI_CONFIG_DIR") != nil
        let sharedAgent = env("PI_CODING_AGENT_DIR").map { path($0).path }
        let knownOMP = sharedAgent.map { $0.hasPrefix(home.appending(path: ".omp").path + "/") || $0 == ccs?.ompConfigDir } ?? false
        func roots(_ agent: Agent, _ defaultRoot: String, _ envKey: String?, _ imported: String?) -> [(URL, String)] {
            var candidates: [(URL, String)] = []
            if let raw = overrides[agent.id], !raw.isEmpty { candidates.append((path(raw), "手动配置")) }
            if let envKey, let value = env(envKey) {
                let raw = envKey == "HERMES_HOME" ? value.trimmingCharacters(in: .whitespacesAndNewlines) : value
                if raw.hasPrefix("/") || (envKey != "HERMES_HOME" && raw.hasPrefix("~/")) { candidates.append((path(raw), envKey)) }
                else { issues.append("\(agent.name)：\(envKey) 需要启动目录上下文，请配置绝对路径。") }
            }
            if let imported, !imported.isEmpty { candidates.append((path(imported), "CC Switch 配置")) }
            candidates.append((home.appending(path: defaultRoot), "默认目录"))
            return candidates
        }
        for (base, origin) in roots(.codex, ".codex", "CODEX_HOME", ccs?.codexConfigDir) {
            let isSessions = ["sessions", "archived_sessions"].contains(base.lastPathComponent)
            let config = isSessions ? base.deletingLastPathComponent() : base
            let direct = origin == "手动配置" && !isSessions && !fm.fileExists(atPath: base.appending(path: "sessions").path) && !fm.fileExists(atPath: base.appending(path: "config.toml").path) && base.lastPathComponent != ".codex"
            add(.codex, config, direct || isSessions ? base : base.appending(path: "sessions"), origin, .codex)
        }
        for (base, origin) in roots(.claude, ".claude", "CLAUDE_CONFIG_DIR", ccs?.claudeConfigDir) {
            let direct = base.lastPathComponent == "projects" || (origin == "手动配置" && !fm.fileExists(atPath: base.appending(path: "projects").path) && base.lastPathComponent != ".claude")
            add(.claude, direct ? base.deletingLastPathComponent() : base, direct ? base : base.appending(path: "projects"), origin, .transcript)
        }
        for root in switchDataRoots {
            for account in children(root.appending(path: "claude-accounts")) where account.lastPathComponent.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil {
                let config = account.appending(path: "config")
                add(.claude, config, config.appending(path: "projects"), "CC Switch 多账号", .transcript)
            }
        }
        // Pi's sessionDir is native configuration; an explicit reader session directory also applies.
        for (base, origin) in roots(.pi, ".pi/agent", ompContext || knownOMP ? nil : "PI_CODING_AGENT_DIR", ccs?.piConfigDir) {
            let direct = base.lastPathComponent == "sessions" || (origin == "手动配置" && !fm.fileExists(atPath: base.appending(path: "sessions").path) && !fm.fileExists(atPath: base.appending(path: "settings.json").path) && base.lastPathComponent != "agent")
            let agentDir = direct ? base.deletingLastPathComponent() : base
            add(.pi, agentDir, direct ? base : base.appending(path: "sessions"), origin, .transcript)
            if let custom = settings(PiSettings.self, agentDir.appending(path: "settings.json"))?.sessionDir, !custom.isEmpty {
                if custom.hasPrefix("/") || custom.hasPrefix("~/") { add(.pi, agentDir, path(custom), "Pi settings.json", .transcript) }
                else { issues.append("Pi：相对 sessionDir 需要对应启动项目的上下文，请配置实际会话目录。") }
            }
        }
        if let raw = env("PI_CODING_AGENT_SESSION_DIR") {
            if raw.hasPrefix("/") || raw.hasPrefix("~/") {
                let session = path(raw)
                let isOMP = ompContext || knownOMP || session.path.hasPrefix(home.appending(path: ".omp").path + "/")
                add(isOMP ? .omp : .pi, session.deletingLastPathComponent(), session, "PI_CODING_AGENT_SESSION_DIR", .transcript)
            } else { issues.append("Pi／Oh My Pi：相对会话目录需要启动项目的上下文，请配置实际会话目录。") }
        }
        var ompRoots = roots(.omp, ".omp/agent", ompContext || knownOMP ? "PI_CODING_AGENT_DIR" : nil, ccs?.ompConfigDir)
        let configName = env("PI_CONFIG_DIR") ?? ".omp"
        let ompConfig = home.appending(path: configName.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        ompRoots.append((ompConfig.appending(path: "agent"), "PI_CONFIG_DIR"))
        for profileRoot in [home.appending(path: ".omp/profiles"), ompConfig.appending(path: "profiles")] {
            ompRoots += children(profileRoot).map { ($0.appending(path: "agent"), "OMP profile") }
        }
        if let xdg = env("XDG_DATA_HOME") {
            let data = path(xdg).appending(path: "omp")
            ompRoots.append((data, "XDG_DATA_HOME"))
            ompRoots += children(data.appending(path: "profiles")).map { ($0, "OMP XDG profile") }
        }
        for (base, origin) in ompRoots {
            let direct = base.lastPathComponent == "sessions" || (origin == "手动配置" && !fm.fileExists(atPath: base.appending(path: "sessions").path) && base.lastPathComponent != "agent")
            add(.omp, direct ? base.deletingLastPathComponent() : base, direct ? base : base.appending(path: "sessions"), origin, .transcript)
        }
        var opencode = roots(.opencode, ".local/share/opencode", nil, nil)
        if let xdg = env("XDG_DATA_HOME") { opencode.append((path(xdg).appending(path: "opencode"), "XDG_DATA_HOME")) }
        let data = env("XDG_DATA_HOME").map { path($0).appending(path: "opencode") } ?? home.appending(path: ".local/share/opencode")
        if let database = env("OPENCODE_DB") { opencode.insert((path(database, relativeTo: data), "OPENCODE_DB"), at: 0) }
        for (base, origin) in opencode {
            var directoryFlag: ObjCBool = false
            let isExistingFile = fm.fileExists(atPath: base.path, isDirectory: &directoryFlag) && !directoryFlag.boolValue
            let isDB = origin == "OPENCODE_DB" || isExistingFile || ["db", "sqlite", "sqlite3"].contains(base.pathExtension)
            let root = isDB ? base.deletingLastPathComponent() : base
            add(.opencode, root, isDB ? base : root.appending(path: "opencode.db"), origin, .database)
            add(.opencode, root, root.lastPathComponent == "storage" ? root : root.appending(path: "storage"), origin, .openCodeJSON)
        }
        // opencodeConfigDir changes configuration, not its XDG session data directory.
        for (base, origin) in roots(.hermes, ".hermes", "HERMES_HOME", ccs?.hermesConfigDir) {
            var directoryFlag: ObjCBool = false
            let isFile = fm.fileExists(atPath: base.path, isDirectory: &directoryFlag) && !directoryFlag.boolValue
            let root = base.lastPathComponent == "sessions" || isFile || base.lastPathComponent == "state.db" ? base.deletingLastPathComponent() : base
            add(.hermes, root, isFile ? base : root.appending(path: "state.db"), origin, .database)
            add(.hermes, root, root.appending(path: "sessions"), origin, .transcript)
            for profile in children(root.appending(path: "profiles")) {
                add(.hermes, profile, profile.appending(path: "state.db"), "Hermes profile", .database)
                add(.hermes, profile, profile.appending(path: "sessions"), "Hermes profile", .transcript)
            }
        }
        for (base, origin) in roots(.grokbuild, ".grok", nil, ccs?.grokConfigDir) {
            let direct = ["sessions", "archived_sessions"].contains(base.lastPathComponent) || (origin == "手动配置" && !fm.fileExists(atPath: base.appending(path: "sessions").path) && base.lastPathComponent != ".grok")
            let root = direct ? base.deletingLastPathComponent() : base
            add(.grokbuild, root, direct ? base : root.appending(path: "sessions"), origin, .grok)
        }
        var agy = [(home.appending(path: ".gemini"), "默认目录")]
        for root in switchDataRoots { agy += children(root.appending(path: "agy")).map { ($0, "CC Switch profile") } }
        if let raw = overrides[Agent.agy.id] { agy.insert((path(raw), "手动配置"), at: 0) }
        for (base, origin) in agy {
            if base.lastPathComponent == "brain" { add(.agy, base.deletingLastPathComponent(), base, origin, .brain) }
            else if ["antigravity", "antigravity-cli"].contains(base.lastPathComponent) { add(.agy, base, base.appending(path: "brain"), origin, .brain) }
            else { for name in ["antigravity", "antigravity-cli"] { add(.agy, base.appending(path: name), base.appending(path: "\(name)/brain"), origin, .brain) } }
        }
        for location in remembered where fm.fileExists(atPath: location.sessionPath) {
            add(location.agent, URL(fileURLWithPath: location.agentDirectory), URL(fileURLWithPath: location.sessionPath), "上次发现", location.kind)
        }
        return (locations, issues)
    }

    /// Only the root sqlite_home string is inspected, never model or credential configuration.
    public static func codexDatabaseDirectories(agentDirectory: URL, home: URL, environment: [String: String]) -> [URL] {
        var result = [agentDirectory]
        var override = environment["CODEX_SQLITE_HOME"]
        if let text = try? String(contentsOf: agentDirectory.appending(path: "config.toml"), encoding: .utf8) {
            var multiline: String?
            for line in text.components(separatedBy: .newlines) {
                let value = line.trimmingCharacters(in: .whitespaces)
                if let delimiter = multiline {
                    if unescapedDelimiter(delimiter, in: value) != nil { multiline = nil }
                    continue
                }
                if value.hasPrefix("#") { continue }
                if value.hasPrefix("[") { break }
                guard let equal = value.firstIndex(of: "=") else { continue }
                let tail = value[value.index(after: equal)...].trimmingCharacters(in: .whitespaces)
                if let delimiter = ["\"\"\"", "'''"].first(where: { tail.hasPrefix($0) }) {
                    if unescapedDelimiter(delimiter, in: String(tail.dropFirst(3))) == nil { multiline = delimiter }
                    continue
                }
                guard value[..<equal].trimmingCharacters(in: .whitespaces) == "sqlite_home" else { continue }
                if tail.hasPrefix("'"), let end = tail.dropFirst().firstIndex(of: "'") { override = String(tail[tail.index(after: tail.startIndex)..<end]) }
                else if tail.hasPrefix("\""), let regex = try? NSRegularExpression(pattern: #"^"(?:\\.|[^"\\])*""#), let match = regex.firstMatch(in: tail, range: NSRange(tail.startIndex..., in: tail)), let range = Range(match.range, in: tail), let bytes = String(tail[range]).data(using: .utf8) { override = try? JSONDecoder().decode(String.self, from: bytes) }
                break
            }
        }
        if let raw = override?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
            if raw.hasPrefix("~/") { result.append(home.appending(path: String(raw.dropFirst(2)))) }
            else if raw.hasPrefix("/") { result.append(URL(fileURLWithPath: raw)) }
        }
        var seen: Set<String> = []
        return result.map { $0.resolvingSymlinksInPath() }.filter { seen.insert($0.path).inserted }
    }
    private static func unescapedDelimiter(_ delimiter: String, in value: String) -> Range<String.Index>? {
        var start = value.startIndex
        while start < value.endIndex, let range = value.range(of: delimiter, range: start..<value.endIndex) {
            if delimiter == "'''" { return range }
            var index = range.lowerBound, slashes = 0
            while index > value.startIndex {
                index = value.index(before: index)
                guard value[index] == "\\" else { break }
                slashes += 1
            }
            if slashes % 2 == 0 { return range }
            start = range.upperBound
        }
        return nil
    }
}
