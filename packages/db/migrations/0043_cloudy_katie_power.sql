CREATE TABLE "session_preprocess" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"scope_key" text NOT NULL,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"verdict" text NOT NULL,
	"reason" text,
	"decided_by" text NOT NULL,
	"rule_version" integer NOT NULL,
	"source_modified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_preprocess" ADD CONSTRAINT "session_preprocess_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_preprocess" ADD CONSTRAINT "session_preprocess_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_preprocess" ADD CONSTRAINT "session_preprocess_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_preprocess_session_unique" ON "session_preprocess" USING btree ("tenant_id","partner_id","scope_key","agent","session_id");--> statement-breakpoint
CREATE INDEX "session_preprocess_verdict_idx" ON "session_preprocess" USING btree ("tenant_id","team_id","verdict");