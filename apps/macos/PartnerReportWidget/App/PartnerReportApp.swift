import SwiftUI

@main
struct PartnerReportApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
            .defaultSize(width: 1080, height: 720)
            .windowResizability(.contentMinSize)
    }
}

struct RootView: View {
    @State private var isConnected = SharedStore.shared.credentials != nil

    var body: some View {
        Group {
            if isConnected {
                WorkspaceView(onDisconnect: { isConnected = false })
            } else {
                SetupView(onConnected: { isConnected = true })
            }
        }
        .frame(minWidth: 840, minHeight: 580)
    }
}
