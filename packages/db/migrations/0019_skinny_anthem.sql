ALTER TABLE "teams" ALTER COLUMN "period_rule" SET DEFAULT '{"frequency":"weekly","weekStartsOn":1,"factCutoffWeekday":5,"factCutoffTime":"17:00"}'::jsonb;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "collection_grace_minutes" SET DEFAULT 0;--> statement-breakpoint
UPDATE "teams" SET "collection_grace_minutes" = 0 WHERE "collection_grace_minutes" <> 0;
