import XCTest
@testable import WeeklyReportCore

final class RedactionRegionsTests: XCTestCase {
    func testSpansComeBackTopToBottomWhateverOrderThePiecesWereFound() {
        let text = "联系 a@b.com，再看 10.0.0.8，最后 a@b.com"
        let ranges = RedactionRegions.ranges(in: text, hidden: ["10.0.0.8", "a@b.com"])
        XCTAssertEqual(ranges.map { (text as NSString).substring(with: $0) }, ["a@b.com", "10.0.0.8", "a@b.com"])
        XCTAssertEqual(ranges, ranges.sorted { $0.location < $1.location })
    }

    func testOverlappingAndTouchingPiecesAreOneSpan() {
        let text = "写到 https://x.io/a?k=1 结束"
        let hidden = ["https://x.io/a?k=1", "x.io", "k=1"]
        let ranges = RedactionRegions.ranges(in: text, hidden: hidden)
        XCTAssertEqual(ranges.count, 1)
        XCTAssertEqual((text as NSString).substring(with: ranges[0]), "https://x.io/a?k=1")
        let touching = RedactionRegions.ranges(in: "abcd", hidden: ["ab", "cd"])
        XCTAssertEqual(touching, [NSRange(location: 0, length: 4)])
    }

    func testOffsetsCountUTF16SoTheyLineUpWithAppKitText() {
        let text = "😀密码：hunter2 😀 hunter2"
        let ranges = RedactionRegions.ranges(in: text, hidden: ["hunter2"])
        XCTAssertEqual(ranges.map { (text as NSString).substring(with: $0) }, ["hunter2", "hunter2"])
    }

    func testNothingToHideGivesNoSpans() {
        XCTAssertTrue(RedactionRegions.ranges(in: "没有隐私", hidden: []).isEmpty)
        XCTAssertTrue(RedactionRegions.ranges(in: "没有隐私", hidden: [""]).isEmpty)
        XCTAssertTrue(RedactionRegions.ranges(in: "没有隐私", hidden: ["别的"]).isEmpty)
    }

    func testClicksVisitEverySpanInOrderThenStartOver() {
        var visited: [Int] = []
        var current: Int?
        for _ in 0..<7 {
            current = RedactionRegions.next(after: current, count: 3)
            visited.append(current!)
        }
        XCTAssertEqual(visited, [0, 1, 2, 0, 1, 2, 0])
    }

    func testClickAfterSpansWereRemovedStaysInRange() {
        XCTAssertNil(RedactionRegions.next(after: 4, count: 0))
        XCTAssertEqual(RedactionRegions.next(after: 4, count: 2), 0)
        XCTAssertEqual(RedactionRegions.next(after: 9, count: 1), 0)
    }
}
