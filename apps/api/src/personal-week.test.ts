import { describe, expect, it } from "vitest";
import type {
  MemberProject,
  ProjectState,
} from "@partner-report/contracts/member-overview";
import type { ProjectProfileNote } from "@partner-report/contracts/project-profile";
import {
  assemblePersonalWeek,
  teamMinute,
  type PersonalWeekInput,
} from "./personal-week.js";

const TZ = "Asia/Shanghai";
const period = {
  periodKey: "2026-W47",
  startsAt: new Date("2026-11-17T11:10:00+08:00"),
  cutoffAt: new Date("2026-11-20T16:00:00+08:00"),
};
const contribution = (
  kind: string,
  text: string,
  date: string,
  plain?: string,
) => ({ kind, text, plain, date });
const claim = (text: string) => ({ text, refs: [] });
const note = (
  oneLine: string,
  over: { status?: string; intro?: string } = {},
) => ({
  oneLine: claim(oneLine),
  intro: claim(over.intro ?? ""),
  features: [claim("功能一")],
  status: claim(over.status ?? ""),
  openIssues: [claim("风险一")],
});
/** The fields of a leadership project card this page reads. */
const card = (
  name: string,
  state: ProjectState,
  focus: string | null,
  days: number,
  profile?: ProjectProfileNote,
) =>
  ({
    project: {
      projectName: name,
      currentFocus: focus ? { text: focus } : null,
      contributionDays: days,
    },
    profile: profile && { note: profile },
    state,
  }) as unknown as MemberProject;

const base = (over: Partial<PersonalWeekInput> = {}): PersonalWeekInput => ({
  now: new Date("2026-11-18T10:40:30+08:00"),
  timezone: TZ,
  member: { id: "m1", name: "saul" },
  period,
  facts: [
    {
      sessionId: "s1",
      project: "A",
      contributions: [
        contribution("outcome", "原文一", "2026-11-17", "成果一"),
        contribution("outcome", "原文二", "2026-11-17", "  "),
        contribution("decision", "决定原文", "2026-11-17", "决定一"),
        contribution("progress", "不展示", "2026-11-17", "不展示"),
      ],
    },
    {
      sessionId: "s2",
      project: "A",
      contributions: [
        contribution("outcome", "原文三", "2026-11-18", "成果三"),
        contribution("outcome", "原文四", "2026-11-18", "成果四"),
        contribution("blocker", "卡点原文", "2026-11-18", "卡点一"),
      ],
    },
  ],
  events: [
    { t: "2026-11-17T11:09", p: "A" },
    { t: "2026-11-17T11:10", p: "A" },
    { t: "2026-11-17T20:00", p: "A" },
    { t: "2026-11-18T10:40", p: "B" },
    { t: "2026-11-18T10:41", p: "B" },
  ],
  window: { from: "2026-08-21", to: "2026-11-18" },
  lastActiveDate: {
    A: "2026-11-18",
    B: "2026-11-18",
    Old: "2026-11-02",
    Gone: "2026-11-01",
  },
  allowed: new Set(["A", "B", "Old"]),
  oneLines: new Map([["A", "甲项目"]]),
  memberProjects: [
    card("B", "blocked", null, 2, note("  ", { status: "乙现状" })),
    card("Old", "stalled", "旧重点", 9),
    card("A", "ok", "甲重点", 6, note("甲项目", { intro: "甲简介" })),
    card("Gone", "ok", "不再授权", 1),
  ],
  lastUpload: { at: new Date("2026-11-17T08:00:00Z"), status: "completed" },
  ...over,
});

describe("teamMinute", () => {
  it("renders the team's wall clock in the activity event form", () => {
    expect(teamMinute(new Date("2026-11-17T03:10:59Z"), TZ)).toBe(
      "2026-11-17T11:10",
    );
    expect(teamMinute(new Date("2026-11-17T16:30:00Z"), TZ)).toBe(
      "2026-11-18T00:30",
    );
  });
});

describe("assemblePersonalWeek", () => {
  it("windows turns from the period start to now, and totals them", () => {
    const data = assemblePersonalWeek(base());
    expect(data.events.map((e) => e.t)).toEqual([
      "2026-11-17T11:10",
      "2026-11-17T20:00",
      "2026-11-18T10:40",
    ]);
    expect(data.totals).toEqual({
      sessions: 2,
      turns: 3,
      activeDays: 2,
      elapsedDays: 2,
    });
    expect(data.generatedAt).toBe("2026-11-18T02:40:30.000Z");
    expect(data.lastUpload).toEqual({
      at: "2026-11-17T08:00:00.000Z",
      status: "completed",
    });
  });

  it("carries the schedule: cutoff, Monday 12:00 auto approval, Monday 13:00 publish", () => {
    const { period: shown } = assemblePersonalWeek(base());
    expect(shown).toEqual({
      periodKey: "2026-W47",
      startsAt: "2026-11-17T03:10:00.000Z",
      cutoffAt: "2026-11-20T08:00:00.000Z",
      autoApproveAt: "2026-11-23T04:00:00.000Z",
      publishAt: "2026-11-23T05:00:00.000Z",
    });
  });

  it("shows the newest items per kind, plain else text, with the full count", () => {
    const [a] = assemblePersonalWeek(base()).projects;
    expect(a).toMatchObject({
      name: "A",
      oneLine: "甲项目",
      sessions: 2,
      turns: 2,
      lastAt: "2026-11-17T20:00",
      lastActiveDate: "2026-11-18",
      outcomes: { items: ["成果四", "成果三", "原文二"], total: 4 },
      decisions: { items: ["决定一"], total: 1 },
      problems: { items: ["卡点一"], total: 1 },
    });
  });

  it("keeps turn-only and dormant allowed projects, drops disallowed ones, and sorts them last", () => {
    const { projects } = assemblePersonalWeek(base());
    expect(projects.map((p) => p.name)).toEqual(["A", "B", "Old"]);
    expect(projects[1]).toMatchObject({
      sessions: 0,
      turns: 1,
      outcomes: { items: [], total: 0 },
    });
    expect(projects[2]).toMatchObject({
      sessions: 0,
      turns: 0,
      lastAt: null,
      lastActiveDate: "2026-11-02",
      oneLine: null,
    });
  });

  it("ends the window and the day count at the cutoff once it has passed", () => {
    const data = assemblePersonalWeek(
      base({
        now: new Date("2026-11-21T09:00:00+08:00"),
        events: [
          { t: "2026-11-20T15:59", p: "A" },
          { t: "2026-11-20T16:00", p: "A" },
        ],
      }),
    );
    expect(data.events.map((e) => e.t)).toEqual(["2026-11-20T15:59"]);
    expect(data.totals.elapsedDays).toBe(4);
  });

  it("has no last upload when the member never uploaded", () => {
    expect(
      assemblePersonalWeek(base({ lastUpload: null })).lastUpload,
    ).toBeNull();
  });

  it("gives 工作投入 only allowed turns, and 负责的项目 the leadership page's moving projects that are still allowed", () => {
    const data = assemblePersonalWeek(
      base({
        events: [...base().events, { t: "2026-11-18T10:42", p: "Gone" }],
      }),
    );
    expect(data.history.from).toBe("2026-08-21");
    expect(data.history.events.map((e) => e.p)).not.toContain("Gone");
    expect(data.history.events).toHaveLength(5);
    expect(data.owned).toEqual([
      {
        name: "B",
        oneLine: null,
        focus: "乙现状",
        intro: null,
        contributionDays: 2,
        features: ["功能一"],
        openIssues: ["风险一"],
      },
      {
        name: "A",
        oneLine: "甲项目",
        focus: "甲重点",
        intro: "甲简介",
        contributionDays: 6,
        features: ["功能一"],
        openIssues: ["风险一"],
      },
    ]);
  });
});
