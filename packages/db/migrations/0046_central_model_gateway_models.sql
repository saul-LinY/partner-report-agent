ALTER TABLE "teams" ALTER COLUMN "central_model" SET DEFAULT 'deepseek-v4.1-flash';--> statement-breakpoint
UPDATE "teams" SET "central_model" = 'deepseek-v4.1-flash' WHERE "central_model" NOT IN ('deepseek-v4.1-flash', 'glm-5.3-flash', 'hy4', 'hy4-preview', 'mimo-v2.6-flash');
