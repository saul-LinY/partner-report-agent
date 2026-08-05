CREATE TABLE "individual_report_version_work_items" (
	"report_version_id" uuid NOT NULL,
	"work_item_version_id" uuid NOT NULL,
	CONSTRAINT "individual_report_version_work_items_report_version_id_work_item_version_id_pk" PRIMARY KEY("report_version_id","work_item_version_id")
);
--> statement-breakpoint
CREATE TABLE "work_item_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"project_id" uuid,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"review_status" text NOT NULL,
	"fact_ids" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"lineage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"change_type" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "individual_report_version_work_items" ADD CONSTRAINT "individual_report_version_work_items_report_version_id_individual_report_versions_id_fk" FOREIGN KEY ("report_version_id") REFERENCES "public"."individual_report_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "individual_report_version_work_items" ADD CONSTRAINT "individual_report_version_work_items_work_item_version_id_work_item_versions_id_fk" FOREIGN KEY ("work_item_version_id") REFERENCES "public"."work_item_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_versions" ADD CONSTRAINT "work_item_versions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_item_version_unique" ON "work_item_versions" USING btree ("work_item_id","version");--> statement-breakpoint
CREATE INDEX "work_item_versions_review_idx" ON "work_item_versions" USING btree ("tenant_id","review_id");--> statement-breakpoint
INSERT INTO "work_item_versions" (
	"id", "tenant_id", "team_id", "partner_id", "period_id", "review_id",
	"work_item_id", "project_id", "version", "title", "status", "review_status",
	"fact_ids", "payload", "lineage", "change_type", "created_by", "created_at"
)
SELECT
	gen_random_uuid(), wis."tenant_id", wis."team_id", wis."partner_id",
	wis."period_id", wis."review_id", (item->>'id')::uuid,
	nullif(item->>'project_id', '')::uuid, coalesce((item->>'version')::integer, 1),
	coalesce(item->>'title', '未命名工作卡片'), coalesce(item->>'status', 'in_progress'),
	coalesce(item->>'review_status', 'approved'), coalesce(item->'fact_ids', '[]'::jsonb),
	coalesce(item->'payload', '{}'::jsonb), coalesce(item->'lineage', '{}'::jsonb),
	'migration_snapshot', wis."approved_by", wis."approved_at"
FROM "work_item_snapshots" wis
CROSS JOIN LATERAL jsonb_array_elements(
	coalesce(wis."payload"->'workItems', '[]'::jsonb)
) item
WHERE item ? 'id'
ON CONFLICT ("work_item_id", "version") DO NOTHING;--> statement-breakpoint
INSERT INTO "work_item_versions" (
	"id", "tenant_id", "team_id", "partner_id", "period_id", "review_id",
	"work_item_id", "project_id", "version", "title", "status", "review_status",
	"fact_ids", "payload", "lineage", "change_type", "created_at"
)
SELECT
	gen_random_uuid(), wi."tenant_id", wi."team_id", wi."partner_id", wi."period_id",
	wi."review_id", wi."id", wi."project_id", wi."version", wi."title", wi."status",
	wi."review_status", wi."fact_ids", wi."payload", wi."lineage",
	'migration_current', wi."updated_at"
FROM "work_items" wi
ON CONFLICT ("work_item_id", "version") DO NOTHING;--> statement-breakpoint
INSERT INTO "individual_report_version_work_items" (
	"report_version_id", "work_item_version_id"
)
SELECT irv."id", wiv."id"
FROM "individual_reports" ir
JOIN "individual_report_versions" irv ON irv."report_id" = ir."id"
JOIN "work_item_snapshots" wis ON wis."id" = ir."snapshot_id"
CROSS JOIN LATERAL jsonb_array_elements(
	coalesce(wis."payload"->'workItems', '[]'::jsonb)
) item
JOIN "work_item_versions" wiv
	ON wiv."tenant_id" = ir."tenant_id"
	AND wiv."work_item_id" = (item->>'id')::uuid
	AND wiv."version" = coalesce((item->>'version')::integer, 1)
ON CONFLICT DO NOTHING;
