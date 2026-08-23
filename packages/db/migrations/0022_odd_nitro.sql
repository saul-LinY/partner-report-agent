CREATE TABLE "work_item_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"instruction" text,
	"source" text DEFAULT 'generated' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "work_item_versions" (
	"id", "tenant_id", "team_id", "partner_id", "period_id", "review_id",
	"work_item_id", "version", "title", "status", "payload", "source", "created_at"
)
SELECT gen_random_uuid(), "tenant_id", "team_id", "partner_id", "period_id", "review_id",
	"id", 1, "title", "status", "payload", 'generated', "created_at"
FROM "work_items";
--> statement-breakpoint
DROP TABLE "feishu_deliveries" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_inbox_events" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_partner_bindings" CASCADE;--> statement-breakpoint
DROP TABLE "outbox_events" CASCADE;--> statement-breakpoint
ALTER TABLE "work_item_versions" ADD CONSTRAINT "work_item_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_versions" ADD CONSTRAINT "work_item_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_versions" ADD CONSTRAINT "work_item_versions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_versions" ADD CONSTRAINT "work_item_versions_period_id_report_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."report_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_versions" ADD CONSTRAINT "work_item_versions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_versions" ADD CONSTRAINT "work_item_versions_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_versions_item_version_unique" ON "work_item_versions" USING btree ("work_item_id","version");--> statement-breakpoint
CREATE INDEX "work_item_versions_review_idx" ON "work_item_versions" USING btree ("tenant_id","review_id","created_at");
