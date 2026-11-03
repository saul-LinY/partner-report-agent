import SwiftUI
import WeeklyReportCore

struct ProcessCPUIndicator: View {
    @State private var percentage: Double?

    private var value: String {
        percentage.map { String(format: "%.1f%%", $0) } ?? "--"
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "cpu").frame(width: 16)
            Text("CPU")
            Spacer(minLength: 8)
            Text(value).monospacedDigit().foregroundStyle(Palette.ink)
        }
        .font(.system(size: 12))
        .foregroundStyle(Palette.secondary)
        .frame(height: 20)
        .help("本 App 进程的 CPU 占用率，每秒更新；100% 表示占满一个逻辑核心。")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("App CPU 占用率")
        .accessibilityValue(value)
        .accessibilityIdentifier("app-cpu-usage")
        .task {
            var sampler = ProcessCPUUsageSampler()
            _ = sampler.sample()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) }
                catch { return }
                percentage = sampler.sample()
            }
        }
    }
}
