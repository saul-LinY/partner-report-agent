CREATE TABLE "inspection_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"chain" text NOT NULL,
	"rule" text NOT NULL,
	"severity" text NOT NULL,
	"partner_id" uuid,
	"subject" text NOT NULL,
	"title" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"analysis" jsonb,
	"analysis_status" text DEFAULT 'none' NOT NULL,
	"analyzed_fingerprint_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inspection_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"opened_count" integer DEFAULT 0 NOT NULL,
	"resolved_count" integer DEFAULT 0 NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "collector_logs" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "collector_logs" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_findings" ADD CONSTRAINT "inspection_findings_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_runs" ADD CONSTRAINT "inspection_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspection_runs" ADD CONSTRAINT "inspection_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inspection_findings_fingerprint_unique" ON "inspection_findings" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "inspection_findings_team_status_idx" ON "inspection_findings" USING btree ("tenant_id","team_id","status","last_seen_at");--> statement-breakpoint
CREATE INDEX "inspection_runs_team_idx" ON "inspection_runs" USING btree ("tenant_id","team_id","started_at");