import XCTest
@testable import WeeklyReportCore

private actor ReviewStub: ReviewServing {
    var batches = DemoRepository.reviewBatches
    var failure: ReviewServiceError?
    var performed: [(CardAction, String, String, Int)] = []
    func login(email: String, password: String) async throws {}
    func logout() async throws {}
    func setFailure(_ error: ReviewServiceError?) { failure = error }
    func replace(_ value: [ReviewBatch]) { batches = value }
    func loadReviews() async throws -> [ReviewBatch] { if let failure { throw failure }; return batches }
    func perform(_ action: CardAction, cardID: String, reviewID: String, version: Int) async throws {
        if let failure { throw failure }
        performed.append((action, cardID, reviewID, version))
        guard let i = batches.firstIndex(where: { $0.id == reviewID }), let j = batches[i].items.firstIndex(where: { $0.id == cardID }) else { return }
        if action == .approve { batches[i].items[j].review_status = "approved" }
        if action == .exclude { batches[i].items[j].review_status = "excluded" }
        batches[i].review.version += 1
    }
}

@MainActor
final class ApprovalsTests: XCTestCase {
    func testProjectDecisionsPersistAndDoNotApproveUnrelatedProjects() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "approvals-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let state = root.appending(path: "state.json")
        let store = AppStore(stateURL: state, live: true)
        try store.registerProject(name: "One", folder: root.appending(path: "one").path)
        try store.registerProject(name: "Two", folder: root.appending(path: "two").path)
        let one = store.pendingProjects[0].id, two = store.pendingProjects[1].id
        store.openApproval(.project(one))
        XCTAssertEqual(store.page, .approvals)
        store.decideProject(one, permission: .allowed)
        XCTAssertEqual(store.selectedApproval, .project(two))
        XCTAssertEqual(store.approvedProjects.map(\.id), [one])
        XCTAssertTrue(store.sessions.isEmpty)
        store.decideProject(two, permission: .denied)
        let next = AppStore(stateURL: state, live: true)
        XCTAssertEqual(next.approvedProjects.map(\.id), [one])
        XCTAssertEqual(next.projects.first { $0.id == two }?.permission, .denied)
        XCTAssertEqual(next.approvalCount, 0)
    }
    func testReminderLedgerSurvivesRelaunchAndNeverApprovesProjects() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "reminders-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let state = root.appending(path: "state.json")
        let store = AppStore(stateURL: state, live: true)
        try store.registerProject(name: "One", folder: root.appending(path: "one").path)
        let keys = Set(store.approvalTargets.map(\.key))
        store.markApprovalsNotified(keys)
        let next = AppStore(stateURL: state, live: true)
        XCTAssertEqual(next.notifiedApprovalKeys, keys)
        XCTAssertEqual(next.pendingProjects.count, 1)
        XCTAssertTrue(next.approvedProjects.isEmpty)
        XCTAssertTrue(ApprovalReminderGroup.groups(targets: next.approvalTargets, notified: next.notifiedApprovalKeys).allSatisfy { $0.freshKeys.isEmpty })
    }
    func testReminderGroupsAggregateByKindAndOnlyIncludeFreshIDs() {
        let targets: [ApprovalTarget] = [.project("/a:folder"), .project("/b"), .card("c")]
        let groups = ApprovalReminderGroup.groups(targets: targets, notified: [targets[0].key])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0].keys.count, 2)
        XCTAssertEqual(groups[0].freshKeys, ["project:/b"])
        XCTAssertEqual(groups[1].freshKeys, ["card:c"])
        XCTAssertEqual(ApprovalTarget(key: targets[0].key), targets[0])
        XCTAssertNil(ApprovalTarget(key: "unknown:secret"))
        XCTAssertTrue(ApprovalReminderGroup.groups(targets: [], notified: []).allSatisfy { $0.keys.isEmpty })
    }
    func testStaleNotificationKeepsItsOriginalKind() {
        let store = AppStore()
        store.openApproval(.card("removed"))
        XCTAssertEqual(store.selectedApproval, .card(store.pendingCards[0].id))
        store.openApproval(.project("removed"))
        XCTAssertEqual(store.selectedApproval, .project("mobile"))
    }
    func testDemoApprovalIsInteractiveWithoutNetwork() async {
        let store = AppStore()
        store.decideProject("mobile", permission: .allowed)
        XCTAssertEqual(store.newProjectCount, 0)
        XCTAssertEqual(store.pendingCards.count, 2)
        await store.performCardAction(.approve, cardID: "demo-card-website")
        XCTAssertEqual(store.pendingCards.count, 1)
    }
    func testFinishingOneApprovalKindDoesNotSwitchToTheOtherKind() async {
        let store = AppStore()
        store.openApproval(.project("mobile"))
        store.decideProject("mobile", permission: .allowed)
        XCTAssertNil(store.selectedApproval)
        XCTAssertEqual(store.pendingCards.count, 2)
        XCTAssertEqual(store.projects.first { $0.id == "mobile" }?.permission, .allowed)
        store.decideProject("mobile", permission: .denied)
        XCTAssertEqual(store.projects.first { $0.id == "mobile" }?.permission, .denied)
        store.decideProject("mobile", permission: .pending)
        store.openApproval(.card("demo-card-website"))
        await store.performCardAction(.approve, cardID: "demo-card-website")
        XCTAssertEqual(store.selectedApproval, .card("demo-card-platform"))
        await store.performCardAction(.exclude, cardID: "demo-card-platform")
        XCTAssertNil(store.selectedApproval)
        XCTAssertEqual(store.pendingProjects.count, 1)
        XCTAssertEqual(store.page, .approvals)
    }
    func testDemoCardRegenerationAndIgnoreAreIsolatedAndRemainVersioned() async {
        let store = AppStore()
        let original = store.pendingCards[0].payload.overview
        await store.performCardAction(.regenerate(" "), cardID: "demo-card-website")
        XCTAssertEqual(store.pendingCards[0].payload.overview, original)
        await store.performCardAction(.regenerate(String(repeating: "x", count: 1001)), cardID: "demo-card-website")
        XCTAssertEqual(store.pendingCards[0].payload.overview, original)
        await store.performCardAction(.regenerate("突出本周验证结果"), cardID: "demo-card-website")
        XCTAssertEqual(store.pendingCards[0].payload.overview, "本地示例修改意见：突出本周验证结果")
        XCTAssertEqual(store.reviewBatches[0].review.version, 2)
        XCTAssertFalse(store.isPerformingReviewAction)
        XCTAssertEqual(store.pendingCards.count, 2)
        await store.performCardAction(.exclude, cardID: "demo-card-website")
        XCTAssertEqual(store.pendingCards.count, 1)
        XCTAssertEqual(store.reviewBatches[0].items[0].review_status, "excluded")
        XCTAssertFalse(store.hasReviewService)
    }
    func testCardDecisionUsesReviewVersionAndRefreshesServerState() async {
        let service = ReviewStub()
        let store = AppStore(live: true, reviewService: service)
        await store.signInForReviews(email: "member@example.test", password: "password")
        XCTAssertEqual(store.pendingCards.count, 2)
        store.openApproval(.card("demo-card-website"))
        await store.performCardAction(.approve, cardID: "demo-card-website")
        XCTAssertEqual(store.pendingCards.map(\.id), ["demo-card-platform"])
        XCTAssertEqual(store.selectedApproval, .card("demo-card-platform"))
        let performed = await service.performed
        XCTAssertEqual(performed.count, 1)
        XCTAssertEqual(performed[0].2, "demo-review")
        XCTAssertEqual(performed[0].3, 1)
        await store.performCardAction(.exclude, cardID: "demo-card-platform")
        let next = await service.performed
        XCTAssertEqual(next[1].3, 2)
        XCTAssertTrue(store.pendingCards.isEmpty)
    }
    func testOfflineActionPreservesPendingCardAndShowsFailure() async {
        let service = ReviewStub()
        let store = AppStore(live: true, reviewService: service)
        await store.signInForReviews(email: "member@example.test", password: "password")
        await service.setFailure(.init(status: 503, message: "offline"))
        await store.performCardAction(.approve, cardID: "demo-card-website")
        XCTAssertEqual(store.pendingCards.count, 2)
        XCTAssertEqual(store.reviewError, "offline")
        XCTAssertFalse(store.isPerformingReviewAction)
    }
    func testExpiredSessionClearsRemoteCardsButNotLocalPendingProjects() async throws {
        let service = ReviewStub()
        let store = AppStore(live: true, reviewService: service)
        try store.registerProject(name: "Local", folder: "/tmp/local-approval")
        await store.signInForReviews(email: "member@example.test", password: "password")
        await service.setFailure(.init(status: 401, message: "登录已过期"))
        await store.refreshReviews()
        XCTAssertFalse(store.isReviewSignedIn)
        XCTAssertTrue(store.pendingCards.isEmpty)
        XCTAssertEqual(store.pendingProjects.count, 1)
        XCTAssertNotNil(store.reviewError)
    }
    func testRegeneratingCardCannotBeApprovedAndInvalidInstructionsAreRejected() async {
        let service = ReviewStub()
        var batches = DemoRepository.reviewBatches
        batches[0].regenerationJobs = [.init(work_item_id: "demo-card-website", status: "PENDING", error_message: nil)]
        await service.replace(batches)
        let store = AppStore(live: true, reviewService: service)
        await store.signInForReviews(email: "member@example.test", password: "password")
        await store.performCardAction(.approve, cardID: "demo-card-website")
        await store.performCardAction(.regenerate(" "), cardID: "demo-card-platform")
        let performed = await service.performed
        XCTAssertTrue(performed.isEmpty)
    }
    func testLiveModeNeverLoadsDemoCardsWithoutService() async {
        let store = AppStore(live: true)
        await store.refreshReviews()
        XCTAssertTrue(store.pendingCards.isEmpty)
        XCTAssertFalse(store.hasReviewService)
    }
}
