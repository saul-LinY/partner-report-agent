import Foundation
import WeeklyReportCore

/// Reuses the App's discovery and reader, sampling only projects already allowed in its state.
/// Writes counts and errors, never prompts, replies, titles or source paths.
@main
struct AgentAudit {
    private struct LocalState: Decodable {
        var preferences: AppPreferences
        var registeredProjects: [Project]
        var liveProjects: [Project]?
    }
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 || (args.count == 5 && args[4] == "--all") else { fatalError("usage: audit-agents reader-binary existing-state.json output-directory [--all]") }
        let all = args.count == 5
        let state = try JSONDecoder().decode(LocalState.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
        let projects = state.liveProjects ?? state.registeredProjects
        let allowed = Set(projects.filter { $0.permission == .allowed && !$0.isDemo }.map { AppStore.normalizedFolder($0.folder) })
        let snapshot = LocalDiscovery(registeredRoots: projects.map(\.folder), pathOverrides: state.preferences.agentPaths, metadataReader: URL(fileURLWithPath: args[1])).scan()
        let output = URL(fileURLWithPath: args[3], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let reader = LocalReader(executable: URL(fileURLWithPath: args[1]), workingDirectory: output.appending(path: "reader-work"))
        let groups = Dictionary(grouping: snapshot.sessions, by: \.groupID)
        var rows: [[String: Any]] = []
        for agent in Agent.allCases {
            let found = groups.values.filter { $0.first?.agent == agent }
            let approved = found.filter { $0.first.map { allowed.contains($0.projectRoot) } == true }
                .sorted { ($0.first?.modifiedAt ?? .distantPast) > ($1.first?.modifiedAt ?? .distantPast) }
            let sample = Array(approved.prefix(all ? approved.count : 3))
            var read = 0, empty = 0, turns = 0, answers = 0, errors: [String] = []
            for sources in sample {
                guard let root = sources.first?.projectRoot, allowed.contains(root) else { fatalError("Unapproved audit source") }
                do {
                    let result = try await reader.read(sources: sources, authorizedRoot: root)
                    if result.turns.isEmpty { empty += 1 } else { read += 1 }
                    turns += result.turns.count
                    answers += result.turns.filter { $0.answer != nil }.count
                    errors += result.warnings
                } catch { errors.append(error.localizedDescription) }
            }
            let row: [String: Any] = ["id": agent.id, "name": agent.name,
                "discoveryStatus": snapshot.agentStatus[agent] ?? "未扫描",
                "implementationLimitation": agent.readingLimitation ?? "已接通已知来源格式，仍有版本／独立存储限制",
                "discoveredSessions": found.count, "allowedSessions": approved.count,
                "sampledSessions": sample.count, "readableSamples": read, "emptySamples": empty,
                "questionTurns": turns, "finalAnswers": answers, "errors": Array(Set(errors)).sorted()]
            rows.append(row)
            print("\(agent.name): discovered=\(found.count), allowed=\(approved.count), sampled=\(sample.count), readable=\(read), turns=\(turns), final=\(answers), errors=\(errors.count)")
            fflush(stdout)
        }
        let report: [String: Any] = ["date": ISO8601DateFormatter().string(from: .now),
            "method": all ? "All authorized sessions; same discovery/reader as app; no remote requests" : "Latest up to three authorized sessions per agent; same discovery/reader as app; no remote requests",
            "allowedProjectCount": allowed.count, "discoveryIssues": snapshot.issues, "agents": rows,
            "detectedLocations": snapshot.locations.filter(\.exists).map { ["agent": $0.agent.id, "path": $0.sessionPath, "origin": $0.origin] }]
        let file = output.appending(path: "summary.json")
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
