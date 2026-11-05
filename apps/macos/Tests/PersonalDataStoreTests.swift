import XCTest
@testable import WeeklyReportCore

private actor PersonalDataCollector: CollectorServing {
    var requestedMonths: [String?] = []
    var delayed: Set<String> = []
    var failure: (any Error)?
    func setDelayed(_ months: Set<String>) { delayed = months }
    func setFailure(_ error: (any Error)?) { failure = error }
    func claim(binding: LocalBinding, code: String) async throws -> CollectorClaim {
        CollectorClaim(deviceId: "device", name: binding.name, policy: CollectorPolicy(version: 1, entries: [], currentPeriod: nil))
    }
    func policy(binding: LocalBinding) async throws -> CollectorPolicy { CollectorPolicy(version: 1, entries: [], currentPeriod: nil) }
    func decide(binding: LocalBinding, version: Int, scopeKey: String, permission: ProjectPermission) async throws -> CollectorPolicy { try await policy(binding: binding) }
    func register(binding: LocalBinding, scopeKey: String, name: String, periodKey: String, sessionCount: Int) async throws -> CollectorPolicy { try await policy(binding: binding) }
    func upload(binding: LocalBinding, package: CollectorPackage) async throws {}
    func logs(binding: LocalBinding, events: [CollectorLog]) async throws {}
    func personalData(binding: LocalBinding, month: String?) async throws -> PersonalData {
        requestedMonths.append(month)
        if let month, delayed.contains(month) { try await Task.sleep(for: .milliseconds(200)) }
        if let failure { throw failure }
        return DemoRepository.personalData(month: month ?? "2026-11", now: Date(timeIntervalSince1970: 1_793_000_000))
    }
}

@MainActor
final class PersonalDataStoreTests: XCTestCase {
    private func boundStore(_ service: PersonalDataCollector) async -> AppStore {
        let store = AppStore(live: true, collectorService: service)
        await store.bindCollector(LocalBinding(serviceAddress: "https://company.example", name: "Member"), code: "ANY")
        return store
    }

    func testMonthPagingRequestsThatMonthAndKeepsDataOnFailure() async {
        let service = PersonalDataCollector()
        let store = await boundStore(service)
        await store.loadPersonalData()
        await store.loadPersonalData(month: "2026-10")
        let requested = await service.requestedMonths
        XCTAssertEqual(requested, [nil, "2026-10"])
        XCTAssertEqual(store.personalData?.calendar.month, "2026-10")

        await service.setFailure(URLError(.notConnectedToInternet))
        await store.loadPersonalData(month: "2026-09")
        XCTAssertEqual(store.personalData?.calendar.month, "2026-10", "a failed page change keeps what is on screen")
        XCTAssertNotNil(store.personalDataError)
        XCTAssertFalse(store.isLoadingPersonalData)
    }

    func testSlowAnswerForAnEarlierMonthDoesNotReplaceTheNewestRequest() async {
        let service = PersonalDataCollector()
        await service.setDelayed(["2026-09"])
        let store = await boundStore(service)
        async let slow: Void = store.loadPersonalData(month: "2026-09")
        try? await Task.sleep(for: .milliseconds(50))
        await store.loadPersonalData(month: "2026-10")
        await slow
        XCTAssertEqual(store.personalData?.calendar.month, "2026-10")
        XCTAssertFalse(store.isLoadingPersonalData)
    }

    func testRevokedBindingClearsThePersonalData() async {
        let service = PersonalDataCollector()
        let store = await boundStore(service)
        await store.loadPersonalData()
        XCTAssertNotNil(store.personalData)
        await service.setFailure(CollectorError(status: 401, message: "绑定凭据无效或已被撤销。"))
        await store.loadPersonalData()
        XCTAssertNil(store.personalData)
        XCTAssertEqual(store.startupStage, .binding)
    }

    func testDemoStoreServesSampleDataForAnyMonth() async {
        let store = AppStore()
        await store.loadPersonalData(month: "2026-02")
        XCTAssertEqual(store.personalData?.calendar.month, "2026-02")
        XCTAssertNil(store.personalDataError)
    }
}
