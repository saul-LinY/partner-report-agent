CREATE TABLE "project_blocker_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"blocker_date" text NOT NULL,
	"blocker_title" text NOT NULL,
	"resolved" boolean NOT NULL,
	"resolved_on" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_blocker_marks" ADD CONSTRAINT "project_blocker_marks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_blocker_marks" ADD CONSTRAINT "project_blocker_marks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_blocker_marks" ADD CONSTRAINT "project_blocker_marks_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_blocker_marks" ADD CONSTRAINT "project_blocker_marks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_blocker_mark_unique" ON "project_blocker_marks" USING btree ("tenant_id","team_id","partner_id","project_id","blocker_date","blocker_title");