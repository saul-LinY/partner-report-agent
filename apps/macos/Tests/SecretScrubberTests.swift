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
        let sample = "先说中文😀 密钥是 \(secret)，路径 /Users/a/b 邮箱 a@b.com 其余照旧"
        let analysis = SecretScrubber.analyze(sample)
        XCTAssertEqual(Set(analysis.hidden), [secret, "/Users/a/b", "a@b.com"])
        XCTAssertEqual(analysis.text, SecretScrubber.redact(sample))
        XCTAssertEqual(analysis.text, "先说中文😀 密钥是 [已隐藏]，路径 [已隐藏] 邮箱 [已隐藏] 其余照旧")
    }

    func testMarkedTermsAreHiddenEverywhereAndAnalysisAgreesWithRedaction() throws {
        let terms = ["张三科技", "三科技有限", "客户A"]
        let samples = ["给张三科技有限公司报价，客户A不同意；客户A再说", "没有可隐藏的内容", "张三科技 sk-0123456789abcdef0123456789abcdef01234567 张三科技"]
        for sample in samples {
            let analysis = SecretScrubber.analyze(sample, hiding: terms)
            XCTAssertEqual(analysis.text, SecretScrubber.redact(sample, hiding: terms), sample)
            for piece in analysis.hidden { XCTAssertTrue(sample.contains(piece), sample) }
        }
        // Overlapping terms become one hidden piece instead of leaving a fragment behind.
        XCTAssertEqual(SecretScrubber.redact("给张三科技有限公司报价", hiding: terms), "给[已隐藏]公司报价")
        XCTAssertEqual(SecretScrubber.redact("没有可隐藏的内容", hiding: terms), "没有可隐藏的内容")
    }

    func testCheckpointTreatsASessionAsPendingWhenNewRulesOrTermsChangeWhatWouldBeUploaded() throws {
        let turn = ChatTurn(id: "t", prompt: "客户A的报价见 http://10.0.0.8/x", answer: "好的", questionTime: "12:00")
        // Uploaded earlier under the current rules.
        let uploaded = UploadCheckpoint(turns: [SecretScrubber.redact(turn)])
        XCTAssertTrue(uploaded.pendingMessages(in: [turn]).isEmpty)
        // The member then marks a term: the same session must go out again, redacted.
        XCTAssertEqual(uploaded.pendingMessages(in: [turn], hiding: ["客户A"]).map(\.id), ["t:prompt"])
        // Content that was uploaded before the address rule existed (raw) is pending as well.
        XCTAssertEqual(UploadCheckpoint(turns: [turn]).pendingMessages(in: [turn]).map(\.id), ["t:prompt"])
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
        XCTAssertEqual(decoded.turns[0].prompt, "密钥是 [已隐藏]，地址 [已隐藏] 保持原样\n\n第二段")
        XCTAssertTrue(decoded.turns[0].prompt.contains("\n\n第二段"))
        XCTAssertTrue(decoded.turns[0].answer?.contains("其余照旧") == true)
        XCTAssertEqual(decoded.turns[0].questionTime, "12:00")
        XCTAssertEqual(decoded.turns[0].model, "gpt")
        XCTAssertEqual(decoded.turns[1], question)
        // The checksum must describe the redacted bytes that are actually sent.
        XCTAssertEqual(package.partDigests, package.parts.map(CollectorPackage.digest))
    }
}
