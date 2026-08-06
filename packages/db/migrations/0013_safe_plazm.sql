CREATE TABLE "project_scope_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"effective_from" timestamp with time zone,
	"first_seen_period_key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_scope_policies" (
	"plugin_instance_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"initialized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_scope_entries" ADD CONSTRAINT "project_scope_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_entries" ADD CONSTRAINT "project_scope_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_entries" ADD CONSTRAINT "project_scope_entries_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_entries" ADD CONSTRAINT "project_scope_entries_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_policies" ADD CONSTRAINT "project_scope_policies_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_policies" ADD CONSTRAINT "project_scope_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_policies" ADD CONSTRAINT "project_scope_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope_policies" ADD CONSTRAINT "project_scope_policies_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_entries_instance_key_unique" ON "project_scope_entries" USING btree ("plugin_instance_id","scope_key");--> statement-breakpoint
CREATE INDEX "project_scope_entries_pending_idx" ON "project_scope_entries" USING btree ("tenant_id","partner_id","status");--> statement-breakpoint
CREATE INDEX "project_scope_policies_partner_idx" ON "project_scope_policies" USING btree ("tenant_id","partner_id");