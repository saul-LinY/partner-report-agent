CREATE TABLE "plugin_diagnostic_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"error_code" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"retryable" boolean NOT NULL,
	"request_id" text,
	"safe_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "connectivity_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "connectivity_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_connectivity_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_connectivity_error_code" text;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_connectivity_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_connectivity_request_id" text;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "connectivity_challenge_hash" text;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "connectivity_challenge_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "connectivity_challenge_consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_diagnostic_events" ADD CONSTRAINT "plugin_diagnostic_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_diagnostic_events" ADD CONSTRAINT "plugin_diagnostic_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_diagnostic_events" ADD CONSTRAINT "plugin_diagnostic_events_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_diagnostic_events" ADD CONSTRAINT "plugin_diagnostic_events_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_diagnostic_events_instance_event_unique" ON "plugin_diagnostic_events" USING btree ("plugin_instance_id","id");--> statement-breakpoint
CREATE INDEX "plugin_diagnostic_events_recent_idx" ON "plugin_diagnostic_events" USING btree ("tenant_id","plugin_instance_id","occurred_at");