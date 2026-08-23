CREATE TABLE "plugin_log_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"run_id" uuid,
	"level" text NOT NULL,
	"stage" text NOT NULL,
	"event_code" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"attempt" integer,
	"duration_ms" integer,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_log_events" ADD CONSTRAINT "plugin_log_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_log_events" ADD CONSTRAINT "plugin_log_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_log_events" ADD CONSTRAINT "plugin_log_events_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_log_events" ADD CONSTRAINT "plugin_log_events_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_log_events_instance_event_unique" ON "plugin_log_events" USING btree ("plugin_instance_id","id");--> statement-breakpoint
CREATE INDEX "plugin_log_events_instance_recent_idx" ON "plugin_log_events" USING btree ("tenant_id","plugin_instance_id","occurred_at");--> statement-breakpoint
CREATE INDEX "plugin_log_events_run_recent_idx" ON "plugin_log_events" USING btree ("tenant_id","run_id","occurred_at");