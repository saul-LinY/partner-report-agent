CREATE TABLE "project_scope_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"scope_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_scope_policies" ADD COLUMN "identity_salt" text;--> statement-breakpoint
ALTER TABLE "project_scope_identities" ADD CONSTRAINT "project_scope_identities_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_identity_unique" ON "project_scope_identities" USING btree ("plugin_instance_id","identity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_identity_scope_unique" ON "project_scope_identities" USING btree ("plugin_instance_id","scope_key");