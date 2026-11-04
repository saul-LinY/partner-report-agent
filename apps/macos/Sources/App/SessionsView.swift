import SwiftUI
import AppKit
import WeeklyReportCore

struct SessionsView: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        VStack(spacing: 0) {
            PageHeading(title: "项目会话") {
                if !store.isLive { Text("示例会话").font(.system(size: 11)).foregroundStyle(Palette.secondary) }
            }
            HStack(spacing: 10) {
                projectMenu.frame(width: 190)
                agentMenu.frame(width: 155)
                searchField.frame(width: 170)
                Text("\(store.visibleSessions.count) 个会话").font(.system(size: 11)).foregroundStyle(Palette.secondary).padding(.leading, 4)
                Spacer(minLength: 0)
                ViewThatFits {
                    Label("已归档内容不扫描、不上传", systemImage: "checkmark.shield").font(.system(size: 11)).foregroundStyle(Palette.secondary)
                    Image(systemName: "checkmark.shield").foregroundStyle(Palette.secondary).help("已归档内容不扫描、不上传")
                }
            }.padding(.horizontal, 28).padding(.bottom, 16)
            Rule()
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        Text("会话").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                        Spacer()
                        FilterTab(title: "全部", selected: store.uploadFilter == .all) { store.uploadFilter = .all }
                        FilterTab(title: "未上传", selected: store.uploadFilter == .pending) { store.uploadFilter = .pending }
                        FilterTab(title: "不上传", selected: store.uploadFilter == .excluded) { store.uploadFilter = .excluded }
                    }.padding(.horizontal, 14)
                    Rule()
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(store.visibleSessions) { session in sessionRow(session) }
                            if store.visibleSessions.isEmpty {
                                EmptyMessage(symbol: "bubble.left", title: emptyTitle, subtitle: "").frame(height: 220)
                            }
                        }
                    }
                }.frame(width: 295)
                Rectangle().fill(Palette.line).frame(width: 1)
                Group {
                    if store.loadingSessionID == store.selectedSessionID, store.selectedSessionID != nil {
                        ProgressView("正在读取会话…").font(.system(size: 12)).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if let error = store.readerError {
                        VStack {
                            EmptyMessage(symbol: "exclamationmark.circle", title: "暂时无法读取", subtitle: error)
                            Button("重试") { Task { await store.loadSelectedSession() } }.buttonStyle(QuietButtonStyle()).padding(.bottom, 28)
                        }
                    } else if let session = store.selectedSession {
                        VStack(spacing: 0) {
                            uploadBar(session)
                            Rule()
                            if session.turns.isEmpty {
                                EmptyMessage(symbol: "bubble.left.and.text.bubble.right", title: "此会话暂无可显示的问答", subtitle: "")
                            } else {
                                ChatView(session: session, checkpoint: store.uploadCheckpoints[session.id]).equatable()
                            }
                        }
                    } else {
                        VStack {
                            EmptyMessage(symbol: "bubble.left.and.text.bubble.right", title: store.approvedProjects.isEmpty ? "先允许一个项目" : "选择会话查看内容", subtitle: "")
                            if store.approvedProjects.isEmpty {
                                Button("查看待审批项") { store.page = .approvals }.buttonStyle(YellowButtonStyle()).padding(.bottom, 28)
                            }
                        }
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
    private var projectMenu: some View {
        Menu {
            ForEach(store.approvedProjects) { project in
                Button { store.selectProject(project.id) } label: {
                    if store.selectedProjectID == project.id { Label(project.name, systemImage: "checkmark") } else { Text(project.name) }
                }
            }
            if let project = store.approvedProjects.first(where: { $0.id == store.selectedProjectID }) {
                Divider()
                Button("禁止此项目采集") { store.decideProject(project.id, permission: .denied) }
            }
        } label: {
            HStack { Image(systemName: "folder"); Text(store.projectName(store.selectedProjectID).isEmpty ? "选择项目" : store.projectName(store.selectedProjectID)).lineLimit(1).truncationMode(.middle); Spacer(minLength: 3); Image(systemName: "chevron.down").font(.system(size: 10)) }
                .font(.system(size: 13)).padding(.horizontal, 10).frame(height: 34)
        }.menuStyle(.borderlessButton).menuIndicator(.visible).buttonStyle(.plain).frame(maxWidth: .infinity).frame(height: 34).background(.white, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line)).accessibilityIdentifier("project-filter")
    }
    private var agentMenu: some View {
        AgentFilterMenu(selection: $store.selectedAgent, counts: Agent.allCases.map { store.count(for: $0) })
            .padding(.horizontal, 7).frame(maxWidth: .infinity).frame(height: 34).background(.white, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line)).accessibilityIdentifier("agent-filter")
    }
    private func sessionRow(_ session: AgentSession) -> some View {
        Button { store.selectSession(session.id) } label: {
            VStack(alignment: .leading, spacing: 10) {
                Text(session.title).font(.system(size: 14, weight: .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                HStack(spacing: 7) { AgentIcon(agent: session.agent, size: 17); Text(session.agent.name).font(.system(size: 12)).foregroundStyle(Palette.secondary) }
                HStack {
                    Text(session.turns.isEmpty ? session.updatedLabel : "\(session.updatedLabel) · \(session.turns.count) 轮").font(.system(size: 11)).foregroundStyle(Palette.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    StatusLabel(text: statusText(session), color: statusColor(session), size: 6)
                }
            }.padding(.horizontal, 18).padding(.vertical, 18).frame(maxWidth: .infinity, alignment: .leading)
                .background(session.id == store.selectedSessionID ? Palette.selected : .white)
                .overlay(alignment: .leading) { if session.id == store.selectedSessionID { Rectangle().fill(Palette.yellow).frame(width: 3) } }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("session-\(session.id)").overlay(alignment: .bottom) { Rule() }
            .contextMenu {
                let excluded = store.uploadState(of: session) == .excluded
                Button(excluded ? "恢复上传" : "不上传此会话") { store.setUploadExcluded(!excluded, for: session.id) }
            }
    }
    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Palette.secondary)
            TextField("搜索会话", text: $store.query).textFieldStyle(.plain).font(.system(size: 13))
            if !store.query.isEmpty {
                Button { store.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.secondary) }
                    .buttonStyle(.plain).help("清除搜索").accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 10).frame(height: 34).background(.white, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line)).accessibilityIdentifier("session-search")
    }
    private var emptyTitle: String {
        if !store.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "没有找到匹配的会话" }
        switch store.uploadFilter {
        case .all: return "暂无会话"
        case .pending: return "暂无未上传会话"
        case .excluded: return "没有设为不上传的会话"
        }
    }
    private func statusText(_ session: AgentSession) -> String {
        if store.sessionReadErrors[session.id] != nil { return "读取受限" }
        switch store.uploadState(of: session) {
        case .uploaded: return "已上传"
        case .pending: return "未上传"
        case .excluded: return "不上传"
        }
    }
    private func statusColor(_ session: AgentSession) -> Color {
        if store.sessionReadErrors[session.id] != nil { return Palette.red }
        switch store.uploadState(of: session) {
        case .uploaded: return Palette.green
        case .pending: return Palette.yellow
        case .excluded: return Palette.secondary
        }
    }
    /// Above the conversation: what will happen to this session, and the one control to change it.
    private func uploadBar(_ session: AgentSession) -> some View {
        let excluded = store.uploadState(of: session) == .excluded
        return HStack(spacing: 12) {
            StatusLabel(text: statusText(session), color: statusColor(session), size: 7)
            Text(uploadHint(session, excluded: excluded)).font(.system(size: 12)).foregroundStyle(Palette.secondary).lineLimit(1)
            let sensitive = sensitiveCount(session)
            if sensitive > 0 {
                Label("已识别 \(sensitive) 处密钥等隐私信息，已标红，上传时自动隐藏", systemImage: "eye.slash").font(.system(size: 12)).foregroundStyle(Palette.red).lineLimit(1)
                    .help("只在上传内容中替换为「[已隐藏]」；你本机看到的原文不会被修改").accessibilityIdentifier("sensitive-notice")
            }
            Spacer(minLength: 8)
            Button(excluded ? "恢复上传" : "不上传此会话") { store.setUploadExcluded(!excluded, for: session.id) }
                .buttonStyle(QuietButtonStyle(compact: true)).accessibilityIdentifier("toggle-upload-excluded")
                .help(excluded ? "之后的上传会再次包含这个会话" : "之后的上传不再包含这个会话；已上传的内容仍保留在公司系统中")
        }.padding(.horizontal, 24).frame(height: 46)
    }
    private func uploadHint(_ session: AgentSession, excluded: Bool) -> String {
        if excluded { return session.uploaded ? "之后不再上传；已上传的内容仍保留在公司系统中" : "这个会话不会被上传" }
        return session.uploaded ? "有新内容时会继续上传" : "下次上传时会包含这个会话"
    }
    private func sensitiveCount(_ session: AgentSession) -> Int {
        UploadCheckpoint.messages(in: session.turns).reduce(0) { $0 + RedactionMarks.hidden(in: $1.text).count }
    }
}

struct ChatView: View, Equatable {
    let session: AgentSession
    var checkpoint: UploadCheckpoint?
    var body: some View {
        let timeline = ConversationTimeline(turns: session.turns, checkpoint: checkpoint)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 26) {
                    ForEach(timeline.messages) { message in
                        if message.id == timeline.uploadBoundaryID, let checkpoint {
                            HStack(spacing: 12) {
                                Rule()
                                Text("上次上传至此 · \(checkpoint.uploadedAt.formatted(date: .omitted, time: .shortened))").font(.system(size: 10)).foregroundStyle(Palette.secondary).fixedSize()
                                Rule()
                            }.padding(.vertical, 3)
                        }
                        if message.isAnswer { answer(message) } else { question(message) }
                    }
                    if session.turns.last?.answer == nil {
                        Text("回复尚未完成").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    }
                    Color.clear.frame(height: 1).id("conversation-end")
                }.padding(.horizontal, 28).padding(.top, 28).padding(.bottom, 24)
            }.accessibilityIdentifier("conversation")
                .onAppear { proxy.scrollTo("conversation-end", anchor: .bottom) }
        }.id(session.id)
    }
    private func question(_ message: ConversationMessage) -> some View {
        HStack {
            Spacer(minLength: 28)
            VStack(alignment: .trailing, spacing: 7) {
                Text(RedactionMarks.highlight(AttributedString(message.text), hiding: RedactionMarks.hidden(in: message.text))).font(.system(size: 13)).lineSpacing(5).textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 12).background(Palette.bubble.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
                if let time = message.time { Text(time).font(.system(size: 10)).foregroundStyle(Palette.secondary) }
            }
        }
    }
    private func answer(_ message: ConversationMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            AgentIcon(agent: session.agent, size: 25)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 9) {
                    Text(session.agent.name).font(.system(size: 12, weight: .semibold))
                    if let time = message.time { Text(time).font(.system(size: 10)).foregroundStyle(Palette.secondary) }
                }
                MarkdownBody(text: message.text, hidden: RedactionMarks.hidden(in: message.text)).equatable()
                Button {
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.text, forType: .string)
                } label: { Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundStyle(Palette.secondary) }.buttonStyle(.plain).help("复制回复").accessibilityLabel("复制回复")
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Pieces of a message the upload will hide, found once per text.
enum RedactionMarks {
    private final class Box { let value: [String]; init(_ value: [String]) { self.value = value } }
    // NSCache is thread-safe; the compiler just cannot see that.
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = { let cache = NSCache<NSString, Box>(); cache.countLimit = 4000; return cache }()

    static func hidden(in text: String) -> [String] {
        if let box = cache.object(forKey: text as NSString) { return box.value }
        let value = SecretScrubber.analyze(text).hidden
        cache.setObject(Box(value), forKey: text as NSString)
        return value
    }

    /// Marks every occurrence of each hidden piece. Markdown is rendered first, so pieces are found by text.
    static func highlight(_ attributed: AttributedString, hiding pieces: [String]) -> AttributedString {
        guard !pieces.isEmpty else { return attributed }
        var result = attributed
        for piece in Set(pieces) where !piece.isEmpty {
            var start = result.startIndex
            while let range = result[start...].range(of: piece) {
                result[range].foregroundColor = Palette.red
                result[range].backgroundColor = Palette.red.opacity(0.14)
                start = range.upperBound
            }
        }
        return result
    }
}

struct MarkdownBody: View, Equatable {
    let text: String
    var hidden: [String] = []
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(text.components(separatedBy: "\n\n").enumerated()), id: \.offset) { _, block in
                if block.hasPrefix("```") {
                    ScrollView(.horizontal) {
                        Text(RedactionMarks.highlight(AttributedString(block.components(separatedBy: "\n").dropFirst().filter { !$0.hasPrefix("```") }.joined(separator: "\n")), hiding: hidden))
                            .font(.system(size: 12, design: .monospaced)).textSelection(.enabled).padding(12)
                    }.background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6))
                } else {
                    Text(RedactionMarks.highlight((try? AttributedString(markdown: block, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block), hiding: hidden))
                        .font(.system(size: 13)).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
