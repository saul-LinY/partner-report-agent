CREATE TABLE "project_outcome_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"source_payload" jsonb NOT NULL,
	"source_checksum" text NOT NULL,
	"material" jsonb NOT NULL,
	"production" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_outcome_drafts" ADD CONSTRAINT "project_outcome_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_outcome_drafts" ADD CONSTRAINT "project_outcome_drafts_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_outcome_drafts_review_project_unique" ON "project_outcome_drafts" USING btree ("tenant_id","review_id","project_key");