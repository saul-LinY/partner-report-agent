CREATE UNIQUE INDEX "individual_reports_partner_period_unique" ON "individual_reports" USING btree ("tenant_id","partner_id","period_id");--> statement-breakpoint
DROP INDEX "individual_reports_partner_period_idx";
