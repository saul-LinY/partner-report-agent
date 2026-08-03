import { z } from "zod";

export const centralModelIds = [
  "deepseek-v4-flash:cloud",
  "deepseek-v4-pro:cloud",
  "gemini-3-flash-preview:cloud",
  "glm-5.1:cloud",
  "glm-5.2:cloud",
  "kimi-k2.6:cloud",
  "kimi-k2.7-code:cloud",
  "minimax-m3:cloud",
  "nemotron-3-super:cloud",
] as const;

export type CentralModelId = (typeof centralModelIds)[number];
export const centralModelIdSchema = z.enum(centralModelIds);
