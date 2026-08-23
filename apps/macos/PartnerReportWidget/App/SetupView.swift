import SwiftUI
import WidgetKit

@MainActor
final class SetupModel: ObservableObject {
    @Published var serverURL = SharedStore.shared.serverURL ?? ""
    @Published var bindingCode = ""
    @Published var isConnecting = false
    @Published var errorMessage: String?

    func connect() async -> Bool {
        isConnecting = true
        errorMessage = nil
        defer { isConnecting = false }
        do {
            try await WidgetAPIClient().bind(serverURL: serverURL, bindingCode: bindingCode)
            bindingCode = ""
            WidgetCenter.shared.reloadAllTimelines()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}

struct SetupView: View {
    @StateObject private var model = SetupModel()
    let onConnected: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 14) {
                    Image("WorkDashboardIcon").resizable().scaledToFit().frame(width: 50, height: 50)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("工作看板").font(.title2.weight(.semibold))
                        Text("连接这台 Mac 的 Codex 插件").foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 14) {
                    TextField("中台地址", text: $model.serverURL, prompt: Text("https://report.example.com"))
                    SecureField("绑定码", text: $model.bindingCode)
                }
                .textFieldStyle(.roundedBorder)

                if let message = model.errorMessage {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.red)
                }
                HStack {
                    Spacer()
                    Button {
                        Task { if await model.connect() { onConnected() } }
                    } label: {
                        if model.isConnecting { ProgressView().controlSize(.small) }
                        else { Label("连接", systemImage: "link") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isConnecting || model.serverURL.isEmpty || model.bindingCode.isEmpty)
                }
            }
            .frame(width: 430)
            .padding(34)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}
