import Foundation
import WeeklyReportCore

@main
struct LocalSmoke {
    @MainActor
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 else { fatalError("usage: smoke reader-binary authorized-project output-directory") }
        let project = AppStore.normalizedFolder(args[2])
        let output = URL(fileURLWithPath: args[3], isDirectory: true)
        let reader = LocalReader(executable: URL(fileURLWithPath: args[1]), workingDirectory: output.appending(path: "reader-work"))
        let store = AppStore(stateURL: output.appending(path: "state.json"), live: true, reader: reader, authorizedRoots: [project], metadataReader: URL(fileURLWithPath: args[1]))
        await store.refreshDiscovery()
        guard store.projects.contains(where: { $0.folder == project && $0.permission == .allowed }) else { fatalError("Authorized project not discovered") }
        guard store.approvedProjects.count == 1 else { fatalError("Unexpected project approval") }
        guard store.sessions.allSatisfy({ $0.projectID == project }) else { fatalError("Unapproved session in visible list") }
        let count = store.sessions.count
        await store.loadSelectedSession()
        guard let session = store.selectedSession, !session.turns.isEmpty else { fatalError("Selected source failed to load: \(store.readerError ?? "no turns")") }
        await store.runLocalUpload()
        guard !store.uploadRecords.isEmpty, store.uploadRecords.allSatisfy({ $0.status == .queued }) else { fatalError("Local queue was not written") }
        guard store.sessions.allSatisfy({ !$0.uploaded }) else { fatalError("Local staging incorrectly marked data uploaded") }
        let records = store.uploadRecords.count
        await store.runLocalUpload()
        guard store.uploadRecords.count == records else { fatalError("Unchanged records staged twice") }
        let queue = try FileManager.default.contentsOfDirectory(at: output.appending(path: "outbox"), includingPropertiesForKeys: nil)
        var storedSessions: [AgentSession] = []
        for file in queue { storedSessions += try JSONDecoder().decode([AgentSession].self, from: Data(contentsOf: file)) }
        guard !storedSessions.isEmpty, storedSessions.allSatisfy({ $0.projectID == project && !$0.turns.isEmpty }) else { fatalError("Outbox contains unexpected projects or empty bodies") }
        let fresh = AppStore(stateURL: output.appending(path: "state.json"), live: true, reader: reader)
        guard fresh.approvedProjects.map(\.id) == [project] else { fatalError("Approval did not persist") }
        fresh.decideProject(project, permission: .denied)
        guard fresh.approvedProjects.isEmpty, fresh.sessions.isEmpty else { fatalError("Revocation failed") }
        let summary: [String: Any] = [
            "realProjectsDiscovered": store.projects.count,
            "authorizedProjects": store.approvedProjects.count,
            "authorizedSessions": count,
            "queuedSessions": storedSessions.count,
            "queuedTurns": storedSessions.reduce(0) { $0 + $1.turns.count },
            "queuedFiles": queue.count,
            "repeatStagingNoDuplicates": store.uploadRecords.count == records,
            "noSessionMarkedUploaded": store.sessions.allSatisfy { !$0.uploaded },
            "localApprovalPersists": true,
            "revocationHidesSessions": true,
            "networkRequests": 0,
            "sourceIssues": store.discoveryIssues,
            "readerFailures": store.sessionReadErrors.values.sorted(),
        ]
        let bytes = try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
        try bytes.write(to: output.appending(path: "summary.json"))
        print(String(decoding: bytes, as: UTF8.self))
    }
}
