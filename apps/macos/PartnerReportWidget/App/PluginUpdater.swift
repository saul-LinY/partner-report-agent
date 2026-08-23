import Foundation

struct PluginUpdateResult: Sendable {
    let version: String
}

enum PluginUpdateError: LocalizedError {
    case codexNotFound
    case pluginNotInstalled
    case invalidRepository
    case dirtyRepository
    case commandFailed(action: String, detail: String)

    var errorDescription: String? {
        switch self {
        case .codexNotFound:
            return "未找到 Codex 命令，请确认 Codex 已安装。"
        case .pluginNotInstalled:
            return "未找到当前安装的 Partner Report 插件。"
        case .invalidRepository:
            return "插件仓库结构不完整，无法安全更新。"
        case .dirtyRepository:
            return "插件仓库有未提交修改，已停止更新。请先处理这些修改。"
        case .commandFailed(let action, let detail):
            return detail.isEmpty ? "\(action)失败，请稍后重试。" : "\(action)失败：\(detail)"
        }
    }
}

actor PluginUpdater {
    static let shared = PluginUpdater()

    private let pluginSelector = "partner-report@partner-report-marketplace"
    private let fileManager = FileManager.default

    func update() async throws -> PluginUpdateResult {
        let codex = try codexExecutable()
        let installedPlugins = try await run(codex, ["plugin", "list"], action: "读取插件信息")
        let pluginDirectory = try installedPluginDirectory(from: installedPlugins)
        let repositoryPath = try await run(
            URL(fileURLWithPath: "/usr/bin/git"),
            ["-C", pluginDirectory.path, "rev-parse", "--show-toplevel"],
            action: "定位插件仓库"
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        let repository = URL(fileURLWithPath: repositoryPath, isDirectory: true).standardizedFileURL

        try validate(repository: repository, pluginDirectory: pluginDirectory)

        let changes = try await run(
            URL(fileURLWithPath: "/usr/bin/git"),
            ["-C", repository.path, "status", "--porcelain=v1", "--untracked-files=normal"],
            action: "检查插件仓库"
        )
        guard changes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw PluginUpdateError.dirtyRepository
        }

        _ = try await run(
            URL(fileURLWithPath: "/usr/bin/git"),
            ["-C", repository.path, "pull", "--ff-only"],
            action: "拉取最新版本"
        )
        _ = try await run(
            codex,
            ["plugin", "add", pluginSelector, "--json"],
            action: "安装插件"
        )

        return PluginUpdateResult(version: try pluginVersion(at: pluginDirectory))
    }

    private func codexExecutable() throws -> URL {
        let home = fileManager.homeDirectoryForCurrentUser
        let candidates = [
            home.appendingPathComponent(".local/bin/codex"),
            URL(fileURLWithPath: "/opt/homebrew/bin/codex"),
            URL(fileURLWithPath: "/usr/local/bin/codex")
        ]
        guard let executable = candidates.first(where: { fileManager.isExecutableFile(atPath: $0.path) }) else {
            throw PluginUpdateError.codexNotFound
        }
        return executable
    }

    private func installedPluginDirectory(from output: String) throws -> URL {
        guard let line = output.split(separator: "\n").first(where: { $0.contains(pluginSelector) }),
              let pathStart = line.firstIndex(of: "/") else {
            throw PluginUpdateError.pluginNotInstalled
        }
        let path = String(line[pathStart...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    }

    private func validate(repository: URL, pluginDirectory: URL) throws {
        let expectedPlugin = repository.appendingPathComponent("plugins/partner-report", isDirectory: true).standardizedFileURL
        let manifest = pluginDirectory.appendingPathComponent(".codex-plugin/plugin.json")
        let marketplace = repository.appendingPathComponent(".agents/plugins/marketplace.json")
        guard expectedPlugin == pluginDirectory,
              fileManager.fileExists(atPath: manifest.path),
              fileManager.fileExists(atPath: marketplace.path) else {
            throw PluginUpdateError.invalidRepository
        }
    }

    private func pluginVersion(at pluginDirectory: URL) throws -> String {
        let manifest = pluginDirectory.appendingPathComponent(".codex-plugin/plugin.json")
        guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any],
              let version = object["version"] as? String else {
            throw PluginUpdateError.invalidRepository
        }
        return version
    }

    private func run(_ executable: URL, _ arguments: [String], action: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                let output = Pipe()
                process.executableURL = executable
                process.arguments = arguments
                process.standardOutput = output
                process.standardError = output

                do {
                    try process.run()
                    let data = output.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard process.terminationStatus == 0 else {
                        throw PluginUpdateError.commandFailed(action: action, detail: String(text.suffix(500)))
                    }
                    continuation.resume(returning: text)
                } catch let error as PluginUpdateError {
                    continuation.resume(throwing: error)
                } catch {
                    continuation.resume(throwing: PluginUpdateError.commandFailed(action: action, detail: error.localizedDescription))
                }
            }
        }
    }
}
