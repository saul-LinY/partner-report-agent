import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else { fatalError("usage: swift prepare-assets.swift repo-root assets-directory") }
let root = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
let manager = FileManager.default
try manager.createDirectory(at: output, withIntermediateDirectories: true)
try Data("{\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: output.appending(path: "Contents.json"))

func render(_ source: URL, size: Int, to destination: URL) throws {
    guard let image = NSImage(contentsOf: source),
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fatalError("Cannot decode \(source.path)") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let ratio = min(CGFloat(size) / image.size.width, CGFloat(size) / image.size.height)
    let actual = NSSize(width: image.size.width * ratio, height: image.size.height * ratio)
    image.draw(in: NSRect(x: (CGFloat(size) - actual.width) / 2, y: (CGFloat(size) - actual.height) / 2, width: actual.width, height: actual.height))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("PNG encoding failed") }
    try png.write(to: destination)
}

func imageSet(_ name: String, source: URL) throws {
    let folder = output.appending(path: "\(name).imageset")
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    try render(source, size: 128, to: folder.appending(path: "image.png"))
    let info: [String: Any] = ["images": [["filename": "image.png", "idiom": "universal"]], "info": ["author": "xcode", "version": 1]]
    try JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appending(path: "Contents.json"))
}

let icons = root.appending(path: "docs/assets/agent-icons")
let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: icons.appending(path: "manifest.json"))) as! [[String: Any]]
for entry in manifest {
    try imageSet("agent-\(entry["provider"] as! String)", source: root.appending(path: entry["path"] as! String))
}
let mark = root.appending(path: "docs/assets/weekly-report-mark.svg")
try imageSet("WeeklyReportMark", source: mark)
let folder = output.appending(path: "AppIcon.appiconset")
try manager.createDirectory(at: folder, withIntermediateDirectories: true)
var images: [[String: String]] = []
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let file = "icon-\(size)@\(scale)x.png"
        try render(mark, size: size * scale, to: folder.appending(path: file))
        images.append(["idiom": "mac", "size": "\(size)x\(size)", "scale": "\(scale)x", "filename": file])
    }
}
try JSONSerialization.data(withJSONObject: ["images": images, "info": ["author": "xcode", "version": 1]], options: [.prettyPrinted, .sortedKeys]).write(to: folder.appending(path: "Contents.json"))
print("Prepared \(manifest.count) Agent icons, weekly report mark and macOS AppIcon.")
