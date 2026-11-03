import Foundation
import WeeklyReportCore

/// Exercises the installed framework/reader and existing test state after the UI first-run checks.
@main
struct InstalledSmoke {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 else { fatalError("usage: installed-smoke app-path state.json report-directory") }
        let app = URL(fileURLWithPath: args[1])
        let state = URL(fileURLWithPath: args[2])
        let output = URL(fileURLWithPath: args[3])
        let fm = FileManager.default
        try fm.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let executable = app.appending(path: "Contents/Resources/cc-session-reader")
        let reader = LocalReader(executable: executable, workingDirectory: output.appending(path: "reader-work"))
        let store = AppStore(stateURL: state, live: true, reader: reader, metadataReader: executable)
        let savedPrefs = store.preferences
        let savedApprovals = Set(store.approvedProjects.map(\.id))
        let savedRecords = store.uploadRecords.count
        guard !savedApprovals.isEmpty else { fatalError("UI did not approve test projects") }
        await store.refreshDiscovery()
        guard Set(store.approvedProjects.map(\.id)) == savedApprovals else { fatalError("Approvals changed on restart") }
        guard store.sessions.allSatisfy({ savedApprovals.contains($0.projectID) }) else { fatalError("Unapproved project visible") }
        let agents = Set(store.sessions.map(\.agent))
        var sampled: [[String: Any]] = []
        for agent in Agent.allCases where agents.contains(agent) {
            guard let session = store.sessions.first(where: { $0.agent == agent }) else { continue }
            store.selectProject(session.projectID); store.selectedAgent = agent; store.reconcileSelection(); store.selectSession(session.id)
            await store.loadSelectedSession()
            let turns = store.selectedSession?.turns ?? []
            sampled.append(["agent": agent.id, "turns": turns.count, "finalAnswers": turns.filter { $0.answer != nil }.count, "error": store.readerError ?? ""])
        }
        let start = Date()
        await store.runLocalUpload()
        let firstRecords = store.uploadRecords.count
        await store.runLocalUpload()
        guard store.uploadRecords.count == firstRecords else { fatalError("Unchanged discovery snapshot staged twice") }
        guard store.sessions.allSatisfy({ !$0.uploaded }) else { fatalError("Local preparation marked data uploaded") }
        let outbox = state.deletingLastPathComponent().appending(path: "outbox")
        let files = try fm.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        var queued = 0, turns = 0
        for file in files {
            let sessions = try JSONDecoder().decode([AgentSession].self, from: Data(contentsOf: file))
            guard sessions.allSatisfy({ savedApprovals.contains($0.projectID) && !$0.uploaded && !$0.turns.isEmpty }) else { fatalError("Invalid queued project or payload") }
            let mode = (try fm.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue
            guard mode == 0o600 else { fatalError("Queue file permissions incorrect") }
            queued += sessions.count; turns += sessions.reduce(0) { $0 + $1.turns.count }
        }
        let restarted = AppStore(stateURL: state, live: true, reader: reader, metadataReader: executable)
        guard restarted.preferences == savedPrefs, Set(restarted.approvedProjects.map(\.id)) == savedApprovals,
              restarted.uploadRecords.count == store.uploadRecords.count else { fatalError("Restart lost settings/approvals/records") }
        // Test revocation on a private copy, preserving the user's test approvals.
        let isolated = output.appending(path: "revocation-state.json")
        try fm.copyItem(at: state, to: isolated)
        let revoked = AppStore(stateURL: isolated, live: true, reader: reader, metadataReader: executable)
        for project in revoked.approvedProjects { revoked.decideProject(project.id, permission: .denied) }
        await revoked.refreshDiscovery()
        guard revoked.approvedProjects.isEmpty && revoked.sessions.isEmpty else { fatalError("Revocation did not hide bodies") }
        let summary: [String: Any] = ["installedApp": app.path, "approvedProjects": savedApprovals.count, "discoveredProjects": store.projects.count,
            "visibleSessions": store.sessions.count, "sampledAgents": sampled, "queueFiles": files.count, "queuedSessionVersions": queued,
            "queuedTurns": turns, "recordsBeforeRestartCheck": savedRecords, "recordsAfterSourceRefresh": firstRecords,
            "repeatUnchangedSnapshotNoDuplicates": true, "settingsApprovalsAndRecordsSurviveRestart": true,
            "revocationHidesSessions": true, "allQueuedStatusesRemainPending": store.uploadRecords.allSatisfy { $0.status == .queued },
            "noSessionMarkedUploaded": true, "prepareAndRepeatSeconds": Date().timeIntervalSince(start), "networkUploadImplemented": false,
            "sourceIssues": store.discoveryIssues, "readerFailures": Array(Set(store.sessionReadErrors.values)).sorted()]
        let data = try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
        let report = output.appending(path: "summary.json")
        try data.write(to: report); try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: report.path)
        print(String(decoding: data, as: UTF8.self))
    }
}
