CREATE TABLE "project_scope_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plugin_instance_id" uuid NOT NULL,
	"alias_kind" text NOT NULL,
	"alias_key" text NOT NULL,
	"scope_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_scope_aliases" ADD CONSTRAINT "project_scope_aliases_plugin_instance_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_alias_unique" ON "project_scope_aliases" USING btree ("plugin_instance_id","alias_kind","alias_key");--> statement-breakpoint
CREATE INDEX "project_scope_alias_target_idx" ON "project_scope_aliases" USING btree ("plugin_instance_id","scope_key");