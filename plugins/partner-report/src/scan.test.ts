import { describe, expect, it } from "vitest";
import {
  containsSensitive,
  isCompleteTurn,
  isPluginAdministrationSession,
  isPluginSystemThread,
  mappedProject,
  normalizeProgressTurns,
  redactSensitive,
  selectIncrementalTurns,
  selectTurnsForCollectionRun,
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

  it("discovers an unmatched project path without exposing the path", () => {
    const mapped = mappedProject("/private/work/unmapped", projects);
    expect(mapped).toMatchObject({
      id: null,
      name: "unmapped",
      rootName: "unmapped",
      matchMethod: "path_discovered",
    });
    expect(mapped.rootFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(mapped)).not.toContain("/private/work/unmapped");
  });

  it("keeps a Session without a working directory as independent work", () => {
    expect(mappedProject(null, projects)).toMatchObject({
      id: null,
      name: "独立工作",
      matchMethod: "unassigned",
    });
  });

  it("reuses a server-discovered project by path fingerprint", () => {
    const first = mappedProject("/private/work/unmapped", projects);
    const discoveredProjects = [
      ...projects,
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "unmapped",
        aliases: [],
        allowed_paths: [],
        external_ids: [`path-sha256:${first.rootFingerprint}`],
      },
    ];
    expect(
      mappedProject("/private/work/unmapped", discoveredProjects),
    ).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      name: "unmapped",
      matchMethod: "exact_root",
    });
  });
});

describe("plugin system Session exclusion", () => {
  it.each([
    "Partner Report daily collection",
    "Partner Report collection continuation",
    "配置插件定时任务",
    "连接数据中台与绑定码",
    "连接设备到本地服务",
    "查看已安装插件内容",
    "连接数据中台与 partner-report",
  ])("excludes %s", (name) => {
    expect(isPluginSystemThread({ name })).toBe(true);
  });

  it("keeps ordinary Partner Report product work eligible", () => {
    expect(isPluginSystemThread({ name: "修复插件并打通中台传输" })).toBe(
      false,
    );
    expect(isPluginSystemThread({ name: "梳理插件工作流" })).toBe(false);
  });

  it("excludes only explicit Partner Report administration Turns", () => {
    expect(
      isPluginAdministrationSession([
        {
          id: "one",
          status: "completed",
          occurredAt: null,
          userPrompt: "查看我安装有哪些插件",
          assistantFinal: "已列出插件",
        },
        {
          id: "two",
          status: "completed",
          occurredAt: null,
          userPrompt: "卸载 Partner Report 插件",
          assistantFinal: "已卸载",
        },
      ]),
    ).toBe(true);
    expect(
      isPluginAdministrationSession([
        {
          id: "work",
          status: "completed",
          occurredAt: null,
          userPrompt: "修复 Partner Report 插件并打通中台传输",
          assistantFinal: "已完成研发工作",
        },
      ]),
    ).toBe(false);
  });

  it("excludes a Partner Report binding-code conversation", () => {
    expect(
      isPluginAdministrationSession([
        {
          id: "one",
          status: "completed",
          occurredAt: null,
          userPrompt: "使用 Partner Report 连接本地中台",
          assistantFinal: "已连接",
        },
        {
          id: "two",
          status: "completed",
          occurredAt: null,
          userPrompt: "重新生成没有过期的验证码",
          assistantFinal: "已重新生成",
        },
      ]),
    ).toBe(true);
  });

  it("excludes a direct Partner Report collection Skill invocation", () => {
    expect(
      isPluginAdministrationSession([
        {
          id: "one",
          status: "completed",
          occurredAt: null,
          userPrompt: "```\n$partner-report-sync\n```",
          assistantFinal: "Collection finished",
        },
      ]),
    ).toBe(true);
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
        occurredAt: null,
        userPrompt: "完成项目进展页",
        assistantFinal: "项目进展页已完成，并通过测试。",
      },
      {
        id: "turn-2",
        status: "interrupted",
        occurredAt: null,
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

  it("limits a cursorless first run to complete turns in the rolling window", () => {
    const bounded = selectTurnsForCollectionRun(
      [
        { ...turns[0]!, id: "old", occurredAt: "2026-08-02T11:59:59.000Z" },
        { ...turns[0]!, id: "current", occurredAt: "2026-08-03T18:00:00.000Z" },
        {
          ...turns[1]!,
          id: "unfinished",
          occurredAt: "2026-08-03T19:00:00.000Z",
        },
      ],
      null,
      {
        windowStartsAt: "2026-08-02T12:00:00.000Z",
        windowEndsAt: "2026-08-03T20:00:00.000Z",
      },
    );
    expect(bounded.turns.map((turn) => turn.id)).toEqual(["current"]);
    expect(bounded.hasIncompleteTurn).toBe(true);
  });

  it("catches up every turn after an acknowledged cursor across missed days", () => {
    const caughtUp = selectTurnsForCollectionRun(
      [
        {
          ...turns[0]!,
          id: "accepted",
          occurredAt: "2026-07-01T00:00:00.000Z",
        },
        {
          ...turns[0]!,
          id: "missed-1",
          occurredAt: "2026-07-02T00:00:00.000Z",
        },
        {
          ...turns[0]!,
          id: "missed-2",
          occurredAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      "accepted",
      {
        windowStartsAt: "2026-08-02T12:00:00.000Z",
        windowEndsAt: "2026-08-03T20:00:00.000Z",
      },
    );
    expect(caughtUp.turns.map((turn) => turn.id)).toEqual([
      "missed-1",
      "missed-2",
    ]);
  });

  it("does not advance an incomplete turn", () => {
    const result = selectTurnsForCollectionRun([turns[1]!], null, {
      windowStartsAt: "2026-08-03T00:00:00.000Z",
      windowEndsAt: "2026-08-04T00:00:00.000Z",
      fallbackOccurredAt: "2026-08-03T12:00:00.000Z",
    });
    expect(result.turns).toEqual([]);
    expect(result.hasIncompleteTurn).toBe(true);
  });
});
