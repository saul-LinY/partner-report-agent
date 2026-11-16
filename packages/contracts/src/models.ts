import { z } from "zod";

/** Supported central models, in fallback priority order. The first entry is the default. */
export const centralModelIds = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "hy4",
  "hy4-preview",
  "mimo-v2.6-flash",
] as const;

export type CentralModelId = (typeof centralModelIds)[number];
export const centralModelIdSchema = z.enum(centralModelIds);
