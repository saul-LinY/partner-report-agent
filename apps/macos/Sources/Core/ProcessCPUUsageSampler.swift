import Darwin
import Foundation

public struct ProcessCPUUsageSampler: Sendable {
    private var previous: (cpuSeconds: Double, uptime: Double)?

    public init() {}

    public mutating func sample() -> Double? {
        var usage = rusage()
        guard getrusage(RUSAGE_SELF, &usage) == 0 else {
            previous = nil
            return nil
        }
        let cpuSeconds = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
            + Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
        return record(cpuSeconds: cpuSeconds, uptime: ProcessInfo.processInfo.systemUptime)
    }

    mutating func record(cpuSeconds: Double, uptime: Double) -> Double? {
        guard cpuSeconds.isFinite, uptime.isFinite, cpuSeconds >= 0 else {
            previous = nil
            return nil
        }
        defer { previous = (cpuSeconds, uptime) }
        guard let previous, uptime > previous.uptime, cpuSeconds >= previous.cpuSeconds else { return nil }
        // Keep per-core percentages, including values above 100% for parallel work.
        return (cpuSeconds - previous.cpuSeconds) / (uptime - previous.uptime) * 100
    }
}
