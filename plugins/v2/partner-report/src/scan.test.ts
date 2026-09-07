import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "./config.js";
import {
  anonymousSessionKey,
  buildSessionJob,
  completeSessionTurns,
  containsSensitive,
  firstNonChineseContributionField,
  isOfficialAutomationThread,
  isPluginAdministrationSession,
  isPluginSystemThread,
  mappedProject,
  latestCompleteTurnInPeriod,
  normalizeProgressTurns,
  redactSensitive,
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

  it("does not reuse a path match when a different stable scope is supplied", () => {
    const cwd = "/private/work/recreated-project";
    const discovered = mappedProject(cwd, []);
    const oldProject = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "recreated-project",
      aliases: [],
      allowed_paths: [cwd],
      external_ids: [`path-sha256:${discovered.rootFingerprint}`],
    };
    expect(
      mappedProject(cwd, [oldProject], {
        pluginInstanceId: "binding",
        scopeKey: "a".repeat(64),
      }),
    ).toMatchObject({ id: null, matchMethod: "path_discovered" });

    const stableProject = {
      ...oldProject,
      external_ids: [`scope:binding:${"a".repeat(64)}`],
    };
    expect(
      mappedProject("/private/work/renamed-project", [stableProject], {
        pluginInstanceId: "binding",
        scopeKey: "a".repeat(64),
      }),
    ).toMatchObject({ id: stableProject.id });
  });

  it("keeps a Session without cwd unassigned", () => {
    expect(mappedProject(null, projects)).toMatchObject({
      id: null,
      name: "独立工作",
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
    expect(completeSessionTurns(turns)).toHaveLength(1);
    expect(latestCompleteTurnInPeriod(turns, period)?.id).toBe("one");
  });

  it("does not truncate complete Q&A content", () => {
    const longText = "完整内容".repeat(5_000);
    const turns = normalizeProgressTurns([
      {
        id: "long",
        status: "completed",
        completedAt: "2026-08-04T04:00:00.000Z",
        items: [
          { type: "userMessage", content: longText },
          {
            type: "agentMessage",
            phase: "final_answer",
            text: longText,
          },
        ],
      },
    ]);
    expect(turns[0]?.userPrompt).toBe(longText);
    expect(turns[0]?.assistantFinal).toBe(longText);
  });

  it("uses the latest complete Q&A to decide whether the Session is a candidate", () => {
    const turns = normalizeProgressTurns([
      completeTurn("old", "2026-08-02T23:59:59.000Z"),
      completeTurn("current", "2026-08-04T04:00:00.000Z"),
    ]);
    expect(latestCompleteTurnInPeriod(turns, period)?.id).toBe("current");
    expect(
      latestCompleteTurnInPeriod(
        normalizeProgressTurns([
          completeTurn("old", "2026-08-02T23:59:59.000Z"),
        ]),
        period,
      ),
    ).toBeNull();
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
    expect(job!.modelInput.language).toBe("zh-CN");
    expect(job!.modelInput.instructions).toEqual(
      expect.arrayContaining([expect.stringContaining("必须使用简体中文")]),
    );
    expect(job!.expected.production).toMatchObject({
      skillVersion: `partner-report-sync/${PLUGIN_VERSION}`,
      promptVersion: "2026-08-25.zh-whole-session-value.v4",
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

  it("hashes complete turns without mutable title or project metadata", () => {
    const cwd = "/work/new-project";
    const discovered = mappedProject(cwd, []);
    const registeredProjects = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: discovered.name,
        aliases: [],
        allowed_paths: [],
        external_ids: [`path-sha256:${discovered.rootFingerprint}`],
      },
    ];
    const first = buildSessionJob({
      pluginInstanceId: "binding",
      sessionId: "session",
      title: "旧标题",
      cwd,
      turns: [completeTurn("one")],
      projects: [],
      period,
    })!;
    const remapped = buildSessionJob({
      pluginInstanceId: "binding",
      sessionId: "session",
      title: "旧标题",
      cwd,
      turns: [completeTurn("one")],
      projects: registeredProjects,
      period,
    })!;
    expect(remapped.contentHash).toBe(first.contentHash);
    expect(remapped.compatibleContentHashes).toContain(
      first.compatibleContentHashes[0],
    );
    const renamed = buildSessionJob({
      pluginInstanceId: "binding",
      sessionId: "session",
      title: "自动更新后的标题",
      cwd,
      turns: [completeTurn("one")],
      projects: registeredProjects,
      period,
    })!;
    expect(renamed.contentHash).toBe(first.contentHash);
  });

  it("changes the content hash when a complete turn is added", () => {
    const first = buildSessionJob({
      pluginInstanceId: "binding",
      sessionId: "session",
      cwd: "/work/main",
      turns: [completeTurn("one")],
      projects,
      period,
    })!;
    const changed = buildSessionJob({
      pluginInstanceId: "binding",
      sessionId: "session",
      cwd: "/work/main",
      turns: [
        completeTurn("one"),
        completeTurn("two", "2026-08-05T04:00:00.000Z"),
      ],
      projects,
      period,
    })!;
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("keeps an unuploaded turn hash stable when the report period rolls over", () => {
    const input = {
      pluginInstanceId: "binding",
      sessionId: "session",
      cwd: "/work/main",
      turns: [completeTurn("one")],
      projects,
    };
    const first = buildSessionJob({ ...input, period })!;
    const next = buildSessionJob({
      ...input,
      period: { ...period, period_key: "2026-W33" },
    })!;
    expect(next.contentHash).toBe(first.contentHash);
  });

  it("sends the whole Session when an old Session gets a new complete Q&A", () => {
    const revised = buildSessionJob({
      pluginInstanceId: "binding",
      sessionId: "session",
      cwd: "/work/main",
      turns: [
        completeTurn("one", "2026-08-02T23:59:59.000Z"),
        completeTurn("two", "2026-08-05T04:00:00.000Z"),
      ],
      projects,
      period,
    })!;
    expect(revised.modelInput.session.turns).toEqual([
      expect.objectContaining({ occurredAt: "2026-08-02T23:59:59.000Z" }),
      expect.objectContaining({ occurredAt: "2026-08-05T04:00:00.000Z" }),
    ]);
    expect(revised.modelInput.instructions).toEqual(
      expect.arrayContaining([expect.stringContaining("全部完整问答")]),
    );
  });

  it("does not collect a Session whose latest complete Q&A is outside the window", () => {
    expect(
      buildSessionJob({
        pluginInstanceId: "binding",
        sessionId: "session",
        cwd: "/work/main",
        turns: [
          completeTurn("current", "2026-08-05T04:00:00.000Z"),
          completeTurn("later", "2026-08-10T04:00:00.000Z"),
        ],
        projects,
        period,
      }),
    ).toBeNull();
  });

  it("ignores an incomplete tail when locating the latest complete Q&A", () => {
    const job = buildSessionJob({
      pluginInstanceId: "binding",
      sessionId: "session",
      cwd: "/work/main",
      turns: [
        completeTurn("complete", "2026-08-05T04:00:00.000Z"),
        {
          id: "incomplete",
          status: "in_progress",
          updatedAt: "2026-08-10T04:00:00.000Z",
          items: [{ type: "userMessage", content: "继续" }],
        },
      ],
      projects,
      period,
    });
    expect(job?.modelInput.session.turns).toHaveLength(1);
  });

  it("requires Chinese titles, summaries, and contribution text", () => {
    expect(
      firstNonChineseContributionField({
        title: "完成采集改造",
        summary: "新增本地增量游标和防重状态。",
        contributions: [{ text: "首次运行只处理最近三天。" }],
      }),
    ).toBeNull();
    expect(
      firstNonChineseContributionField({
        title: "Collection update",
        summary: "新增本地增量游标和防重状态。",
        contributions: [{ text: "首次运行只处理最近三天。" }],
      }),
    ).toBe("title");
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
      isOfficialAutomationThread({
        source: { type: "scheduled_task" },
      }),
    ).toBe(true);
    expect(isOfficialAutomationThread({ thread_source: "automation" })).toBe(
      true,
    );
    expect(isOfficialAutomationThread({ ephemeral: true })).toBe(true);
    expect(isOfficialAutomationThread({ source: "appServer" })).toBe(false);
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
