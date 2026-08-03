ALTER TABLE "plugin_instances" ADD COLUMN "last_hook_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_runner_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "next_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "runner_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "dirty_sessions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "extracting_sessions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "session_quiet_period_minutes" integer DEFAULT 120 NOT NULL;