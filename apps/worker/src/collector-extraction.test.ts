import { describe, expect, it } from "vitest";
import {
  evidenceDate,
  extractionChunks,
  validateExtraction,
} from "./collector-extraction.js";

describe("collector evidence boundaries", () => {
  it("uses the source date and timezone across relative days and year boundaries", () => {
    expect(
      evidenceDate("昨天 10:00", "2026-11-02T04:00:00Z", "Asia/Shanghai"),
    ).toBe("2026-11-01");
    expect(
      evidenceDate("12月31日 10:00", "2026-01-02T04:00:00Z", "Asia/Shanghai"),
    ).toBe("2025-12-31");
    expect(
      evidenceDate(
        "2026-11-01T18:00:00Z",
        "2026-11-02T04:00:00Z",
        "Asia/Shanghai",
      ),
    ).toBe("2026-11-02");
    expect(
      evidenceDate(
        "2026-02-31",
        "2026-11-02T04:00:00Z",
        "Asia/Shanghai",
        "2026-11-01",
      ),
    ).toBe("2026-11-01");
  });
  it("retains every character in long messages and excludes messages outside the period", () => {
    const text = "测试长会话".repeat(20_000);
    const chunks = extractionChunks(
      {
        id: "a",
        scopeKey: "a".repeat(64),
        agent: "codex",
        title: "a",
        modifiedAt: "2026-11-02T04:00:00Z",
        turns: [
          { id: "old", prompt: "old", questionTime: "2026-10-01" },
          {
            id: "new",
            prompt: "request",
            answer: text,
            questionTime: "2026-11-02",
          },
        ],
      },
      {
        starts_at: "2026-11-01T00:00:00+08:00",
        ends_at: "2026-11-06T17:00:00+08:00",
        timezone: "Asia/Shanghai",
      },
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks
        .flat()
        .filter((e) => e.role === "assistant")
        .map((e) => e.text)
        .join(""),
    ).toBe(text);
    expect(chunks.flat().some((e) => e.text === "old")).toBe(false);
    expect(new Set(chunks.flat().map((e) => e.ref)).size).toBe(
      chunks.flat().length,
    );
  });
  it("uses the exact cutoff time with an inclusive start and exclusive end", () => {
    const chunks = extractionChunks(
      {
        id: "cutoff",
        scopeKey: "a".repeat(64),
        agent: "codex",
        title: "cutoff",
        modifiedAt: "2026-11-06T09:00:00Z",
        turns: [
          {
            id: "before",
            prompt: "before",
            questionTime: "2026-10-30 16:59:59",
          },
          { id: "start", prompt: "start", questionTime: "2026-10-30 17:00:00" },
          {
            id: "inside",
            prompt: "inside",
            questionTime: "2026-11-06T08:59:59Z",
          },
          { id: "end", prompt: "end", questionTime: "2026-11-06T09:00:00Z" },
        ],
      },
      {
        starts_at: "2026-10-30T17:00:00+08:00",
        ends_at: "2026-11-06T17:00:00+08:00",
        timezone: "Asia/Shanghai",
      },
    );
    expect(chunks.flat().map((item) => item.text)).toEqual(["start", "inside"]);
  });
  it("rejects fabricated references, dates and completion based on user requests alone", () => {
    const evidence = [
      {
        ref: "U1",
        date: "2026-11-02",
        role: "user" as const,
        text: "Please build this",
      },
    ];
    const output = {
      decision: "include",
      reason: "work",
      title: "title",
      summary: "summary",
      contributions: [
        {
          kind: "outcome",
          text: "Completed",
          confidence: "high",
          date: "2026-11-02",
          evidenceRefs: ["U1"],
        },
      ],
    };
    expect(() => validateExtraction(output, evidence)).toThrow(
      "Contribution references",
    );
    output.contributions[0]!.kind = "next_step";
    expect(validateExtraction(output, evidence).contributions).toHaveLength(1);
    output.contributions[0]!.evidenceRefs = ["invented"];
    expect(() => validateExtraction(output, evidence)).toThrow(
      "Contribution references",
    );
    output.contributions[0]!.evidenceRefs = ["U1"];
    output.contributions[0]!.date = "2026-11-03";
    expect(() => validateExtraction(output, evidence)).toThrow(
      "Contribution references",
    );
  });
});
