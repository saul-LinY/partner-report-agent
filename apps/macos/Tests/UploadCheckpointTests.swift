import XCTest
@testable import WeeklyReportCore

final class UploadCheckpointTests: XCTestCase {
    func testNewAnswerAndEditedAnswerRemainPending() {
        let prompt = ChatTurn(id: "one", prompt: "Question", answer: nil, questionTime: "10:00")
        let receipt = UploadCheckpoint(turns: [prompt])
        let answered = ChatTurn(id: "one", prompt: "Question", answer: "Answer", questionTime: "10:00")
        XCTAssertEqual(receipt.pendingMessages(in: [answered]).map(\.id), ["one:answer"])
        let complete = UploadCheckpoint(turns: [answered])
        XCTAssertTrue(complete.pendingMessages(in: [answered]).isEmpty)
        let edited = ChatTurn(id: "one", prompt: "Question", answer: "Revised answer", questionTime: "10:00")
        XCTAssertEqual(complete.pendingMessages(in: [edited]).map(\.text), ["Revised answer"])
    }

    func testNewTurnPreservesPreviousUploadBoundary() {
        let first = ChatTurn(id: "first", prompt: "First", answer: "Done", questionTime: "10:00")
        let receipt = UploadCheckpoint(turns: [first])
        let next = ChatTurn(id: "next", prompt: "Another task", answer: "New answer", questionTime: "11:00")
        XCTAssertEqual(receipt.pendingMessages(in: [first, next]).map(\.id), ["next:prompt", "next:answer"])
        XCTAssertTrue(receipt.contains(UploadCheckpoint.messages(in: [first])[1]))
    }

    func testTimelineKeepsMessagesAndPlacesBoundaryBeforeNewAnswer() {
        let prompt = ChatTurn(id: "one", prompt: "Question", answer: nil, questionTime: "10:00")
        let answered = ChatTurn(id: "one", prompt: "Question", answer: "Answer", questionTime: "10:00")
        let timeline = ConversationTimeline(turns: [answered], checkpoint: UploadCheckpoint(turns: [prompt]))
        XCTAssertEqual(timeline.messages, UploadCheckpoint.messages(in: [answered]))
        XCTAssertEqual(timeline.uploadBoundaryID, "one:answer")
        XCTAssertNil(ConversationTimeline(turns: [answered], checkpoint: nil).uploadBoundaryID)
        XCTAssertNil(ConversationTimeline(turns: [answered], checkpoint: UploadCheckpoint(turns: [answered])).uploadBoundaryID)
    }

    func testTimelineDoesNotShowUploadBoundaryWhenEveryMessageIsNew() {
        let old = ChatTurn(id: "old", prompt: "Previous question", answer: "Previous answer", questionTime: "10:00")
        let new = ChatTurn(id: "new", prompt: "New question", answer: "New answer", questionTime: "11:00")
        let checkpoint = UploadCheckpoint(turns: [old])
        XCTAssertNil(ConversationTimeline(turns: [new], checkpoint: checkpoint).uploadBoundaryID)
        XCTAssertEqual(ConversationTimeline(turns: [old, new], checkpoint: checkpoint).uploadBoundaryID, "new:prompt")
    }
}

@MainActor
final class LocalConfigurationTests: XCTestCase {
    func testPreviewBindingNeverAuthenticatesLiveApp() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "local-binding-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appending(path: "state.json")
        let first = AppStore(stateURL: url)
        XCTAssertFalse(first.saveBinding(.init(serviceAddress: "not-a-url", name: "Person")))
        XCTAssertTrue(first.saveBinding(.init(serviceAddress: "https://company.example", name: " Person ")))
        let second = AppStore(stateURL: url)
        XCTAssertEqual(second.binding.name, "Person")
        XCTAssertTrue(second.binding.matchesSavedConfiguration(.init(serviceAddress: "https://company.example", name: " Person ")))
        XCTAssertFalse(second.binding.matchesSavedConfiguration(.init(serviceAddress: "https://company.example", name: "Other")))
        XCTAssertFalse(second.binding.matchesSavedConfiguration(.init(serviceAddress: "https://another.example", name: "Person")))
        XCTAssertFalse(second.binding.isBound)
        XCTAssertFalse(AppStore(live: true).saveBinding(second.binding))
        XCTAssertFalse(second.isReviewSignedIn)
        XCTAssertTrue(second.preferences.launchAtLogin)
        XCTAssertTrue(second.preferences.keepInMenuBar)
    }

    func testChangedFolderRequiresFreshPermissionAndRejectsDuplicate() throws {
        let store = AppStore(live: true)
        try store.registerProject(name: "First", folder: "/tmp/weekly-first")
        try store.registerProject(name: "Second", folder: "/tmp/weekly-second")
        let first = try XCTUnwrap(store.projects.first { $0.name == "First" })
        store.decideProject(first.id, permission: .allowed)
        XCTAssertThrowsError(try store.changeProjectFolder(first.id, to: "/tmp/weekly-second"))
        try store.changeProjectFolder(first.id, to: "/tmp/weekly-third")
        XCTAssertTrue(store.approvedProjects.isEmpty)
        XCTAssertEqual(store.projects.first { $0.name == "First" }?.permission, .pending)
    }
}
