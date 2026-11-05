import SwiftUI
import AppKit
import WeeklyReportCore

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var updates: AppUpdater
    @EnvironmentObject private var notifications: ApprovalNotifications
    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: AppFont.width(208))
            Rectangle().fill(Palette.line).frame(width: 1)
            VStack(spacing: 0) {
                if notifications.authorization == .denied && !store.appMessages.isEmpty {
                    HStack {
                        Label("macOS 通知未开启，提醒正在等待投递。", systemImage: "bell.slash").font(.app(size: 12))
                        Spacer()
                        Button("打开通知设置") { notifications.openSettings() }
                    }.foregroundStyle(Palette.red).padding(12)
                    Rule()
                }
                if let error = store.storageError ?? store.connectionError ?? store.logUploadError {
                    Label(error, systemImage: "exclamationmark.circle").font(.app(size: 12)).foregroundStyle(Palette.red).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    Rule()
                }
                Group {
                    switch store.page {
                    case .approvals: ApprovalsView()
                    case .sessions: SessionsView()
                    case .uploads: UploadsView()
                    case .privacy: PrivacyView()
                    case .settings: SettingsView()
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.foregroundStyle(Palette.ink).background(.white).frame(minWidth: 1040, minHeight: 680)
        .overlay(alignment: .topTrailing) {
            VStack(spacing: 10) {
                ForEach(notifications.banners) { message in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "bell.badge.fill").font(.app(size: 20)).foregroundStyle(Palette.green).padding(.top, 2)
                        Button { notifications.openBanner(message) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(message.title).font(.app(size: 14, weight: .semibold))
                                Text(message.body).font(.app(size: 12)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain)
                        Button { notifications.dismissBanner(message.id) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain).help("关闭提醒").accessibilityLabel("关闭 \(message.title)")
                    }.padding(16).frame(width: 350).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
                        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
                        .accessibilityIdentifier("app-notification-banner")
                }
            }.padding(18)
        }
        .onChange(of: store.selectedAgent) { _, _ in store.reconcileSelection() }
        .onChange(of: store.uploadFilter) { _, _ in store.reconcileSelection() }
        .task(id: "\(store.selectedSessionID ?? ""):\(store.sourceRevision)") { await store.loadSelectedSession() }
    }
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 12) {
                Image("WeeklyReportMark").resizable().scaledToFit().frame(width: 38, height: 42)
                Text("weekly report").font(.app(size: 18, weight: .bold)).fixedSize()
            }.frame(maxWidth: .infinity).padding(.horizontal, 20).padding(.top, 48).padding(.bottom, 28)
            VStack(spacing: 6) {
                ForEach(AppPage.allCases) { page in
                    Button { store.page = page } label: {
                        HStack(spacing: 12) {
                            Image(systemName: page.symbol).font(.app(size: 18)).frame(width: 22)
                            Text(page.title).font(.app(size: 14, weight: store.page == page ? .semibold : .regular))
                            Spacer(minLength: 0)
                            if page == .approvals, store.approvalCount > 0 {
                                Text("\(store.approvalCount)").font(.app(size: 11, weight: .medium)).monospacedDigit().frame(minWidth: 20, minHeight: 20).background(Palette.ink.opacity(0.05), in: Circle())
                            }
                        }.padding(.horizontal, 12).frame(height: 44)
                            .background(store.page == page ? Palette.selected : .clear, in: RoundedRectangle(cornerRadius: 6)).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("navigation-\(page.rawValue)")
                        .accessibilityAddTraits(store.page == page ? .isSelected : [])
                }
            }.padding(.horizontal, 10)
            Spacer()
            ProcessCPUIndicator().padding(.horizontal, 20).padding(.bottom, 12)
            Rule().padding(.horizontal, 16)
            HStack(spacing: 9) {
                Image(systemName: "person.crop.circle.fill").font(.app(size: 31)).foregroundStyle(Palette.secondary.opacity(0.5))
                VStack(alignment: .leading, spacing: 4) {
                    Text(store.binding.isBound && !store.binding.name.isEmpty ? store.binding.name : "本机用户")
                        .font(.app(size: 12, weight: .medium)).lineLimit(1).truncationMode(.tail)
                        .accessibilityIdentifier("sidebar-user-name")
                    Text(store.hasCollectorService ? (store.binding.isBound ? "已绑定系统" : "未绑定") : "本地演示").font(.app(size: 10)).foregroundStyle(Palette.secondary)
                }
                Spacer(minLength: 0)
                if updates.isInstalling {
                    ProgressView().controlSize(.small).frame(width: 52, height: 26)
                        .help("正在更新").accessibilityLabel("正在更新")
                } else if updates.available != nil {
                    Button("New") { updates.installNow() }
                        .buttonStyle(UpdateBadgeButtonStyle())
                        .help("立即更新").accessibilityLabel("有新版本，立即更新")
                        .accessibilityIdentifier("check-for-updates")
                }
            }.padding(.horizontal, 16).padding(.vertical, 20)
        }.background(Palette.quiet)
    }
}
