import Foundation

public enum BackgroundRuntime {
    public static let serviceLabel = "com.weeklyreport.desktop.background"
    public static let plistName = serviceLabel + ".plist"
    public static let appBundleID = "com.weeklyreport.desktop.preview"
    public static let showWindowNotification = "com.weeklyreport.desktop.show-window"
    public static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appending(path: "WeeklyReportLocal")
    }
    public static var disabledFile: URL { folder.appending(path: "background-disabled") }
    public static var updatePauseFile: URL { folder.appending(path: "background-update-pause.json") }

    public static func setDisabled(_ disabled: Bool, in folder: URL = folder) throws {
        let file = folder.appending(path: "background-disabled")
        if disabled {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data().write(to: file, options: .atomic)
        } else if FileManager.default.fileExists(atPath: file.path) {
            try FileManager.default.removeItem(at: file)
        }
    }

    public static func pauseForUpdate(until date: Date, in folder: URL = folder) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONEncoder().encode(date).write(to: folder.appending(path: "background-update-pause.json"), options: .atomic)
    }

    public static func clearUpdatePause() {
        try? FileManager.default.removeItem(at: updatePauseFile)
    }

    public static func shouldRestart(at date: Date = .now, in folder: URL = folder) -> Bool {
        guard !FileManager.default.fileExists(atPath: folder.appending(path: "background-disabled").path) else { return false }
        if let data = try? Data(contentsOf: folder.appending(path: "background-update-pause.json")),
           let until = try? JSONDecoder().decode(Date.self, from: data), until > date { return false }
        return true
    }
}
