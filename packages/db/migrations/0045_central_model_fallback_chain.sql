ALTER TABLE "teams" ALTER COLUMN "central_model" SET DEFAULT 'deepseek-v4.1-flash:cloud';--> statement-breakpoint
UPDATE "teams" SET "central_model" = 'deepseek-v4.1-flash:cloud' WHERE "central_model" NOT IN ('deepseek-v4.1-flash:cloud', 'deepseek-v4-pro:cloud', 'glm-5.2:cloud', 'kimi-k2.6:cloud', 'kimi-k2.7-code:cloud', 'minimax-m3:cloud');
