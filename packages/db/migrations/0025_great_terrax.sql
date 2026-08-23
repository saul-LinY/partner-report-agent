DELETE FROM "agent_jobs"
WHERE "type" IN ('GENERATE_INDIVIDUAL_REPORT', 'REGENERATE_INDIVIDUAL_REPORT')
   OR (
     "type" IN ('GENERATE_TEAM_REPORT', 'REGENERATE_TEAM_REPORT')
     AND "input_payload" ? 'individualReports'
   );--> statement-breakpoint
DROP TABLE "individual_reports" CASCADE;
