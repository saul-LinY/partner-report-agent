import AppKit
import Darwin
import WeeklyReportCore

@main
enum BackgroundSupervisor {
    @MainActor static func main() async {
        // Resolve our installed bundle without relying on launchd's working directory or argv[0].
        var count: UInt32 = 0
        _NSGetExecutablePath(nil, &count)
        var bytes = [CChar](repeating: 0, count: Int(count))
        guard _NSGetExecutablePath(&bytes, &count) == 0 else { return }
        let executable = bytes.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        let app = URL(fileURLWithPath: executable).resolvingSymlinksInPath()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        guard app.pathExtension == "app", Bundle(url: app)?.bundleIdentifier == BackgroundRuntime.appBundleID else { return }
        while !Task.isCancelled {
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: BackgroundRuntime.appBundleID)
            if running.isEmpty, BackgroundRuntime.shouldRestart() {
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = false
                configuration.addsToRecentItems = false
                configuration.arguments = ["--background-service"]
                do { _ = try await NSWorkspace.shared.openApplication(at: app, configuration: configuration) }
                catch { NSLog("weekly report background: collector launch will retry") }
            }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
        }
    }
}
