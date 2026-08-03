import { describe, expect, it } from "vitest";
import {
  containsSensitive,
  isSessionQuiet,
  normalizeProgressTurns,
  quietUntil,
  redactSensitive,
  selectIncrementalTurns,
} from "./scan.js";

describe("local session redaction", () => {
  it("redacts credentials before a turn can enter a local extraction task", () => {
    const value = "run with api_key=abcdefghijklmnop and continue";
    expect(redactSensitive(value)).toEqual({
      text: "run with [REDACTED_SECRET] and continue",
      replacements: 1,
    });
  });

  it("detects token-shaped values in structured extraction output", () => {
    expect(
      containsSensitive({ detail: "Bearer abcdefghijklmnopqrstuvwxyz.123" }),
    ).toBe(true);
    expect(containsSensitive({ detail: "报告生成成功" })).toBe(false);
  });

  it("waits for two hours of inactivity by default", () => {
    const lastActivity = "2026-08-02T01:00:00.000Z";
    expect(quietUntil(lastActivity)).toBe("2026-08-02T03:00:00.000Z");
    expect(
      isSessionQuiet(
        lastActivity,
        120,
        new Date("2026-08-02T02:59:59.999Z").getTime(),
      ),
    ).toBe(false);
    expect(
      isSessionQuiet(
        lastActivity,
        120,
        new Date("2026-08-02T03:00:00.000Z").getTime(),
      ),
    ).toBe(true);
  });
});

describe("progress-only turn input", () => {
  const turns = normalizeProgressTurns([
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: "完成项目进展页" }],
        },
        {
          type: "agentMessage",
          phase: "commentary",
          text: "正在读取代码和运行命令",
        },
        {
          type: "commandExecution",
          command: "npm test",
          cwd: "/repo",
          status: "completed",
          exitCode: 0,
        },
        {
          type: "fileChange",
          status: "completed",
          changes: [{ path: "src/App.tsx", kind: "update" }],
        },
        {
          type: "agentMessage",
          phase: "final_answer",
          text: "项目进展页已完成，并通过测试。",
        },
      ],
    },
    {
      id: "turn-2",
      status: "interrupted",
      items: [
        { type: "userMessage", content: "继续完善聚合" },
        { type: "agentMessage", phase: "commentary", text: "正在处理" },
      ],
    },
  ]);

  it("keeps only the user task and the final assistant answer", () => {
    expect(turns).toEqual([
      {
        id: "turn-1",
        status: "completed",
        userPrompt: "完成项目进展页",
        assistantFinal: "项目进展页已完成，并通过测试。",
      },
      {
        id: "turn-2",
        status: "interrupted",
        userPrompt: "继续完善聚合",
        assistantFinal: null,
      },
    ]);
    expect(JSON.stringify(turns)).not.toContain("npm test");
    expect(JSON.stringify(turns)).not.toContain("App.tsx");
    expect(JSON.stringify(turns)).not.toContain("正在读取");
  });

  it("treats a session without a cursor as new", () => {
    expect(selectIncrementalTurns(turns, null)).toMatchObject({
      mode: "new_session",
      cursorMatched: true,
      turns,
    });
  });

  it("reads only turns after the accepted cursor in a historical session", () => {
    expect(selectIncrementalTurns(turns, "turn-1")).toEqual({
      mode: "historical_session",
      cursorMatched: true,
      turns: [turns[1]],
    });
    expect(selectIncrementalTurns(turns, "turn-2").turns).toEqual([]);
  });

  it("rebuilds the bounded range when a historical cursor disappeared", () => {
    expect(selectIncrementalTurns(turns, "removed-turn")).toEqual({
      mode: "historical_session",
      cursorMatched: false,
      turns,
    });
  });
});
