CREATE TABLE "collection_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"period_id" uuid,
	"external_run_id" uuid NOT NULL,
	"status" text DEFAULT 'STARTED' NOT NULL,
	"window_starts_at" timestamp with time zone NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"initial_lookback" boolean DEFAULT false NOT NULL,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"eligible_count" integer DEFAULT 0 NOT NULL,
	"deferred_count" integer DEFAULT 0 NOT NULL,
	"excluded_count" integer DEFAULT 0 NOT NULL,
	"synced_session_count" integer DEFAULT 0 NOT NULL,
	"synced_fact_count" integer DEFAULT 0 NOT NULL,
	"pending_local_jobs" integer DEFAULT 0 NOT NULL,
	"continuation_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"fact_ids" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_report_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"markdown" text NOT NULL,
	"payload" jsonb NOT NULL,
	"source_checksum" text NOT NULL,
	"generator_version" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"status" text DEFAULT 'WAITING_SUBMISSIONS' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"missing_partner_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ALTER COLUMN "partner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "period_rule" SET DEFAULT '{"frequency":"weekly","weekStartsOn":1,"factCutoffWeekday":5,"factCutoffTime":"14:00","reportDeadlineWeekday":1,"reportDeadlineTime":"10:00"}'::jsonb;--> statement-breakpoint
UPDATE "teams" SET "period_rule" = '{"frequency":"weekly","weekStartsOn":1,"factCutoffWeekday":5,"factCutoffTime":"14:00","reportDeadlineWeekday":1,"reportDeadlineTime":"10:00"}'::jsonb || "period_rule";--> statement-breakpoint
ALTER TABLE "report_periods" ADD COLUMN "submission_deadline_at" timestamp with time zone;--> statement-breakpoint
UPDATE "report_periods" SET "submission_deadline_at" = "cutoff_at" + interval '3 days';--> statement-breakpoint
ALTER TABLE "report_periods" ALTER COLUMN "submission_deadline_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_periods" ADD COLUMN "facts_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_facts" ADD COLUMN "collection_run_id" uuid;--> statement-breakpoint
ALTER TABLE "session_facts" ADD COLUMN "source_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_facts" ADD COLUMN "late_from_period_key" text;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "collection_run_id" uuid;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "source_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "late_from_period_key" text;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD COLUMN "collection_run_id" uuid;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_period_id_report_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."report_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_snapshots" ADD CONSTRAINT "fact_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_snapshots" ADD CONSTRAINT "fact_snapshots_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_snapshots" ADD CONSTRAINT "fact_snapshots_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_snapshots" ADD CONSTRAINT "fact_snapshots_period_id_report_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."report_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_report_versions" ADD CONSTRAINT "team_report_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_report_versions" ADD CONSTRAINT "team_report_versions_report_id_team_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."team_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_report_versions" ADD CONSTRAINT "team_report_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_reports" ADD CONSTRAINT "team_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_reports" ADD CONSTRAINT "team_reports_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_reports" ADD CONSTRAINT "team_reports_period_id_report_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."report_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_reports" ADD CONSTRAINT "team_reports_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_runs_instance_external_unique" ON "collection_runs" USING btree ("plugin_instance_id","external_run_id");--> statement-breakpoint
CREATE INDEX "collection_runs_period_status_idx" ON "collection_runs" USING btree ("tenant_id","period_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fact_snapshots_partner_period_unique" ON "fact_snapshots" USING btree ("tenant_id","partner_id","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_report_version_unique" ON "team_report_versions" USING btree ("report_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "team_reports_team_period_unique" ON "team_reports" USING btree ("tenant_id","team_id","period_id");--> statement-breakpoint
ALTER TABLE "session_facts" ADD CONSTRAINT "session_facts_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_records" ADD CONSTRAINT "session_records_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_collection_run_id_collection_runs_id_fk" FOREIGN KEY ("collection_run_id") REFERENCES "public"."collection_runs"("id") ON DELETE no action ON UPDATE no action;
