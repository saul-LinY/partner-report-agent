CREATE TABLE "leadership_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "period_rule" SET DEFAULT '{"frequency":"weekly","weekStartsOn":1,"factCutoffWeekday":5,"factCutoffTime":"16:00"}'::jsonb;--> statement-breakpoint
ALTER TABLE "leadership_snapshots" ADD CONSTRAINT "leadership_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leadership_snapshots" ADD CONSTRAINT "leadership_snapshots_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leadership_snapshots" ADD CONSTRAINT "leadership_snapshots_period_id_report_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."report_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leadership_snapshot_period_unique" ON "leadership_snapshots" USING btree ("tenant_id","team_id","period_id");--> statement-breakpoint
UPDATE "teams" SET "period_rule" = '{"frequency":"weekly","weekStartsOn":1,"factCutoffWeekday":5,"factCutoffTime":"16:00"}'::jsonb WHERE "period_rule" = '{"frequency":"weekly","weekStartsOn":1,"factCutoffWeekday":5,"factCutoffTime":"17:00"}'::jsonb;
