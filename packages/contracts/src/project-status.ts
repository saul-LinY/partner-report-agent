import { z } from "zod";

export const projectStatusLabels = {
  research: "调研中",
  development: "开发中",
  delivery: "交付中",
  paused: "已暂停",
} as const;

export const projectStatusSchema = z.enum([
  "research",
  "development",
  "delivery",
  "paused",
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectStatusDescriptions: Record<ProjectStatus, string> = {
  research: "搜索资料、探索方案，明确需求和技术可行性。",
  development: "编写代码、实现功能，以及联调、测试和修复问题。",
  delivery: "主要功能已具备，正在部署实施、上线或验收。",
  paused: "工作暂时中断或搁置，当前没有继续推进。",
};

export function readProjectStatus(
  payload: Record<string, unknown>,
): ProjectStatus | undefined {
  const parsed = projectStatusSchema.safeParse(payload.projectStatus);
  return parsed.success ? parsed.data : undefined;
}

/** Legacy cards still need a visible, editable default; this is not confirmation. */
export function defaultProjectStatus(workStatus: string): ProjectStatus {
  return ["discussion", "planned"].includes(workStatus)
    ? "research"
    : "development";
}

export type ConfirmedProjectStatus = {
  value: ProjectStatus;
  reason: string;
  confirmedAt: string;
  periodKey: string | null;
  reviewId: string | null;
  source: "work_card" | "manual";
};
