import { useState } from "react";
import { Bot, UserRound } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EmptyState } from "./components.js";

export type SessionDetail = {
  uploadId: string;
  sessionId: string;
  agent: string;
  title: string;
  modifiedAt: string;
  partnerName: string;
  periodKey: string;
  projectName: string;
  turns: Array<{
    id: string;
    prompt: string;
    answer?: string | null;
    questionTime: string;
    answerTime?: string | null;
    model?: string | null;
  }>;
};

export type Overview = {
  partners: Array<{ id: string; display_name: string }>;
  periods: Array<{ id: string; period_key: string }>;
};

// Long sessions render progressively; each step keeps the page responsive.
const TURN_BATCH = 20;
// Messages above this size start collapsed so one paste cannot bury the thread.
const COLLAPSE_CHARS = 1_200;
const COLLAPSE_LINES = 18;

export const agentLabels: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
  hermes: "Hermes",
  omp: "OMP",
  grokbuild: "Grok Build",
  agy: "Antigravity",
};

export function Transcript({ session }: { session: SessionDetail }) {
  const [visible, setVisible] = useState(TURN_BATCH);
  const remaining = session.turns.length - visible;
  return (
    <div className="sx-detail">
      <header className="aw-detail-header">
        <div>
          <span className="aw-kicker">
            {agentLabels[session.agent] ?? session.agent} · {session.periodKey}
          </span>
          <h2>{session.title || "未命名会话"}</h2>
          <p>
            {session.partnerName} · {session.projectName} · 最后活动{" "}
            {formatTime(session.modifiedAt)} · {session.turns.length} 轮对话
          </p>
        </div>
      </header>
      {session.turns.length ? (
        <ol className="sx-thread">
          {session.turns.slice(0, visible).map((turn, index) => (
            <li key={turn.id} className="sx-turn">
              <div className="sx-turn-index">第 {index + 1} 轮</div>
              <Message
                role="user"
                label="提问"
                time={turn.questionTime}
                text={turn.prompt}
              />
              {turn.answer?.trim() ? (
                <Message
                  role="assistant"
                  label={turn.model ? `回复 · ${turn.model}` : "回复"}
                  time={turn.answerTime ?? null}
                  text={turn.answer}
                />
              ) : (
                <p className="sx-no-answer">未记录回复</p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title="此会话没有对话内容" />
      )}
      {remaining > 0 && (
        <div className="sx-more">
          <button
            type="button"
            className="button"
            onClick={() => setVisible((value) => value + TURN_BATCH)}
          >
            显示后续 {Math.min(remaining, TURN_BATCH)} 轮（剩余 {remaining} 轮）
          </button>
        </div>
      )}
    </div>
  );
}

function Message({
  role,
  label,
  time,
  text,
}: {
  role: "user" | "assistant";
  label: string;
  time: string | null;
  text: string;
}) {
  const long =
    text.length > COLLAPSE_CHARS || text.split("\n").length > COLLAPSE_LINES;
  const [expanded, setExpanded] = useState(false);
  const Icon = role === "user" ? UserRound : Bot;
  return (
    <section className={`sx-message sx-${role}`}>
      <header>
        <Icon size={14} />
        <strong>{label}</strong>
        {time && <time>{time}</time>}
      </header>
      <div className={`sx-body ${long && !expanded ? "is-collapsed" : ""}`}>
        {role === "assistant" ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        ) : (
          <p className="sx-plain">{text}</p>
        )}
      </div>
      {long && (
        <button
          type="button"
          className="aw-text-button sx-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `展开全文（${text.length.toLocaleString()} 字）`}
        </button>
      )}
    </section>
  );
}

export function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}
