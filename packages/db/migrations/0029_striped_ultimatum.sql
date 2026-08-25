ALTER TABLE "plugin_log_events" ADD COLUMN "invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_log_events" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "plugin_log_events" ADD COLUMN "command" text;--> statement-breakpoint
ALTER TABLE "plugin_log_events" ADD COLUMN "event_type" text;--> statement-breakpoint
CREATE INDEX "plugin_log_events_invocation_recent_idx" ON "plugin_log_events" USING btree ("tenant_id","invocation_id","occurred_at");