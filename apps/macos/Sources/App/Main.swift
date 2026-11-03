import AppKit
import SwiftUI
import ServiceManagement
import WeeklyReportCore

@main
enum Main {
    @MainActor static func main() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--background-service-status") {
            let state = SMAppService.agent(plistName: BackgroundRuntime.plistName).status
            print("backgroundServiceStatus=\(state.rawValue)")
            print("restartAllowed=\(BackgroundRuntime.shouldRestart())")
            return
        }
        if args.contains("--disable-background-service") {
            let service = BackgroundService()
            print("backgroundServiceStopped=\(service.disable())")
            return
        }
        if args.contains("--demo") {
            WeeklyReportApp.main()
            return
        }
        do {
            guard let lease = try ProcessLease.acquire(at: BackgroundRuntime.folder.appending(path: "collector.lock")) else {
                if !args.contains("--background-service") {
                    DistributedNotificationCenter.default().postNotificationName(
                        .init(BackgroundRuntime.showWindowNotification), object: nil, userInfo: nil, deliverImmediately: true)
                }
                return
            }
            BackgroundRuntime.clearUpdatePause()
            withExtendedLifetime(lease) { WeeklyReportApp.main() }
        } catch {
            NSLog("weekly report: unable to acquire collector process lease")
        }
    }
}
