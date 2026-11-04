import SwiftUI
import WeeklyReportCore

/// What the app collects, what it hides first, who can see it, and what the member controls.
/// The numbers at the top are live; the rest states how the app actually behaves.
struct PrivacyView: View {
    @EnvironmentObject private var store: AppStore
    @State private var newTerm = ""

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
                    section("上传前，在你的电脑上会先隐藏什么", symbol: "eye.slash", lines: [
                        "密钥、令牌和口令：sk- 开头的密钥、Bearer 令牌、password=… 这样的写法，以及「口令是……」这样写在句子里的口令。",
                        "能识别出你或你的设备的信息：邮箱、手机号、IP 地址、网址和本机文件路径。",
                        "你自己标记的内容（见下方）。",
                        "这些内容在「项目会话」里都会标红，红色就表示「上传时隐藏」，替换成「[已隐藏]」；你本机看到的原文不会被修改。",
                        "标红是自动识别的，你可以随时增减：选中文字右键「隐藏所选内容」新增，在红色上右键「取消隐藏」，上传时就保留原文。",
                        "自动识别只覆盖常见写法，不能保证发现所有隐私信息，请尽量不要把密钥直接贴进对话。",
                    ])
                    hiddenTermsSection
                    section("上传到哪里，谁能看到", symbol: "building.2", lines: [
                        "上传到你绑定的公司周报系统，会话原文会长期保存。公司系统入库前会用同一套规则再检查一遍。",
                        "团队管理员可以在网页后台查看已上传的会话原文（已隐藏的部分看不到），也能看到据此整理出的工作卡片、项目简介和周报。",
                        "整理工作卡片时，会话内容会交给公司配置的 AI 模型。工作卡片需要你审核通过后才会进入团队周报。",
                    ])
                    controls
                    section("已经上传的内容", symbol: "clock.arrow.circlepath", lines: [
                        "之后才生效的设置（不上传某个会话、禁止某个项目、暂停自动上传）不会撤回已经上传的内容。",
                        "调整标红会让相关会话重新上传：新增的红色上传隐藏后的版本，取消的红色上传原文。公司系统里更早的版本不会因此被删除。",
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
                fact("\(store.hiddenTerms.count + store.allowedTerms.count)", "处自己调整的标红")
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

    /// Terms marked by hand: hidden in every session and every later upload until removed.
    private var hiddenTermsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            heading("你对标红的调整", symbol: "highlighter")
            bullet("你新增的红色：在「项目会话」里选中文字，右键选「隐藏所选内容」；也可以在这里直接添加。所有会话里相同的文字都会被隐藏，至少 2 个字。")
            bullet("你取消的红色：自动标红的内容被你取消后，上传时保留原文，会列在下方，可以随时恢复。")
            HStack(spacing: 8) {
                TextField("要隐藏的文字，例如客户名、内部项目代号", text: $newTerm)
                    .textFieldStyle(.plain).font(.system(size: 13)).padding(.horizontal, 10).frame(height: 32)
                    .background(.white, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
                    .onSubmit(addTerm).accessibilityIdentifier("hidden-term-field")
                Button("添加", action: addTerm).buttonStyle(QuietButtonStyle())
                    .disabled(newTerm.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                    .accessibilityIdentifier("hidden-term-add")
            }.padding(.leading, 28)
            if store.hiddenTerms.isEmpty {
                Text("还没有标记。").font(.system(size: 12)).foregroundStyle(Palette.secondary).padding(.leading, 28)
            } else {
                VStack(spacing: 0) {
                    ForEach(store.hiddenTerms, id: \.self) { term in
                        HStack(spacing: 10) {
                            Text(term).font(.system(size: 13)).lineLimit(2).textSelection(.enabled)
                            Spacer(minLength: 8)
                            Button("移除") { store.unhideTerm(term) }.buttonStyle(QuietButtonStyle(compact: true))
                                .help("之后的上传不再隐藏这段文字；已上传的内容不会改变")
                        }.padding(.vertical, 8)
                        Rule()
                    }
                }.padding(.leading, 28).accessibilityIdentifier("hidden-term-list")
            }
            if !store.allowedTerms.isEmpty {
                Text("已取消隐藏（上传时保留原文）").font(.system(size: 12, weight: .semibold)).padding(.leading, 28).padding(.top, 6)
                VStack(spacing: 0) {
                    ForEach(store.allowedTerms, id: \.self) { term in
                        HStack(spacing: 10) {
                            Text(term).font(.system(size: 13)).lineLimit(2).textSelection(.enabled)
                            Spacer(minLength: 8)
                            Button("恢复隐藏") { store.restoreAutomatic(term) }.buttonStyle(QuietButtonStyle(compact: true))
                                .help("这段文字重新按自动规则处理；符合规则的话上传时会被隐藏")
                        }.padding(.vertical, 8)
                        Rule()
                    }
                }.padding(.leading, 28).accessibilityIdentifier("allowed-term-list")
            }
        }
    }

    private func addTerm() {
        store.hideTerm(newTerm)
        newTerm = ""
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            heading("你可以决定", symbol: "hand.raised")
            bullet("哪些项目可以被采集：随时在「待审批项」里允许或禁止。")
            bullet("某个会话不上传：在「项目会话」里选中会话，点「不上传此会话」，也可以随时恢复。")
            bullet("某段文字上传不上传：在「项目会话」里，选中文字右键「隐藏所选内容」，或在红色上右键「取消隐藏」；在上方列表里可以撤销。")
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
