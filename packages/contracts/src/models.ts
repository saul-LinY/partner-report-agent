import { z } from "zod";

/** Supported central models, in fallback priority order. The first entry is the default. */
export const centralModelIds = [
  "deepseek-v4.1-flash:cloud",
  "deepseek-v4-pro:cloud",
  "glm-5.2:cloud",
  "kimi-k2.6:cloud",
  "kimi-k2.7-code:cloud",
  "minimax-m3:cloud",
] as const;

export type CentralModelId = (typeof centralModelIds)[number];
export const centralModelIdSchema = z.enum(centralModelIds);
