import { useState } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { EmptyState, ErrorBanner } from "./components.js";
import { Sparkline } from "./charts.js";
import {
  memberProjects,
  stateLabels,
  type ProjectState,
} from "@partner-report/contracts/member-overview";
import { useLeadershipData, useProjectProfiles } from "./leadership-data.js";
import "./leadership.css";

/** Projects a card shows before the rest fold behind a toggle, so a member with many projects doesn't dwarf the others. */
const COLLAPSED_PROJECTS = 4;

/** Leadership landing: one card per person, since each person owns their projects. */
export function MemberOverview() {
  const { activity, progress } = useLeadershipData();
  const profiles = useProjectProfiles().data?.items;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const a = activity.data;
  const p = progress.data;
  if (!a || !p)
    return (
      <section className="lc-overview" aria-label="成员总览">
        <ErrorBanner error={activity.error ?? progress.error} />
        {activity.isLoading || progress.isLoading ? (
          <p role="status">加载总览…</p>
        ) : (
          <EmptyState title="总览暂不可用" />
        )}
      </section>
    );
  const members = p.members
    .map((member) => ({
      member,
      projects: memberProjects(member.id, p, a, profiles),
      active: a.members.find((item) => item.id === member.id),
    }))
    .filter((entry) => entry.projects.length > 0)
    .sort((x, y) => x.member.name.localeCompare(y.member.name, "zh-CN"));
  const count = (state: ProjectState) =>
    members.reduce(
      (sum, entry) =>
        sum + entry.projects.filter((item) => item.state === state).length,
      0,
    );
  return (
    <section className="lc-overview" aria-label="成员总览">
      <div className="lc-kpis lc-kpis-3">
        <div className="lc-kpi">
          <span>成员</span>
          <strong>{members.length}</strong>
        </div>
        <div className="lc-kpi">
          <span>负责的项目</span>
          <strong>
            {members.reduce((sum, entry) => sum + entry.projects.length, 0)}
          </strong>
        </div>
        <div className="lc-kpi">
          <span>需要关注</span>
          <strong
            className={count("blocked") + count("stalled") ? "is-warn" : ""}
          >
            {count("blocked") + count("stalled")}
          </strong>
          <small className="lc-delta">
            有卡点 {count("blocked")} · 停滞 {count("stalled")}
          </small>
        </div>
      </div>
      {members.length ? (
        <div className="lc-cards">
          {members.map(({ member, projects, active }) => {
            const open = expanded.has(member.id);
            const hidden = projects.length - COLLAPSED_PROJECTS;
            return (
              <Link
                key={member.id}
                href={`/admin/members/${member.id}`}
                className="lc-card lc-member"
                aria-label={`查看 ${member.name} 的项目`}
              >
                <header>
                  <h4 className="lc-member-name">{member.name}</h4>
                  <span className="lc-muted">{projects.length} 个项目</span>
                  <ChevronRight size={16} />
                </header>
                <ul className="lc-member-projects">
                  {(open || hidden <= 0
                    ? projects
                    : projects.slice(0, COLLAPSED_PROJECTS)
                  ).map(({ project, profile, state, focus }) => (
                    <li key={project.projectId}>
                      <div>
                        <strong>{project.projectName}</strong>
                        <span className={`lc-badge is-${state}`}>
                          {stateLabels[state]}
                        </span>
                      </div>
                      <p>{profile?.note.oneLine.text || focus}</p>
                    </li>
                  ))}
                </ul>
                {hidden > 0 && (
                  <button
                    type="button"
                    className="lc-member-more"
                    aria-expanded={open}
                    onClick={(event) => {
                      // The whole card is a link; this button only toggles the list.
                      event.preventDefault();
                      event.stopPropagation();
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (!next.delete(member.id)) next.add(member.id);
                        return next;
                      });
                    }}
                  >
                    {open ? "收起" : `展开其余 ${hidden} 个项目`}
                  </button>
                )}
                <footer>
                  <Sparkline
                    values={a.daily
                      .slice(-14)
                      .map((day) => active?.byDay[day.date] ?? 0)}
                    label={`${member.name} 近 14 天活跃度`}
                  />
                  <small>近两周活跃度</small>
                </footer>
              </Link>
            );
          })}
        </div>
      ) : (
        <EmptyState title="还没有已审核的项目进展" />
      )}
    </section>
  );
}
