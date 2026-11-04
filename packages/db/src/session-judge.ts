/** Only this many leading prompts are sampled; longer sessions are never judged trivial. */
export const PROMPT_SAMPLE_TURNS = 20;

/** Bump when judgeSession changes; stale machine verdicts are re-evaluated. */
export const RULE_VERSION = 1;

export type Verdict = "keep" | "drop";
export type DropReason = "test" | "chitchat" | "empty";
export type Judgement = { verdict: "keep" } | { verdict: "drop"; reason: DropReason };

const TEST_WORDS: Record<string, true> = {
  test: true,
  tests: true,
  testing: true,
  teat: true,
  tset: true,
  ping: true,
  测试: true,
  测试一下: true,
  试一下: true,
  试试: true,
  测试消息: true,
};
const CHITCHAT_WORDS: Record<string, true> = {
  hi: true,
  hello: true,
  hey: true,
  你好: true,
  您好: true,
  哈喽: true,
  嗨: true,
  在吗: true,
  在不在: true,
  谢谢: true,
  thanks: true,
  thankyou: true,
  ok: true,
  好的: true,
};

function classifyPrompt(prompt: string | null): DropReason | null {
  const trimmed = (prompt ?? "").trim();
  if (!trimmed) return "empty";
  // A bare slash command (e.g. "/language") carries no task.
  if (/^\/[\w-]+$/.test(trimmed)) return "empty";
  // Lower-case and strip whitespace/punctuation so "Test!" and "你好。" match.
  const word = trimmed.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!word) return "empty";
  if (Object.hasOwn(TEST_WORDS, word)) return "test";
  if (Object.hasOwn(CHITCHAT_WORDS, word)) return "chitchat";
  return null;
}

/**
 * Session-level usefulness. A session is dropped only when *every* user prompt
 * is trivial; doubtful sessions are kept so no real work is lost.
 */
export function judgeSession(session: {
  turnCount: number;
  prompts: Array<string | null>;
}): Judgement {
  if (session.turnCount === 0) return { verdict: "drop", reason: "empty" };
  // Only the leading prompts are sampled, so a longer session is real work.
  if (session.turnCount > PROMPT_SAMPLE_TURNS) return { verdict: "keep" };
  const reasons = session.prompts.map(classifyPrompt);
  if (reasons.length === 0 || reasons.some((reason) => reason === null))
    return { verdict: "keep" };
  const reason: DropReason = reasons.includes("test")
    ? "test"
    : reasons.includes("chitchat")
      ? "chitchat"
      : "empty";
  return { verdict: "drop", reason };
}
