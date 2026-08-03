CREATE TABLE "plugin_binding_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_prefix" text NOT NULL,
	"label" text DEFAULT 'Codex Plugin' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plugin_instance_id" uuid,
	"claimed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "minimum_plugin_version" SET DEFAULT '0.2.0';--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "email" text;--> statement-breakpoint
UPDATE "partners" p
SET "email" = coalesce(
	(select u."email" from "users" u where u."id" = p."user_id"),
	concat('partner-', p."id", '@unassigned.local')
);--> statement-breakpoint
ALTER TABLE "partners" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_collection_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_collection_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_collection_period_key" text;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_collection_session_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "last_collection_fact_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "collection_grace_minutes" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_binding_codes" ADD CONSTRAINT "plugin_binding_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_binding_codes" ADD CONSTRAINT "plugin_binding_codes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_binding_codes" ADD CONSTRAINT "plugin_binding_codes_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_binding_codes" ADD CONSTRAINT "plugin_binding_codes_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_binding_codes" ADD CONSTRAINT "plugin_binding_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_binding_codes_hash_unique" ON "plugin_binding_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "plugin_binding_codes_partner_idx" ON "plugin_binding_codes" USING btree ("tenant_id","partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partners_team_email_unique" ON "partners" USING btree ("tenant_id","team_id","email");
