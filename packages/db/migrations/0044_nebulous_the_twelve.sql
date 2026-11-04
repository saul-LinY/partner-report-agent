CREATE TABLE "project_profile_sessions" (
	"profile_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"source_scope_key" text NOT NULL,
	"seq" integer NOT NULL,
	"source_modified_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'done' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_profile_sessions_profile_id_agent_session_id_pk" PRIMARY KEY("profile_id","agent","session_id")
);
--> statement-breakpoint
CREATE TABLE "project_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"note" jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_profile_sessions" ADD CONSTRAINT "project_profile_sessions_profile_id_project_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."project_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_profiles" ADD CONSTRAINT "project_profiles_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_profile_sessions_seq_unique" ON "project_profile_sessions" USING btree ("profile_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "project_profiles_scope_unique" ON "project_profiles" USING btree ("tenant_id","partner_id","plugin_instance_id","scope_key");--> statement-breakpoint
CREATE INDEX "project_profiles_team_idx" ON "project_profiles" USING btree ("tenant_id","team_id");