import XCTest
@testable import WeeklyReportCore

private actor PersonalDataCollector: CollectorServing {
    var requests = 0
    var delayFirst = false
    var failure: (any Error)?
    var pages: [PersonalData] = []
    func setDelayFirst(_ value: Bool) { delayFirst = value }
    func setFailure(_ error: (any Error)?) { failure = error }
    func setPages(_ value: [PersonalData]) { pages = value }
    func claim(binding: LocalBinding, code: String) async throws -> CollectorClaim {
        CollectorClaim(deviceId: "device", name: binding.name, policy: CollectorPolicy(version: 1, entries: [], currentPeriod: nil))
    }
    func policy(binding: LocalBinding) async throws -> CollectorPolicy { CollectorPolicy(version: 1, entries: [], currentPeriod: nil) }
    func decide(binding: LocalBinding, version: Int, scopeKey: String, permission: ProjectPermission) async throws -> CollectorPolicy { try await policy(binding: binding) }
    func register(binding: LocalBinding, scopeKey: String, name: String, periodKey: String, sessionCount: Int) async throws -> CollectorPolicy { try await policy(binding: binding) }
    func upload(binding: LocalBinding, package: CollectorPackage) async throws {}
    func logs(binding: LocalBinding, events: [CollectorLog]) async throws {}
    func personalData(binding: LocalBinding) async throws -> PersonalData {
        requests += 1
        let index = requests - 1
        if delayFirst && index == 0 { try await Task.sleep(for: .milliseconds(200)) }
        if let failure { throw failure }
        return pages.indices.contains(index) ? pages[index] : DemoRepository.personalData(now: Date(timeIntervalSince1970: 1_793_000_000))
    }
}

@MainActor
final class PersonalDataStoreTests: XCTestCase {
    private func boundStore(_ service: PersonalDataCollector) async -> AppStore {
        let store = AppStore(live: true, collectorService: service)
        await store.bindCollector(LocalBinding(serviceAddress: "https://company.example", name: "Member"), code: "ANY")
        return store
    }
    private func page(member: String) -> PersonalData {
        var data = DemoRepository.personalData(now: Date(timeIntervalSince1970: 1_793_000_000))
        data.member.name = member
        return data
    }

    func testFailedRefreshKeepsWhatIsOnScreen() async {
        let service = PersonalDataCollector()
        let store = await boundStore(service)
        await store.loadPersonalData()
        let shown = store.personalData
        await service.setFailure(URLError(.notConnectedToInternet))
        await store.loadPersonalData()
        XCTAssertEqual(store.personalData, shown)
        XCTAssertNotNil(store.personalDataError)
        XCTAssertFalse(store.isLoadingPersonalData)
    }

    func testSlowEarlierAnswerDoesNotReplaceTheNewestOne() async {
        let service = PersonalDataCollector()
        await service.setPages([page(member: "旧"), page(member: "新")])
        await service.setDelayFirst(true)
        let store = await boundStore(service)
        async let slow: Void = store.loadPersonalData()
        try? await Task.sleep(for: .milliseconds(50))
        await store.loadPersonalData()
        await slow
        XCTAssertEqual(store.personalData?.member.name, "新")
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
}
