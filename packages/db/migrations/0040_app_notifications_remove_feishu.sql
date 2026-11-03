CREATE TABLE "app_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"review_version" integer,
	"delivered_at" timestamp with time zone,
	"delivered_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partners" DROP COLUMN IF EXISTS "feishu_delivery_enabled";--> statement-breakpoint
DELETE FROM "external_identities" WHERE "provider" IN ('feishu', 'lark');--> statement-breakpoint
DROP TABLE "feishu_deliveries" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_inbox_events" CASCADE;--> statement-breakpoint
DROP TABLE "feishu_partner_bindings" CASCADE;--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_delivered_device_id_collector_devices_id_fk" FOREIGN KEY ("delivered_device_id") REFERENCES "public"."collector_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_notifications_event_partner_unique" ON "app_notifications" USING btree ("source_event_id","partner_id");--> statement-breakpoint
CREATE INDEX "app_notifications_pending_idx" ON "app_notifications" USING btree ("tenant_id","team_id","partner_id","created_at");
