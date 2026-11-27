-- 0049 moved the default weekly cutoff from 17:00 to 16:00 in teams.period_rule. The admin team update
-- also moves the team's open period (its ends_at, cutoff_at and submission_deadline_at); mirror that here so
-- the transition week does not close at 17:00 and overlap the next period, which starts at the 16:00 cutoff.
UPDATE "report_periods" AS rp SET
	"ends_at" = moved."cutoff_at",
	"cutoff_at" = moved."cutoff_at",
	"submission_deadline_at" = moved."cutoff_at",
	"updated_at" = now()
FROM (
	SELECT DISTINCT ON (p."tenant_id", p."team_id")
		p."id",
		((p."cutoff_at" AT TIME ZONE p."timezone")::date + time '16:00') AT TIME ZONE p."timezone" AS "cutoff_at"
	FROM "report_periods" p
	JOIN "teams" t ON t."id" = p."team_id" AND t."tenant_id" = p."tenant_id"
	WHERE p."status" = 'open'
		AND t."period_rule"->>'factCutoffTime' = '16:00'
		AND (p."cutoff_at" AT TIME ZONE p."timezone")::time = time '17:00'
	ORDER BY p."tenant_id", p."team_id", p."starts_at" DESC
) moved
WHERE rp."id" = moved."id";
