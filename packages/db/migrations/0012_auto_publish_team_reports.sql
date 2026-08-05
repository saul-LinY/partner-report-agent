UPDATE "team_reports"
SET
  "status" = 'LOCKED',
  "locked_at" = COALESCE("locked_at", "generated_at", "updated_at"),
  "locked_by" = NULL,
  "updated_at" = now()
WHERE "status" = 'TEAM_DRAFT'
  AND "current_version" > 0;
--> statement-breakpoint
UPDATE "report_periods" AS "period"
SET "status" = 'completed', "updated_at" = now()
WHERE EXISTS (
  SELECT 1
  FROM "team_reports" AS "report"
  WHERE "report"."period_id" = "period"."id"
    AND "report"."tenant_id" = "period"."tenant_id"
    AND "report"."team_id" = "period"."team_id"
    AND "report"."status" = 'LOCKED'
    AND "report"."current_version" > 0
);
