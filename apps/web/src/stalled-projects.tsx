import { useState } from "react";
import type { MemberProject } from "@partner-report/contracts/member-overview";
import { Modal } from "./components.js";
import { stateText } from "./leadership-data.js";

export type QuietProject = { owner: string; item: MemberProject };

/** Stalled and shelved projects stay off the leadership pages' main view; this button lists them in a dialog. */
export function QuietProjectsButton({ projects }: { projects: QuietProject[] }) {
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;
  const stalled = projects.filter(({ item }) => item.state === "stalled").length;
  const shelved = projects.length - stalled;
  return (
    <>
      <button type="button" className="lb-quiet-button" onClick={() => setOpen(true)}>
        {[stalled && `停滞 ${stalled} 个`, shelved && `已搁置 ${shelved} 个`]
          .filter(Boolean)
          .join(" · ")}
      </button>
      {open && (
        <Modal title="停滞与搁置的项目" onClose={() => setOpen(false)}>
          <ul className="lb-quiet-list">
            {projects.map(({ owner, item }) => (
              <li key={`${item.project.partnerId}:${item.project.projectId}`}>
                <div className="lb-issue-top">
                  <span className={`lb-pill is-${item.state}`}>
                    {stateText[item.state]}
                  </span>
                  <span className="lb-issue-proj">{item.project.projectName}</span>
                  <span className="lb-issue-since">
                    {owner} ·{" "}
                    {item.project.collectionStopped
                      ? "已停止采集"
                      : item.idle === null
                        ? "没有活动记录"
                        : `${item.idle} 天没有新进展`}
                    {item.project.lastContributionDate &&
                      ` · 最后贡献 ${Number(item.project.lastContributionDate.slice(5, 7))}月${Number(item.project.lastContributionDate.slice(8))}日`}
                  </span>
                </div>
                <p>最后在做：{item.focus}</p>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}
