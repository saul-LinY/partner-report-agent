import AppIntents
import WidgetKit

struct RefreshQueueIntent: AppIntent {
    static var title: LocalizedStringResource = "刷新工作状态"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        do { _ = try await WidgetAPIClient().fetchQueue() }
        catch { SharedStore.shared.lastError = error.localizedDescription }
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}
