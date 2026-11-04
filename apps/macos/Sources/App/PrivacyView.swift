import SwiftUI
import WeeklyReportCore

/// What the app collects, what it removes first, who can see it, and what the member controls.
/// The numbers at the top are live; the rest states how the app actually behaves.
struct PrivacyView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 0) {
            PageHeading(title: "隐私说明") {}
            Rule()
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    yourSettings
                    section("哪些内容会被上传", symbol: "tray.and.arrow.up", lines: [
                        "只有你「允许采集」的项目。没有允许的项目，App 不会读取其中的会话正文。",
                        "上传的是你的提问和 AI 的正式回复这两类文字，不包括 AI 的执行过程、思考和中间说明。",
                        "不是每次打开就上传：按「系统设置」里的上传安排自动上传，或由你点「立即上传」。",
                    ])
                    section("上传前，在你的电脑上会先处理什么", symbol: "key.viewfinder", lines: [
                        "对话里的密钥、令牌和口令会先替换成「[已隐藏]」再上传，例如 sk- 开头的密钥、Bearer 令牌、password=… 这样的写法，以及「口令是……」这样写在句子里的口令。",
                        "其他内容按原样上传，包括网址、IP 地址、本地文件路径和邮箱。",
                        "这个处理只能识别常见写法，不能保证发现所有凭证，请尽量不要把密钥直接贴进对话。",
                    ])
                    section("上传到哪里，谁能看到", symbol: "building.2", lines: [
                        "上传到你绑定的公司周报系统，会话原文会长期保存。",
                        "团队管理员可以在网页后台查看已上传的会话原文，也能看到据此整理出的工作卡片、项目简介和周报。",
                        "整理工作卡片时，会话内容会交给公司配置的 AI 模型。工作卡片需要你审核通过后才会进入团队周报。",
                    ])
                    controls
                    section("已经上传的内容", symbol: "clock.arrow.circlepath", lines: [
                        "之后才生效的设置（不上传某个会话、禁止某个项目、暂停自动上传）不会撤回已经上传的内容。",
                        "已上传的内容仍保存在公司系统中，需要删除请联系团队管理员。",
                    ])
                }.padding(.horizontal, 28).padding(.vertical, 26).frame(maxWidth: 760, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var yourSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(title: "你现在的设置")
            HStack(spacing: 0) {
                fact("\(store.approvedProjects.count)", "个项目允许采集")
                Rectangle().fill(Palette.line).frame(width: 1, height: 40)
                fact("\(store.excludedSessionCount)", "个会话不上传")
                Rectangle().fill(Palette.line).frame(width: 1, height: 40)
                fact(store.preferences.autoUpload ? "开启" : "暂停", "自动上传")
            }
            .padding(.vertical, 14).background(Palette.quiet, in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("privacy-summary")
        }
    }

    private func fact(_ value: String, _ label: String) -> some View {
        VStack(spacing: 4) {
            Text(value).font(.system(size: 22, weight: .semibold)).monospacedDigit()
            Text(label).font(.system(size: 12)).foregroundStyle(Palette.secondary)
        }.frame(maxWidth: .infinity)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            heading("你可以决定", symbol: "hand.raised")
            bullet("哪些项目可以被采集：随时在「待审批项」里允许或禁止。")
            bullet("某个会话不上传：在「项目会话」里选中会话，点「不上传此会话」，也可以随时恢复。")
            bullet("是否自动上传：在「系统设置」的「自动上传」里暂停。")
            HStack(spacing: 10) {
                Button("管理项目") { store.page = .approvals }.buttonStyle(QuietButtonStyle())
                Button("查看会话") { store.page = .sessions }.buttonStyle(QuietButtonStyle())
                Button("上传设置") { store.settingsTab = .upload; store.page = .settings }.buttonStyle(QuietButtonStyle())
            }.padding(.top, 4)
        }
    }

    private func section(_ title: String, symbol: String, lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            heading(title, symbol: symbol)
            ForEach(lines, id: \.self) { bullet($0) }
        }
    }

    private func heading(_ title: String, symbol: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 15)).frame(width: 20).foregroundStyle(Palette.secondary)
            SectionTitle(title: title)
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(Palette.secondary.opacity(0.6)).frame(width: 4, height: 4).offset(y: -2)
            Text(text).font(.system(size: 13)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        }.padding(.leading, 28)
    }
}
