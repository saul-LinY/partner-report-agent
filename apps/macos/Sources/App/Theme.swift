import SwiftUI
import AppKit
import WeeklyReportCore

enum Palette {
    static let yellow = Color(hex: 0xFFD51C)
    static let selected = Color(hex: 0xFFF7D5)
    static let ink = Color(hex: 0x202329)
    static let secondary = Color(hex: 0x77818C)
    static let green = Color(hex: 0x2DB769)
    static let red = Color(hex: 0xFF4545)
    static let line = Color(hex: 0xE5E8EB)
    static let quiet = Color(hex: 0xF7F8F8)
    static let bubble = Color(hex: 0xEFF0F2)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255)
    }
}

struct YellowButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 13 : 14, weight: .medium))
            .padding(.horizontal, compact ? 11 : 16)
            .padding(.vertical, compact ? 7 : 9)
            .foregroundStyle(Palette.ink)
            .background(isEnabled ? Palette.yellow.opacity(configuration.isPressed ? 0.7 : 1) : Palette.line, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(RoundedRectangle(cornerRadius: 6))
    }
}

struct YellowCheckboxStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
        } label: {
            HStack(alignment: .top, spacing: 9) {
                ZStack {
                    RoundedRectangle(cornerRadius: 3).fill(configuration.isOn ? Palette.yellow : .white)
                    if !configuration.isOn { RoundedRectangle(cornerRadius: 3).stroke(Palette.secondary.opacity(0.45), lineWidth: 1) }
                    if configuration.isOn { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.ink) }
                }
                .frame(width: 17, height: 17)
                configuration.label.foregroundStyle(Palette.ink).multilineTextAlignment(.leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(configuration.isOn ? "已开启" : "已关闭")
    }
}

struct StatusLabel: View {
    var text: String
    var color: Color
    var size: CGFloat = 7
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: size, height: size)
            Text(text).font(.system(size: 13))
        }.foregroundStyle(Palette.ink)
    }
}

struct AgentIcon: View {
    let agent: Agent
    var size: CGFloat = 22
    var body: some View {
        Image("agent-\(agent.rawValue)")
            .resizable().interpolation(.high).scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

struct AgentFilterMenu: NSViewRepresentable {
    @Binding var selection: Agent?
    let counts: [Int]

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.isBordered = false
        button.font = .systemFont(ofSize: 13)
        button.imagePosition = .imageLeading
        button.target = context.coordinator
        button.action = #selector(Coordinator.changed(_:))
        button.setAccessibilityIdentifier("agent-filter")
        button.setAccessibilityLabel("筛选 AI 工具")
        let menu = NSMenu()
        menu.minimumWidth = 230
        menu.autoenablesItems = false
        for (index, agent) in ([nil] + Agent.allCases.map(Optional.some)).enumerated() {
            let item = NSMenuItem(title: agent?.name ?? "全部 AI 工具", action: nil, keyEquivalent: "")
            item.tag = index
            let source = agent.flatMap { NSImage(named: "agent-\($0.rawValue)") }
                ?? NSImage(systemSymbolName: "slider.horizontal.3", accessibilityDescription: nil)
            item.image = source?.copy() as? NSImage
            item.image?.size = NSSize(width: 18, height: 18)
            if agent != nil { item.image?.isTemplate = false }
            menu.addItem(item)
        }
        button.menu = menu
        return button
    }
    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.parent = self
        for (index, item) in button.itemArray.enumerated() {
            // Native badges share a trailing column, independent of title length.
            item.badge = NSMenuItemBadge(count: index == 0 ? counts.reduce(0, +) : counts[index - 1])
        }
        let index = selection.flatMap { Agent.allCases.firstIndex(of: $0) }.map { $0 + 1 } ?? 0
        button.selectItem(at: index)
    }
    @MainActor final class Coordinator: NSObject {
        var parent: AgentFilterMenu
        init(_ parent: AgentFilterMenu) { self.parent = parent }
        @objc func changed(_ sender: NSPopUpButton) {
            let index = sender.indexOfSelectedItem
            parent.selection = index > 0 ? Agent.allCases[index - 1] : nil
        }
    }
}

struct EmptyMessage: View {
    let symbol: String?
    let title: String
    let subtitle: String
    var body: some View {
        VStack(spacing: 12) {
            if let symbol { Image(systemName: symbol).font(.system(size: 26, weight: .light)).foregroundStyle(Palette.secondary) }
            Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(Palette.ink)
            if !subtitle.isEmpty { Text(subtitle).font(.system(size: 13)).foregroundStyle(Palette.secondary).multilineTextAlignment(.center) }
        }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct SectionTitle: View {
    let title: String
    var body: some View {
        Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
    }
}

struct Rule: View {
    var body: some View { Rectangle().fill(Palette.line).frame(height: 1) }
}

struct FieldStyle: ViewModifier {
    func body(content: Content) -> some View {
        content.textFieldStyle(.plain).padding(.horizontal, 10).padding(.vertical, 8)
            .background(Palette.quiet, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(Palette.line))
    }
}

struct ScheduleFieldStyle: ViewModifier {
    @Environment(\.isEnabled) private var enabled
    func body(content: Content) -> some View {
        content.frame(width: 116, height: 36)
            .background(.white, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line))
            .opacity(enabled ? 1 : 0.5)
    }
}

struct TimePickerField: NSViewRepresentable {
    @Binding var selection: Date
    @Environment(\.isEnabled) private var enabled
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSDatePicker {
        let picker = NSDatePicker()
        picker.datePickerStyle = .textField
        picker.datePickerElements = [.hourMinute]
        picker.locale = Locale(identifier: "en_GB")
        picker.timeZone = .current
        picker.isBezeled = false
        picker.isBordered = false
        picker.drawsBackground = false
        picker.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        picker.textColor = .labelColor
        picker.target = context.coordinator
        picker.action = #selector(Coordinator.changed(_:))
        picker.setAccessibilityLabel("上传时间")
        return picker
    }
    func updateNSView(_ picker: NSDatePicker, context: Context) {
        context.coordinator.parent = self
        picker.isEnabled = enabled
        if picker.dateValue != selection { picker.dateValue = selection }
    }
    @MainActor final class Coordinator: NSObject {
        var parent: TimePickerField
        init(_ parent: TimePickerField) { self.parent = parent }
        @objc func changed(_ sender: NSDatePicker) { parent.selection = sender.dateValue }
    }
}

extension AppStore {
    func preferenceBinding<Value>(_ path: WritableKeyPath<AppPreferences, Value>) -> Binding<Value> {
        Binding(get: { self.preferences[keyPath: path] }, set: { value in self.updatePreferences { $0[keyPath: path] = value } })
    }
}

struct QuietButtonStyle: ButtonStyle {
    var compact = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: compact ? 12 : 13, weight: .medium))
            .padding(.horizontal, compact ? 10 : 13).frame(height: compact ? 30 : 36)
            .foregroundStyle(enabled ? Palette.ink : Palette.secondary)
            .background(configuration.isPressed ? Palette.line : Color.white, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line)).opacity(enabled ? 1 : 0.55)
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    var action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 15)).frame(width: 32, height: 32) }
            .buttonStyle(.plain).background(.white, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.line)).help(help).accessibilityLabel(help)
    }
}

struct UpdateBadgeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .regular))
            .foregroundStyle(.white)
            .frame(width: 52, height: 26)
            .background(Palette.red.opacity(configuration.isPressed ? 0.75 : 1), in: Capsule())
            .contentShape(Capsule())
    }
}

struct PageHeading<Actions: View>: View {
    let title: String
    @ViewBuilder var actions: Actions
    var body: some View {
        HStack { Text(title).font(.system(size: 23, weight: .semibold)); Spacer(); actions }
            .frame(height: 72).padding(.horizontal, 28).padding(.top, 10)
    }
}

struct FilterTab: View {
    let title: String
    var count: Int? = nil
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Text(title).fontWeight(selected ? .semibold : .regular)
                if let count { Text("\(count)").font(.system(size: 11, weight: .medium)).monospacedDigit().padding(.horizontal, 6).frame(minHeight: 20).background(Palette.quiet, in: Capsule()) }
            }.font(.system(size: 13)).padding(.horizontal, 10).frame(height: 44)
                .overlay(alignment: .bottom) { if selected { Rectangle().fill(Palette.yellow).frame(height: 3) } }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct AgentStack: View {
    var agents: [Agent]
    var body: some View {
        HStack(spacing: -7) {
            if agents.count > 4 { Text("+\(agents.count - 4)").font(.system(size: 10)).padding(.trailing, 10) }
            ForEach(Array(agents.prefix(4).enumerated()).reversed(), id: \.element.id) { index, agent in
                AgentIcon(agent: agent, size: 21).padding(3).background(.white, in: RoundedRectangle(cornerRadius: 5)).zIndex(Double(4 - index))
            }
        }.fixedSize().help(agents.map(\.name).joined(separator: "、")).accessibilityLabel(agents.map(\.name).joined(separator: "、"))
    }
}

func displayPath(_ path: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
}

@MainActor
func chooseDirectory(title: String, current: String? = nil, allowsFiles: Bool = false) -> String? {
    let panel = NSOpenPanel()
    panel.title = title; panel.prompt = "选择"
    panel.canChooseDirectories = true; panel.canChooseFiles = allowsFiles; panel.allowsMultipleSelection = false
    if let current { panel.directoryURL = URL(fileURLWithPath: (current as NSString).expandingTildeInPath) }
    guard panel.runModal() == .OK else { return nil }
    return panel.url?.resolvingSymlinksInPath().path
}
