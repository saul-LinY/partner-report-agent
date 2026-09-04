CREATE TABLE "project_scope_backup_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"effective_from" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"first_seen_period_key" text NOT NULL,
	"session_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_scope_backup_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"partner_name" text NOT NULL,
	"device_name" text NOT NULL,
	"plugin_version" text NOT NULL,
	"policy_version" integer NOT NULL,
	"reason" text NOT NULL,
	"entry_count" integer NOT NULL,
	"allowed_count" integer NOT NULL,
	"denied_count" integer NOT NULL,
	"pending_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_scope_backup_entries" ADD CONSTRAINT "project_scope_backup_entries_snapshot_id_project_scope_backup_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."project_scope_backup_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_backup_snapshots" ADD CONSTRAINT "project_scope_backup_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_backup_snapshots" ADD CONSTRAINT "project_scope_backup_snapshots_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_backup_entry_key_unique" ON "project_scope_backup_entries" USING btree ("snapshot_id","scope_key");--> statement-breakpoint
CREATE INDEX "project_scope_backup_entries_snapshot_idx" ON "project_scope_backup_entries" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "project_scope_backup_team_created_idx" ON "project_scope_backup_snapshots" USING btree ("tenant_id","team_id","created_at");--> statement-breakpoint
CREATE INDEX "project_scope_backup_plugin_created_idx" ON "project_scope_backup_snapshots" USING btree ("plugin_instance_id","created_at");--> statement-breakpoint
WITH snapshot_source AS (
	SELECT
		pi.tenant_id,
		pi.team_id,
		pi.partner_id,
		pi.id AS plugin_instance_id,
		p.display_name AS partner_name,
		pi.device_name,
		pi.version AS plugin_version,
		psp.version AS policy_version,
		count(pse.id)::int AS entry_count,
		count(*) FILTER (WHERE pse.status = 'allowed')::int AS allowed_count,
		count(*) FILTER (WHERE pse.status = 'denied')::int AS denied_count,
		count(*) FILTER (WHERE pse.status = 'pending')::int AS pending_count
	FROM plugin_instances pi
	JOIN partners p ON p.id = pi.partner_id AND p.tenant_id = pi.tenant_id
	JOIN project_scope_policies psp ON psp.plugin_instance_id = pi.id
		AND psp.tenant_id = pi.tenant_id
	JOIN project_scope_entries pse ON pse.plugin_instance_id = pi.id
		AND pse.tenant_id = pi.tenant_id
	WHERE pi.status = 'active'
	GROUP BY pi.tenant_id, pi.team_id, pi.partner_id, pi.id, p.display_name,
		pi.device_name, pi.version, psp.version
), inserted_snapshots AS (
	INSERT INTO project_scope_backup_snapshots (
		id, tenant_id, team_id, partner_id, plugin_instance_id, partner_name,
		device_name, plugin_version, policy_version, reason, entry_count,
		allowed_count, denied_count, pending_count
	)
	SELECT gen_random_uuid(), tenant_id, team_id, partner_id,
		plugin_instance_id, partner_name, device_name, plugin_version,
		policy_version, 'manual_baseline', entry_count, allowed_count,
		denied_count, pending_count
	FROM snapshot_source
	RETURNING id, plugin_instance_id
)
INSERT INTO project_scope_backup_entries (
	id, snapshot_id, scope_key, display_name, status, effective_from,
	decided_at, first_seen_period_key, session_count
)
SELECT gen_random_uuid(), snapshots.id, entries.scope_key,
	entries.display_name, entries.status, entries.effective_from,
	entries.decided_at, entries.first_seen_period_key, entries.session_count
FROM inserted_snapshots snapshots
JOIN project_scope_entries entries
	ON entries.plugin_instance_id = snapshots.plugin_instance_id;
