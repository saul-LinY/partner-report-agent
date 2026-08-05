CREATE TABLE "feishu_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"receive_id" text NOT NULL,
	"receive_id_type" text NOT NULL,
	"message_id" text,
	"domain_version" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"next_retry_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_inbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"sanitized_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_partner_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"open_id" text,
	"union_id" text,
	"tenant_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_item_snapshots" ALTER COLUMN "approved_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "work_item_snapshots" ADD COLUMN "approved_by_actor_type" text;--> statement-breakpoint
ALTER TABLE "work_item_snapshots" ADD COLUMN "approved_by_actor_id" text;--> statement-breakpoint
UPDATE "work_item_snapshots"
SET
	"approved_by_actor_type" = 'user',
	"approved_by_actor_id" = "approved_by"::text
WHERE "approved_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "feishu_deliveries" ADD CONSTRAINT "feishu_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_deliveries" ADD CONSTRAINT "feishu_deliveries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_deliveries" ADD CONSTRAINT "feishu_deliveries_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_partner_bindings" ADD CONSTRAINT "feishu_partner_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_partner_bindings" ADD CONSTRAINT "feishu_partner_bindings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_partner_bindings" ADD CONSTRAINT "feishu_partner_bindings_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_deliveries_idempotency_unique" ON "feishu_deliveries" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_deliveries_message_unique" ON "feishu_deliveries" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "feishu_deliveries_retry_idx" ON "feishu_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "feishu_deliveries_aggregate_idx" ON "feishu_deliveries" USING btree ("tenant_id","aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_inbox_events_event_unique" ON "feishu_inbox_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "feishu_inbox_events_status_received_idx" ON "feishu_inbox_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_partner_bindings_partner_app_unique" ON "feishu_partner_bindings" USING btree ("tenant_id","partner_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feishu_partner_bindings_app_open_unique" ON "feishu_partner_bindings" USING btree ("app_id","open_id");--> statement-breakpoint
CREATE INDEX "feishu_partner_bindings_team_status_idx" ON "feishu_partner_bindings" USING btree ("tenant_id","team_id","status");
