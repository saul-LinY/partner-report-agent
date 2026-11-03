CREATE TABLE "collector_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"scope_instance_id" uuid NOT NULL,
	"binding_code_id" uuid NOT NULL,
	"device_name" text NOT NULL,
	"version" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_log_at" timestamp with time zone,
	"last_upload_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collector_logs" (
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage" text NOT NULL,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"upload_id" uuid,
	"session_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "collector_logs_device_id_event_id_pk" PRIMARY KEY("device_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "collector_upload_parts" (
	"upload_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"checksum" text NOT NULL,
	"sessions" jsonb NOT NULL,
	CONSTRAINT "collector_upload_parts_upload_id_part_index_pk" PRIMARY KEY("upload_id","part_index")
);
--> statement-breakpoint
CREATE TABLE "collector_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"policy_version" integer NOT NULL,
	"session_count" integer NOT NULL,
	"part_digests" jsonb NOT NULL,
	"status" text DEFAULT 'receiving' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collector_devices" ADD CONSTRAINT "collector_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_devices" ADD CONSTRAINT "collector_devices_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_devices" ADD CONSTRAINT "collector_devices_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_devices" ADD CONSTRAINT "collector_devices_scope_instance_id_plugin_instances_id_fk" FOREIGN KEY ("scope_instance_id") REFERENCES "public"."plugin_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_devices" ADD CONSTRAINT "collector_devices_binding_code_id_plugin_binding_codes_id_fk" FOREIGN KEY ("binding_code_id") REFERENCES "public"."plugin_binding_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_logs" ADD CONSTRAINT "collector_logs_device_id_collector_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."collector_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_upload_parts" ADD CONSTRAINT "collector_upload_parts_upload_id_collector_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."collector_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_uploads" ADD CONSTRAINT "collector_uploads_device_id_collector_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."collector_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collector_devices_token_unique" ON "collector_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "collector_devices_member_idx" ON "collector_devices" USING btree ("tenant_id","partner_id");--> statement-breakpoint
CREATE INDEX "collector_logs_recent_idx" ON "collector_logs" USING btree ("device_id","received_at");--> statement-breakpoint
CREATE INDEX "collector_uploads_device_idx" ON "collector_uploads" USING btree ("device_id","created_at");