import { z } from "zod";
import { redactCredentials } from "./privacy.js";

export const collectorSessionSchema = z
  .object({
    id: z.string().min(1).max(1024),
    scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
    agent: z.enum([
      "codex",
      "claude",
      "opencode",
      "pi",
      "hermes",
      "omp",
      "grokbuild",
      "agy",
    ]),
    title: z.string().max(4096),
    modifiedAt: z.string().datetime(),
    turns: z
      .array(
        z
          .object({
            id: z.string().min(1).max(1024),
            prompt: z.string(),
            answer: z.string().nullable().optional(),
            questionTime: z.string(),
            answerTime: z.string().nullable().optional(),
            model: z.string().nullable().optional(),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();
export type CollectorSession = z.infer<typeof collectorSessionSchema>;

/** Keys, tokens and passwords never reach storage; ids, times and every other word stay as sent. */
export function redactSessionCredentials(
  sessions: CollectorSession[],
): CollectorSession[] {
  return sessions.map((session) => ({
    ...session,
    title: redactCredentials(session.title),
    turns: session.turns.map((turn) => ({
      ...turn,
      prompt: redactCredentials(turn.prompt),
      answer:
        turn.answer == null ? turn.answer : redactCredentials(turn.answer),
    })),
  }));
}

export const collectorExtractionSchema = z
  .object({
    decision: z.enum(["include", "ignore"]),
    reason: z.string().max(300),
    title: z.string().max(200),
    summary: z.string().max(1600),
    contributions: z
      .array(
        z
          .object({
            kind: z.enum([
              "outcome",
              "progress",
              "decision",
              "blocker",
              "next_step",
            ]),
            text: z.string().min(1).max(600),
            confidence: z.enum(["high", "medium", "low"]),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            evidenceRefs: z.array(z.string().min(1)).min(1).max(20),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();
export type CollectorExtraction = z.infer<typeof collectorExtractionSchema>;

export function collectorPipelineStage(upload: Record<string, any>) {
  if (upload.device_status === "test")
    return { stage: "test", label: "模拟历史", tone: "neutral" as const };
  if (upload.status === "superseded")
    return {
      stage: "superseded",
      label: "旧包已替代",
      tone: "neutral" as const,
    };
  if (upload.status !== "completed")
    return { stage: "receiving", label: "接收中", tone: "warning" as const };
  if (upload.analysis_failed > 0)
    return {
      stage: "analysis_failed",
      label: "分析失败",
      tone: "danger" as const,
    };
  if (upload.analysis_retrying > 0)
    return {
      stage: "analysis_retrying",
      label: "分析等待重试",
      tone: "warning" as const,
    };
  if (
    !upload.analysis_enqueued_at ||
    upload.analysis_completed + (upload.analysis_superseded ?? 0) <
      upload.analysis_total
  )
    return {
      stage: "analyzing",
      label: upload.analysis_running ? "分析中" : "等待分析",
      tone: "warning" as const,
    };
  if (
    upload.analysis_total > 0 &&
    upload.analysis_superseded === upload.analysis_total
  )
    return {
      stage: "superseded",
      label: "会话已由新包分析",
      tone: "neutral" as const,
    };
  if (
    (upload.analysis_total === 0 ||
      upload.analysis_ignored === upload.analysis_total) &&
    !upload.pending_cards
  )
    return {
      stage: "no_activity",
      label: "无可汇报贡献",
      tone: "neutral" as const,
    };
  if (upload.card_job_status === "FAILED")
    return {
      stage: "cards_failed",
      label: "卡片生成失败",
      tone: "danger" as const,
    };
  if (upload.card_job_status === "RETRY_WAIT")
    return {
      stage: "cards_retrying",
      label: "卡片生成等待重试",
      tone: "warning" as const,
    };
  if (["PENDING", "LEASED"].includes(upload.card_job_status))
    return {
      stage: "generating_cards",
      label: "卡片生成中",
      tone: "warning" as const,
    };
  if (!upload.review_id)
    return {
      stage: "waiting_cards",
      label: "等待整合",
      tone: "warning" as const,
    };
  if (
    upload.review_state === "IN_PROGRESS" ||
    upload.review_state === "PENDING"
  )
    return { stage: "review", label: "待审核", tone: "warning" as const };
  if (upload.report_status === "LOCKED")
    return { stage: "archived", label: "周报已归档", tone: "success" as const };
  if (upload.report_job_status === "FAILED")
    return {
      stage: "report_failed",
      label: "周报生成失败",
      tone: "danger" as const,
    };
  if (upload.report_job_status === "RETRY_WAIT")
    return {
      stage: "report_retrying",
      label: "周报生成等待重试",
      tone: "warning" as const,
    };
  if (
    [
      "TEAM_DRAFT",
      "DRAFT",
      "READY",
      "READY_FOR_REVIEW",
      "SUBMITTED",
      "REVIEWING",
      "PUBLISHED",
    ].includes(upload.report_status)
  )
    return {
      stage: "report_ready",
      label: "周报待确认",
      tone: "success" as const,
    };
  if (upload.report_status === "AGGREGATING")
    return {
      stage: "generating_report",
      label: "周报生成中",
      tone: "warning" as const,
    };
  return {
    stage: "reviewed",
    label: "审核完成，待汇总",
    tone: "success" as const,
  };
}
