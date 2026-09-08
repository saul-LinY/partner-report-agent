CREATE TABLE "project_participation_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"participation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"events" jsonb NOT NULL,
	"note" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"review_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_participations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_participation_versions" ADD CONSTRAINT "project_participation_versions_participation_id_project_participations_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."project_participations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_participation_versions" ADD CONSTRAINT "project_participation_versions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_participation_versions" ADD CONSTRAINT "project_participation_versions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_participations" ADD CONSTRAINT "project_participations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_participations" ADD CONSTRAINT "project_participations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_participations" ADD CONSTRAINT "project_participations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_participations" ADD CONSTRAINT "project_participations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_participation_version_unique" ON "project_participation_versions" USING btree ("participation_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_participation_member_project_unique" ON "project_participations" USING btree ("tenant_id","team_id","partner_id","project_id");