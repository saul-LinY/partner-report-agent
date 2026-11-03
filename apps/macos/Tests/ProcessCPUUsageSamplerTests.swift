import XCTest
@testable import WeeklyReportCore

final class ProcessCPUUsageSamplerTests: XCTestCase {
    func testUsesElapsedTimeAndSupportsMoreThanOneCore() throws {
        var sampler = ProcessCPUUsageSampler()
        XCTAssertNil(sampler.record(cpuSeconds: 10, uptime: 100))
        XCTAssertEqual(try XCTUnwrap(sampler.record(cpuSeconds: 10.5, uptime: 102)), 25, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(sampler.record(cpuSeconds: 13, uptime: 103)), 250, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(sampler.record(cpuSeconds: 13, uptime: 104)), 0, accuracy: 0.001)
    }

    func testResetsBaselineForInvalidOrRegressingSamples() throws {
        var sampler = ProcessCPUUsageSampler()
        XCTAssertNil(sampler.record(cpuSeconds: 2, uptime: 10))
        XCTAssertNil(sampler.record(cpuSeconds: 2, uptime: 10))
        XCTAssertNil(sampler.record(cpuSeconds: 1, uptime: 11))
        XCTAssertEqual(try XCTUnwrap(sampler.record(cpuSeconds: 1.5, uptime: 12)), 50, accuracy: 0.001)
        XCTAssertNil(sampler.record(cpuSeconds: .nan, uptime: 13))
        XCTAssertNil(sampler.record(cpuSeconds: 2, uptime: 14))
        XCTAssertEqual(try XCTUnwrap(sampler.record(cpuSeconds: 2.1, uptime: 15)), 10, accuracy: 0.001)
    }

    func testReadsCurrentProcessCounters() throws {
        var sampler = ProcessCPUUsageSampler()
        XCTAssertNil(sampler.sample())
        let usage = try XCTUnwrap(sampler.sample())
        XCTAssertTrue(usage.isFinite)
        XCTAssertGreaterThanOrEqual(usage, 0)
    }
}
