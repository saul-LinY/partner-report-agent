import { describe, expect, it } from "vitest";
import {
  memberProjects,
  type Activity,
  type ProjectState,
} from "./member-overview.js";
import {
  applyBlockerResolutions,
  type ProgressProject,
  type ProjectKeyEvent,
  type ProjectProgressResponse,
} from "./project-progress.js";

const today = "2026-11-17";
const project = (overrides: Partial<ProgressProject>) =>
  ({
    partnerId: "member",
    projectId: "project",
    projectName: "项目 A",
    keyEvents: [],
    outlook: null,
    currentFocus: null,
    latestProgress: null,
    ...overrides,
  }) as ProgressProject;
const progress = (item: ProgressProject) =>
  ({ today, projects: [item] }) as unknown as ProjectProgressResponse;
// Active yesterday: without other signals the project is in progress.
const activity = {
  members: [
    {
      id: "member",
      byProject: {
        "项目 A": { turns: 3, lastActiveDate: "2026-11-16", byDay: {} },
        "项目 B": { turns: 3, lastActiveDate: "2026-10-18", byDay: {} },
        "项目 C": { turns: 3, lastActiveDate: "2026-10-19", byDay: {} },
      },
    },
  ],
} as unknown as Activity;
const blocker: ProjectKeyEvent = {
  type: "blocker",
  date: "2026-11-15",
  title: "等待外部依赖",
  detail: "",
  step: null,
  periodKey: "2026-W47",
  reviewId: null,
};
const cases: Array<[string, Partial<ProgressProject>, ProjectState]> = [
  ["recently active", {}, "ok"],
  ["recently blocked", { keyEvents: [blocker] }, "blocked"],
  [
    "open blocker from an earlier work card",
    { keyEvents: [{ ...blocker, periodKey: "2026-W46" }] },
    "ok",
  ],
  ["collection stopped while active", { collectionStopped: true }, "stalled"],
  [
    "collection stopped while blocked",
    { collectionStopped: true, keyEvents: [blocker] },
    "stalled",
  ],
  [
    "blocker resolved",
    { keyEvents: [{ ...blocker, resolvedOn: "2026-11-16" }] },
    "ok",
  ],
  [
    "idle 30 days, blocker still open",
    { projectName: "项目 B", keyEvents: [blocker] },
    "shelved",
  ],
  ["idle 30 days", { projectName: "项目 B" }, "shelved"],
  ["idle 29 days", { projectName: "项目 C" }, "stalled"],
];

describe("member project state", () => {
  it.each(cases)("%s → %s", (_, overrides, state) => {
    const [card] = memberProjects(
      "member",
      progress(project(overrides)),
      activity,
      [],
      "2026-W47",
    );
    expect(card?.state).toBe(state);
  });
  it("lists only blockers raised on the latest work card", () => {
    const [card] = memberProjects(
      "member",
      progress(
        project({
          keyEvents: [
            { ...blocker, title: "本期已解决", resolvedOn: "2026-11-16" },
            {
              ...blocker,
              title: "上期已解决",
              periodKey: "2026-W46",
              resolvedOn: "2026-11-16",
            },
          ],
        }),
      ),
      activity,
      [],
      "2026-W47",
    );
    expect(card?.resolved.map((event) => event.title)).toEqual(["本期已解决"]);
    expect(card?.blocker).toBeUndefined();
  });
});

describe("blocker resolution precedence", () => {
  const card = { date: blocker.date, title: blocker.title };
  const resolved = (
    cardOn: string[],
    mark?: { resolved: boolean; resolvedOn: string },
  ) =>
    applyBlockerResolutions(
      [blocker],
      cardOn.map((resolvedOn) => ({ ...card, resolvedOn })),
      mark ? [{ ...card, ...mark }] : [],
    )[0];
  it("takes the earliest approved card resolution", () => {
    expect(resolved(["2026-11-17", "2026-11-16"])).toMatchObject({
      resolvedOn: "2026-11-16",
      resolvedBy: "model",
    });
  });
  it("carries the resolving card's evidence onto the resolved blocker", () => {
    const [event] = applyBlockerResolutions(
      [{ ...blocker, neededSupport: "需要审批" }],
      [{ ...card, resolvedOn: "2026-11-16", evidence: " 已上线 " }],
      [],
    );
    expect(event).toMatchObject({
      neededSupport: "需要审批",
      resolvedOn: "2026-11-16",
      resolvedEvidence: "已上线",
    });
  });
  it("lets a manual mark close an open blocker or reopen one a card closed", () => {
    expect(
      resolved([], { resolved: true, resolvedOn: "2026-11-17" }),
    ).toMatchObject({ resolvedOn: "2026-11-17", resolvedBy: "manual" });
    expect(
      resolved(["2026-11-16"], { resolved: false, resolvedOn: "2026-11-17" })
        ?.resolvedOn,
    ).toBeUndefined();
  });
  it("matches by date and title, ignoring surrounding spaces in the title", () => {
    expect(
      applyBlockerResolutions(
        [blocker],
        [
          {
            date: blocker.date,
            title: ` ${blocker.title} `,
            resolvedOn: "2026-11-16",
          },
        ],
        [],
      )[0]?.resolvedOn,
    ).toBe("2026-11-16");
    expect(
      applyBlockerResolutions(
        [blocker],
        [
          {
            date: "2026-11-14",
            title: blocker.title,
            resolvedOn: "2026-11-16",
          },
        ],
        [],
      )[0]?.resolvedOn,
    ).toBeUndefined();
  });
});
