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
                Text("\(store.visibleSessions.count) 个会话").font(.system(size: 11)).foregroundStyle(Palette.secondary).padding(.leading, 4)
                Spacer(minLength: 0)
                ViewThatFits {
                    Label("已归档内容不扫描、不上传", systemImage: "checkmark.shield").font(.system(size: 11)).foregroundStyle(Palette.secondary)
                    Image(systemName: "checkmark.shield").foregroundStyle(Palette.secondary).help("已归档内容不扫描、不上传")
                }
            }.padding(.horizontal, 24).padding(.bottom, 16)
            Rule()
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        Text("会话").font(.system(size: 12)).foregroundStyle(Palette.secondary)
                        Spacer()
                        FilterTab(title: "全部", selected: !store.pendingOnly) { store.pendingOnly = false }
                        FilterTab(title: "未上传", selected: store.pendingOnly) { store.pendingOnly = true }
                    }.padding(.horizontal, 14)
                    Rule()
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(store.visibleSessions) { session in sessionRow(session) }
                            if store.visibleSessions.isEmpty {
                                EmptyMessage(symbol: "bubble.left", title: store.pendingOnly ? "暂无未上传会话" : "暂无会话", subtitle: "").frame(height: 220)
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
                        if session.turns.isEmpty {
                            EmptyMessage(symbol: "bubble.left.and.text.bubble.right", title: "此会话暂无可显示的问答", subtitle: "")
                        } else {
                            ChatView(session: session, checkpoint: store.uploadCheckpoints[session.id]).equatable()
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
                    Text(session.updatedLabel).font(.system(size: 11)).foregroundStyle(Palette.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    StatusLabel(text: store.sessionReadErrors[session.id] != nil ? "读取受限" : session.uploaded ? "已上传" : "未上传", color: store.sessionReadErrors[session.id] != nil ? Palette.red : session.uploaded ? Palette.green : Palette.yellow, size: 6)
                }
            }.padding(.horizontal, 18).padding(.vertical, 18).frame(maxWidth: .infinity, alignment: .leading)
                .background(session.id == store.selectedSessionID ? Palette.selected : .white)
                .overlay(alignment: .leading) { if session.id == store.selectedSessionID { Rectangle().fill(Palette.yellow).frame(width: 3) } }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("session-\(session.id)").overlay(alignment: .bottom) { Rule() }
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
                Text(message.text).font(.system(size: 13)).lineSpacing(5).textSelection(.enabled)
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
                MarkdownBody(text: message.text).equatable()
                Button {
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message.text, forType: .string)
                } label: { Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundStyle(Palette.secondary) }.buttonStyle(.plain).help("复制回复").accessibilityLabel("复制回复")
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct MarkdownBody: View, Equatable {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(text.components(separatedBy: "\n\n").enumerated()), id: \.offset) { _, block in
                if block.hasPrefix("```") {
                    ScrollView(.horizontal) {
                        Text(block.components(separatedBy: "\n").dropFirst().filter { !$0.hasPrefix("```") }.joined(separator: "\n"))
                            .font(.system(size: 12, design: .monospaced)).textSelection(.enabled).padding(12)
                    }.background(Palette.quiet, in: RoundedRectangle(cornerRadius: 6))
                } else {
                    Text((try? AttributedString(markdown: block, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block))
                        .font(.system(size: 13)).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
