import { describe, expect, it } from "vitest";
import {
  containsSensitive,
  isCompleteTurn,
  mappedProject,
  normalizeProgressTurns,
  redactSensitive,
  selectIncrementalTurns,
} from "./scan.js";

describe("project folder mapping", () => {
  const projects = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "主项目",
      aliases: [],
      allowed_paths: ["/work/main"],
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "嵌套项目",
      aliases: [],
      allowed_paths: ["/work/main/nested"],
    },
  ];

  it("maps a project root and its subfolders to the configured project", () => {
    expect(mappedProject("/work/main", projects)).toMatchObject({
      id: projects[0]!.id,
      matchMethod: "exact_root",
    });
    expect(mappedProject("/work/main/src/feature", projects)).toMatchObject({
      id: projects[0]!.id,
      matchMethod: "descendant_path",
    });
  });

  it("uses the longest configured root for nested projects", () => {
    const mapped = mappedProject("/work/main/nested/src", projects);
    expect(mapped).toMatchObject({
      id: projects[1]!.id,
      matchMethod: "descendant_path",
    });
    expect(mapped?.rootFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

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

  it("accepts only a complete question and final answer", () => {
    expect(isCompleteTurn(turns[0]!)).toBe(true);
    expect(isCompleteTurn(turns[1]!)).toBe(false);
    expect(isCompleteTurn({ ...turns[0]!, status: "in_progress" })).toBe(false);
    expect(isCompleteTurn({ ...turns[0]!, assistantFinal: null })).toBe(false);
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
