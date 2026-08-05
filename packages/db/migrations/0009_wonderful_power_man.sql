ALTER TABLE "individual_reports" RENAME COLUMN "current_version" TO "content_revision";--> statement-breakpoint
ALTER TABLE "individual_reports" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "individual_reports" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "individual_reports" ADD COLUMN "markdown" text;--> statement-breakpoint
ALTER TABLE "individual_reports" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "individual_reports" ADD COLUMN "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "individual_reports" ADD COLUMN "source_checksum" text;--> statement-breakpoint
ALTER TABLE "individual_reports" ADD COLUMN "generator_version" text;--> statement-breakpoint

UPDATE "individual_reports" AS report
SET
	"title" = current_content."title",
	"summary" = current_content."summary",
	"markdown" = current_content."markdown",
	"payload" = current_content."payload",
	"preferences" = current_content."preferences",
	"source_checksum" = current_content."source_checksum",
	"generator_version" = current_content."generator_version"
FROM "individual_report_versions" AS current_content
WHERE current_content."report_id" = report."id"
	AND current_content."version" = report."content_revision";--> statement-breakpoint

ALTER TABLE "individual_report_version_work_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "individual_report_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "work_item_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "individual_report_version_work_items" CASCADE;--> statement-breakpoint
DROP TABLE "individual_report_versions" CASCADE;--> statement-breakpoint
DROP TABLE "work_item_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "work_items" DROP COLUMN "version";--> statement-breakpoint

WITH ranked_facts AS (
	SELECT
		"id",
		first_value("id") OVER (
			PARTITION BY "tenant_id", "partner_id", "session_id", "external_fact_id"
			ORDER BY "current" DESC, "source_revision" DESC, "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS keep_id,
		row_number() OVER (
			PARTITION BY "tenant_id", "partner_id", "session_id", "external_fact_id"
			ORDER BY "current" DESC, "source_revision" DESC, "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS row_number
	FROM "session_facts"
)
INSERT INTO "work_item_facts" ("work_item_id", "fact_id")
SELECT links."work_item_id", ranked_facts.keep_id
FROM "work_item_facts" AS links
JOIN ranked_facts ON ranked_facts."id" = links."fact_id"
WHERE ranked_facts.row_number > 1
ON CONFLICT DO NOTHING;--> statement-breakpoint

WITH duplicate_facts AS (
	SELECT "id"
	FROM (
		SELECT
			"id",
			row_number() OVER (
				PARTITION BY "tenant_id", "partner_id", "session_id", "external_fact_id"
				ORDER BY "current" DESC, "source_revision" DESC, "updated_at" DESC, "created_at" DESC, "id" DESC
			) AS row_number
		FROM "session_facts"
	) ranked
	WHERE row_number > 1
)
DELETE FROM "work_item_facts"
USING duplicate_facts
WHERE "work_item_facts"."fact_id" = duplicate_facts."id";--> statement-breakpoint

WITH duplicate_facts AS (
	SELECT "id"
	FROM (
		SELECT
			"id",
			row_number() OVER (
				PARTITION BY "tenant_id", "partner_id", "session_id", "external_fact_id"
				ORDER BY "current" DESC, "source_revision" DESC, "updated_at" DESC, "created_at" DESC, "id" DESC
			) AS row_number
		FROM "session_facts"
	) ranked
	WHERE row_number > 1
)
DELETE FROM "session_facts"
USING duplicate_facts
WHERE "session_facts"."id" = duplicate_facts."id";--> statement-breakpoint

UPDATE "session_facts" SET "current" = true;--> statement-breakpoint
DROP INDEX "session_fact_revision_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "session_fact_current_unique" ON "session_facts" USING btree ("tenant_id","partner_id","session_id","external_fact_id");
