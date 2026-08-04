import { describe, expect, it } from "vitest";
import {
  anonymousSessionKey,
  buildSessionJob,
  containsSensitive,
  isPluginAdministrationSession,
  isPluginSystemThread,
  mappedProject,
  normalizeProgressTurns,
  redactSensitive,
  selectPeriodTurns,
} from "./scan.js";

const projects = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "main-project",
    aliases: [],
    allowed_paths: ["/work/main"],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "nested-project",
    aliases: [],
    allowed_paths: ["/work/main/nested"],
  },
];

const period = {
  period_key: "2026-W32",
  starts_at: "2026-08-03T00:00:00.000Z",
  ends_at: "2026-08-09T23:59:59.000Z",
};

function completeTurn(id: string, occurredAt = "2026-08-04T04:00:00.000Z") {
  return {
    id,
    status: "completed",
    completedAt: occurredAt,
    items: [
      {
        type: "userMessage",
        content: [{ type: "text", text: "完成项目采集架构" }],
      },
      {
        type: "agentMessage",
        phase: "commentary",
        text: "正在运行内部命令",
      },
      { type: "commandExecution", command: "npm test", cwd: "/work/main" },
      {
        type: "agentMessage",
        phase: "final_answer",
        text: "已完成 Session 级采集架构。",
      },
    ],
  };
}

describe("project mapping", () => {
  it("uses the longest configured project root", () => {
    expect(mappedProject("/work/main/nested/src", projects)).toMatchObject({
      id: projects[1]!.id,
      name: "nested-project",
      matchMethod: "descendant_path",
    });
  });

  it("discovers an unmatched path without returning its absolute path", () => {
    const mapped = mappedProject("/private/work/new-project", projects);
    expect(mapped).toMatchObject({
      id: null,
      name: "new-project",
      rootName: "new-project",
      matchMethod: "path_discovered",
    });
    expect(mapped.rootFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(mapped)).not.toContain("/private/work");
  });

  it("keeps a Session without cwd unassigned", () => {
    expect(mappedProject(null, projects)).toMatchObject({
      id: null,
      name: "Independent work",
      matchMethod: "unassigned",
    });
  });
});

describe("safe Session input", () => {
  it("keeps only complete user prompts and final answers", () => {
    const turns = normalizeProgressTurns([
      completeTurn("one"),
      {
        id: "two",
        status: "interrupted",
        items: [
          { type: "userMessage", content: "继续" },
          { type: "agentMessage", phase: "commentary", text: "处理中" },
        ],
      },
    ]);
    expect(turns[0]).toMatchObject({
      userPrompt: "完成项目采集架构",
      assistantFinal: "已完成 Session 级采集架构。",
    });
    expect(JSON.stringify(turns)).not.toContain("npm test");
    expect(JSON.stringify(turns)).not.toContain("内部命令");
    expect(selectPeriodTurns(turns, period)).toHaveLength(1);
  });

  it("uses the report period instead of a Turn cursor", () => {
    const turns = normalizeProgressTurns([
      completeTurn("old", "2026-08-02T23:59:59.000Z"),
      completeTurn("current", "2026-08-04T04:00:00.000Z"),
    ]);
    expect(selectPeriodTurns(turns, period).map((turn) => turn.id)).toEqual([
      "current",
    ]);
  });

  it("builds anonymous Session metadata and never includes the raw path or id", () => {
    const job = buildSessionJob({
      pluginInstanceId: "33333333-3333-4333-8333-333333333333",
      sessionId: "raw-codex-session-id",
      title: "架构重构",
      cwd: "/work/main/src",
      turns: [completeTurn("one")],
      projects,
      period,
      observedAt: "2026-08-04T05:00:00.000Z",
    });
    expect(job).not.toBeNull();
    expect(job!.sessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(job!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(job!.modelInput.screeningPolicy).toMatchObject({
      includeOnlyWhenSessionContainsMeaningfulProjectContribution: true,
      projectDirectoryAloneIsNotEvidenceOfRelevance: true,
    });
    const serialized = JSON.stringify(job);
    expect(serialized).not.toContain("raw-codex-session-id");
    expect(serialized).not.toContain("/work/main");
  });

  it("produces stable anonymous keys inside one binding", () => {
    expect(anonymousSessionKey("binding", "session")).toBe(
      anonymousSessionKey("binding", "session"),
    );
    expect(anonymousSessionKey("binding-a", "session")).not.toBe(
      anonymousSessionKey("binding-b", "session"),
    );
  });
});

describe("local filtering", () => {
  it("redacts and detects credential-shaped values", () => {
    expect(redactSensitive("api_key=abcdefghijklmnop").text).toBe(
      "[REDACTED_SECRET]",
    );
    expect(
      containsSensitive({ value: "Bearer abcdefghijklmnopqrstuvwxyz.123" }),
    ).toBe(true);
  });

  it("excludes plugin administration but keeps product development", () => {
    expect(
      isPluginSystemThread({ name: "Partner Report daily collection" }),
    ).toBe(true);
    expect(
      isPluginAdministrationSession([
        {
          id: "one",
          status: "completed",
          occurredAt: null,
          userPrompt: "配置 Partner Report 定时任务",
          assistantFinal: "已配置",
        },
      ]),
    ).toBe(true);
    expect(
      isPluginAdministrationSession([
        {
          id: "one",
          status: "completed",
          occurredAt: null,
          userPrompt: "重构 Partner Report 的 Session 采集架构",
          assistantFinal: "已完成重构",
        },
      ]),
    ).toBe(false);
  });
});
