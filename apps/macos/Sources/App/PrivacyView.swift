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
                VStack(alignment: .leading, spacing: 16) {
                    yourSettings
                    pair(uploadedScope, whoCanSee)
                    hiddenBeforeUpload
                    hiddenTermsSection
                    pair(controls, afterUpload)
                }.padding(.horizontal, 28).padding(.vertical, 24).frame(maxWidth: 1040, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.background(Palette.quiet)
        }
    }

    // MARK: Live summary

    private var yourSettings: some View {
        HStack(spacing: 12) {
            stat("\(store.approvedProjects.count)", "个项目允许采集", symbol: "folder.badge.checkmark", tint: Palette.green)
            stat("\(store.excludedSessionCount)", "个会话不上传", symbol: "eye.slash", tint: Palette.secondary)
            stat("\(store.hiddenTerms.count + store.allowedTerms.count)", "处自己调整的标红", symbol: "highlighter", tint: Palette.red)
            stat(store.preferences.autoUpload ? "开启" : "暂停", "自动上传", symbol: "icloud.and.arrow.up", tint: store.preferences.autoUpload ? Palette.green : Palette.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("privacy-summary")
    }

    private func stat(_ value: String, _ label: String, symbol: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            icon(symbol, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(value).font(.app(size: 21, weight: .semibold)).monospacedDigit().lineLimit(1)
                Text(label).font(.app(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 14).frame(maxWidth: .infinity)
        .background(.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.line))
    }

    // MARK: Sections

    private var uploadedScope: some View {
        card("哪些内容会被上传", symbol: "tray.and.arrow.up") {
            bullet("只有你「允许采集」的项目。没有允许的项目，App 不会读取其中的会话正文。")
            bullet("上传的是你的提问和 AI 的正式回复这两类文字，不包括 AI 的执行过程、思考和中间说明。")
            bullet("不是每次打开就上传：按「系统设置」里的上传安排自动上传，或由你点「立即上传」。")
        }
    }

    private var whoCanSee: some View {
        card("上传到哪里，谁能看到", symbol: "building.2") {
            bullet("上传到你绑定的公司周报系统，会话原文会长期保存。公司系统入库前会用同一套规则再检查一遍。")
            bullet("团队管理员可以在网页后台查看已上传的会话原文（已隐藏的部分看不到），也能看到据此整理出的工作卡片、项目简介和周报。")
            bullet("整理工作卡片时，会话内容会交给公司配置的 AI 模型。工作卡片需要你审核通过后才会进入团队周报。")
        }
    }

    private var hiddenBeforeUpload: some View {
        card("上传前，在你的电脑上会先隐藏什么", symbol: "eye.slash", tint: Palette.red) {
            HStack(spacing: 8) {
                Text("红色").font(.app(size: 12, weight: .semibold)).foregroundStyle(Palette.red)
                    .padding(.horizontal, 8).padding(.vertical, 2).background(Palette.red.opacity(0.12), in: Capsule())
                Text("就表示「上传时隐藏」：在「项目会话」里标红，上传时替换成「[已隐藏]」；你本机看到的原文不会被修改。")
                    .font(.app(size: 13)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: 0) {
                rule("密钥、令牌和口令", "sk- 开头的密钥、Bearer 令牌、password=… 这样的写法，以及「口令是……」这样写在句子里的口令。", symbol: "key")
                Rule()
                rule("你或你设备的信息", "邮箱、手机号、IP 地址、网址和本机文件路径。", symbol: "person.text.rectangle")
                Rule()
                rule("你自己标记的内容", "见下方「你对标红的调整」。", symbol: "highlighter")
            }
            .background(Palette.quiet, in: RoundedRectangle(cornerRadius: 10))
            bullet("标红是自动识别的，你可以随时增减：选中文字右键「隐藏所选内容」新增，在红色上右键「取消隐藏」，上传时就保留原文。")
            note("自动识别只覆盖常见写法，不能保证发现所有隐私信息，请尽量不要把密钥直接贴进对话。")
        }
    }

    /// Terms marked by hand: hidden in every session and every later upload until removed.
    private var hiddenTermsSection: some View {
        card("你对标红的调整", symbol: "highlighter", tint: Palette.red) {
            bullet("你新增的红色：在「项目会话」里选中文字，右键选「隐藏所选内容」；也可以在这里直接添加。所有会话里相同的文字都会被隐藏，至少 2 个字。")
            bullet("你取消的红色：自动标红的内容被你取消后，上传时保留原文，会列在下方，可以随时恢复。")
            HStack(spacing: 8) {
                TextField("要隐藏的文字，例如客户名、内部项目代号", text: $newTerm)
                    .textFieldStyle(.plain).font(.app(size: 13)).padding(.horizontal, 12).frame(height: 36)
                    .background(Palette.quiet, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.line))
                    .onSubmit(addTerm).accessibilityIdentifier("hidden-term-field")
                Button("添加", action: addTerm).buttonStyle(QuietButtonStyle())
                    .disabled(newTerm.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)
                    .accessibilityIdentifier("hidden-term-add")
            }
            termList(title: "已隐藏的文字", terms: store.hiddenTerms, empty: "还没有标记。", action: "移除",
                     help: "之后的上传不再隐藏这段文字；已上传的内容不会改变", identifier: "hidden-term-list") { store.unhideTerm($0) }
            if !store.allowedTerms.isEmpty {
                termList(title: "已取消隐藏（上传时保留原文）", terms: store.allowedTerms, empty: "", action: "恢复隐藏",
                         help: "这段文字重新按自动规则处理；符合规则的话上传时会被隐藏", identifier: "allowed-term-list") { store.restoreAutomatic($0) }
            }
        }
    }

    private var controls: some View {
        card("你可以决定", symbol: "hand.raised") {
            bullet("哪些项目可以被采集：随时在「待审批项」里允许或禁止。")
            bullet("某个会话不上传：在「项目会话」里选中会话，点「不上传此会话」，也可以随时恢复。")
            bullet("某段文字上传不上传：在「项目会话」里，选中文字右键「隐藏所选内容」，或在红色上右键「取消隐藏」；在上方列表里可以撤销。")
            bullet("是否自动上传：在「系统设置」的「自动上传」里暂停。")
            HStack(spacing: 10) {
                Button("管理项目") { store.page = .approvals }.buttonStyle(QuietButtonStyle())
                Button("查看会话") { store.page = .sessions }.buttonStyle(QuietButtonStyle())
                Button("上传设置") { store.settingsTab = .upload; store.page = .settings }.buttonStyle(QuietButtonStyle())
            }.padding(.top, 2)
        }
    }

    private var afterUpload: some View {
        card("已经上传的内容", symbol: "clock.arrow.circlepath") {
            bullet("之后才生效的设置（不上传某个会话、禁止某个项目、暂停自动上传）不会撤回已经上传的内容。")
            bullet("调整标红会让相关会话重新上传：新增的红色上传隐藏后的版本，取消的红色上传原文。公司系统里更早的版本不会因此被删除。")
            bullet("已上传的内容仍保存在公司系统中，需要删除请联系团队管理员。")
        }
    }

    // MARK: Pieces

    private func addTerm() {
        store.hideTerm(newTerm)
        newTerm = ""
    }

    /// Two cards side by side when the window is wide enough, stacked otherwise.
    private func pair<A: View, B: View>(_ first: A, _ second: B) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 16) {
                first.frame(idealWidth: 420, maxWidth: .infinity)
                second.frame(idealWidth: 420, maxWidth: .infinity)
            }
            VStack(alignment: .leading, spacing: 16) { first; second }
        }
    }

    private func card<Content: View>(_ title: String, symbol: String, tint: Color = Palette.ink, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                icon(symbol, tint: tint)
                SectionTitle(title: title)
            }
            content()
        }
        .padding(20).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.line))
    }

    private func icon(_ symbol: String, tint: Color) -> some View {
        Image(systemName: symbol).font(.app(size: 14, weight: .semibold)).foregroundStyle(tint)
            .frame(width: 32, height: 32).background(tint.opacity(0.11), in: RoundedRectangle(cornerRadius: 9))
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Circle().fill(Palette.secondary.opacity(0.55)).frame(width: 4, height: 4).offset(y: -2)
            Text(text).font(.app(size: 13)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// One kind of text that is hidden, named on the left and described on the right.
    private func rule(_ name: String, _ detail: String, symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Label { Text(name).font(.app(size: 13, weight: .semibold)) } icon: { Image(systemName: symbol).font(.app(size: 12)).foregroundStyle(Palette.red) }
                .frame(width: AppFont.width(150), alignment: .leading)
            Text(detail).font(.app(size: 13)).foregroundStyle(Palette.ink.opacity(0.8)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }.padding(.horizontal, 14).padding(.vertical, 11)
    }

    private func note(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle").font(.app(size: 13)).foregroundStyle(Palette.ink.opacity(0.7))
            Text(text).font(.app(size: 13)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14).padding(.vertical, 11).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.selected, in: RoundedRectangle(cornerRadius: 10))
    }

    private func termList(title: String, terms: [String], empty: String, action: String, help: String, identifier: String, perform: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.app(size: 12, weight: .semibold)).foregroundStyle(Palette.secondary)
            if terms.isEmpty {
                Text(empty).font(.app(size: 12)).foregroundStyle(Palette.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(terms.enumerated()), id: \.element) { index, term in
                        if index > 0 { Rule() }
                        HStack(spacing: 10) {
                            Text(term).font(.app(size: 13)).lineLimit(2).textSelection(.enabled)
                            Spacer(minLength: 8)
                            Button(action) { perform(term) }.buttonStyle(QuietButtonStyle(compact: true)).help(help)
                        }.padding(.horizontal, 14).padding(.vertical, 8)
                    }
                }
                .background(Palette.quiet, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityIdentifier(identifier)
            }
        }
    }
}
