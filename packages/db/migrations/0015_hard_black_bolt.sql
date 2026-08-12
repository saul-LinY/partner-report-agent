CREATE TABLE "project_description_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"description" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description_source_fingerprint" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_description_candidates" ADD CONSTRAINT "project_description_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_description_candidates" ADD CONSTRAINT "project_description_candidates_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_description_candidates" ADD CONSTRAINT "project_description_candidates_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_description_candidates" ADD CONSTRAINT "project_description_candidates_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_description_candidates" ADD CONSTRAINT "project_description_candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_description_candidate_source_unique" ON "project_description_candidates" USING btree ("plugin_instance_id","project_id","source_fingerprint");--> statement-breakpoint
CREATE INDEX "project_description_candidate_pending_idx" ON "project_description_candidates" USING btree ("tenant_id","partner_id","project_id","status");