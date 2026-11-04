import XCTest
@testable import WeeklyReportCore

final class SecretScrubberTests: XCTestCase {
    private struct Vector: Decodable {
        let name: String
        let input: String
        let expected: String
    }

    /// The server applies the same rules; both read this one file so they cannot drift apart.
    func testMatchesTheSharedVectorsUsedByTheServer() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        url.appendPathComponent("packages/contracts/src/privacy-vectors.json")
        let vectors = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(vectors.count, 10)
        for vector in vectors {
            XCTAssertEqual(SecretScrubber.redact(vector.input), vector.expected, vector.name)
        }
    }

    func testAnalysisProducesTheUploadedTextAndNamesExactlyWhatWasHidden() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        url.appendPathComponent("packages/contracts/src/privacy-vectors.json")
        for vector in try JSONDecoder().decode([Vector].self, from: Data(contentsOf: url)) {
            let analysis = SecretScrubber.analyze(vector.input)
            XCTAssertEqual(analysis.text, vector.expected, vector.name)
            XCTAssertEqual(analysis.hidden.isEmpty, vector.input == vector.expected, vector.name)
            for piece in analysis.hidden { XCTAssertTrue(vector.input.contains(piece), vector.name) }
        }
        let secret = "sk-0123456789abcdef0123456789abcdef01234567"
        let sample = "先说中文😀 密钥是 \(secret)，路径 /Users/a/b 保持。审核口令:4321 其余照旧"
        let analysis = SecretScrubber.analyze(sample)
        XCTAssertTrue(analysis.hidden.contains(secret))
        XCTAssertFalse(analysis.hidden.contains { $0.contains("/Users/a/b") })
        XCTAssertEqual(analysis.text, SecretScrubber.redact(sample))
    }

    func testUploadPackageRemovesCredentialsAndKeepsEverythingElseAsWritten() throws {
        let now = Date.now
        let period = CollectorPolicy.Period(periodKey: "test", startsAt: now.addingTimeInterval(-100), endsAt: now.addingTimeInterval(100))
        let secret = "sk-0123456789abcdef0123456789abcdef01234567"
        let turn = ChatTurn(
            id: "t1",
            prompt: "密钥是 \(secret)，地址 http://10.0.0.8:8080/v1 保持原样\n\n第二段",
            answer: "审核口令:4321 上现在是 WebShell 设的 123456，其余照旧",
            questionTime: "12:00", answerTime: "12:01", model: "gpt")
        let question = ChatTurn(id: "t2", prompt: "没有答案的提问", answer: nil, questionTime: "12:02")
        let session = CollectorSession(id: "s", scopeKey: String(repeating: "a", count: 64), agent: .codex, title: "调试 \(secret)", modifiedAt: now, turns: [turn, question])

        let package = try CollectorPackage(period: period, start: now, end: now, version: 2, sessions: [session])
        let text = String(decoding: package.parts.reduce(Data(), +), as: UTF8.self)
        XCTAssertFalse(text.contains("sk-0123"))
        XCTAssertFalse(text.contains("123456"))
        XCTAssertFalse(text.contains("WebShell"))

        let decoded = try CollectorJSON.decoder().decode([CollectorSession].self, from: package.parts[0])[0]
        XCTAssertEqual(decoded.id, "s")
        XCTAssertEqual(decoded.title, "调试 [已隐藏]")
        XCTAssertTrue(decoded.turns[0].prompt.contains("http://10.0.0.8:8080/v1"))
        XCTAssertTrue(decoded.turns[0].prompt.contains("\n\n第二段"))
        XCTAssertTrue(decoded.turns[0].answer?.contains("其余照旧") == true)
        XCTAssertEqual(decoded.turns[0].questionTime, "12:00")
        XCTAssertEqual(decoded.turns[0].model, "gpt")
        XCTAssertEqual(decoded.turns[1], question)
        // The checksum must describe the redacted bytes that are actually sent.
        XCTAssertEqual(package.partDigests, package.parts.map(CollectorPackage.digest))
    }
}
