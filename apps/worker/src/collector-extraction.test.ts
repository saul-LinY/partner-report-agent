import { describe, expect, it } from "vitest";
import {
  evidenceDate,
  extractionChunks,
  extractWithinOutputBudget,
  modelExtractionSchema,
  validateExtraction,
} from "./collector-extraction.js";
import { ModelGatewayError } from "./model.js";

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
          plain: "已完成",
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
  it("requires a plain sentence of at most 60 characters on every contribution", () => {
    const evidence = [
      {
        ref: "A1",
        date: "2026-11-02",
        role: "assistant" as const,
        text: "Done",
      },
    ];
    const output = (plain?: string) => ({
      decision: "include",
      reason: "work",
      title: "title",
      summary: "summary",
      contributions: [
        {
          kind: "outcome",
          text: "Completed",
          ...(plain === undefined ? {} : { plain }),
          confidence: "high",
          date: "2026-11-02",
          evidenceRefs: ["A1"],
        },
      ],
    });
    expect(
      validateExtraction(output("后台改名后，App 里的名字会自动更新"), evidence)
        .contributions[0]!.plain,
    ).toBe("后台改名后，App 里的名字会自动更新");
    expect(() => validateExtraction(output(), evidence)).toThrow();
    expect(() => validateExtraction(output("  "), evidence)).toThrow();
    expect(() =>
      validateExtraction(output("字".repeat(61)), evidence),
    ).toThrow();
  });
  it("accepts an over-long or missing model plain and truncates it to 60 characters", () => {
    const output = (plain?: string) => ({
      decision: "include",
      reason: "work",
      title: "title",
      summary: "summary",
      contributions: [
        {
          kind: "outcome",
          text: "文".repeat(100),
          ...(plain === undefined ? {} : { plain }),
          confidence: "high",
          date: "2026-11-02",
          evidenceRefs: ["A1"],
        },
      ],
    });
    expect(
      modelExtractionSchema.parse(output("字".repeat(61))).contributions[0]
        ?.plain,
    ).toBe("字".repeat(60));
    expect(
      modelExtractionSchema.parse(output()).contributions[0]?.plain,
    ).toBe("文".repeat(60));
  });
});

describe("answers cut off by the output budget", () => {
  const cutOff = () =>
    new ModelGatewayError("MODEL_OUTPUT_TOKEN_LIMIT", "cut off", false);
  type Piece = {
    ref: string;
    date: string;
    role: "user" | "assistant";
    text: string;
  };
  // Answers only while the piece is small enough, citing every reference it was given; `answered` keeps what got through.
  const answerUnder =
    (limit: number, seen: Piece[][], answered: Piece[][] = []) =>
    async (part: Piece[]) => {
      seen.push(part);
      if (part.reduce((sum, item) => sum + item.text.length, 0) > limit)
        throw cutOff();
      answered.push(part);
      return {
        decision: "include",
        reason: "",
        title: "进展",
        summary: "完成了一部分",
        contributions: [
          {
            kind: "progress",
            text: "完成了一部分",
            plain: "完成了一部分",
            confidence: "high",
            date: part[0]!.date,
            evidenceRefs: part.map((item) => item.ref),
          },
        ],
      };
    };

  it("halves by messages, then a long message by text, keeping every character and valid references", async () => {
    const evidence: Piece[] = [
      {
        ref: "T1:user:0",
        date: "2026-11-16",
        role: "user",
        text: "a".repeat(3_000),
      },
      {
        ref: "T1:assistant:0",
        date: "2026-11-16",
        role: "assistant",
        text: "b".repeat(9_000),
      },
    ];
    const seen: Piece[][] = [],
      answered: Piece[][] = [];
    const result = await extractWithinOutputBudget(
      evidence,
      answerUnder(5_000, seen, answered),
    );
    expect(result.refs.map((item) => item.ref)).toEqual([
      "T1:user:0",
      "T1:assistant:0",
      "T1:assistant:4500",
    ]);
    expect(result.outputs).toHaveLength(3);
    expect(
      answered
        .flat()
        .map((item) => item.text)
        .join(""),
    ).toBe("a".repeat(3_000) + "b".repeat(9_000));
    // Saved answers stay valid against the saved references when a retry resumes the chunk.
    for (const output of result.outputs)
      expect(() => validateExtraction(output, result.refs)).not.toThrow();
  });

  it("fails instead of splitting on other errors or when a piece cannot shrink further", async () => {
    const short: Piece[] = [
      {
        ref: "T1:assistant:0",
        date: "2026-11-16",
        role: "assistant",
        text: "b".repeat(500),
      },
    ];
    const seen: Piece[][] = [];
    await expect(
      extractWithinOutputBudget(short, answerUnder(100, seen)),
    ).rejects.toMatchObject({
      code: "MODEL_OUTPUT_TOKEN_LIMIT",
    });
    expect(seen).toHaveLength(1);
    const auth = new ModelGatewayError("MODEL_AUTH_FAILED", "bad key", false);
    let calls = 0;
    await expect(
      extractWithinOutputBudget([...short, ...short], async () => {
        calls++;
        throw auth;
      }),
    ).rejects.toBe(auth);
    expect(calls).toBe(1);
  });
});
