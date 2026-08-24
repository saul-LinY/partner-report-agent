WITH ranked_active_instances AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "tenant_id", "partner_id"
			ORDER BY
				("last_sync_at" IS NOT NULL) DESC,
				"last_sync_at" DESC NULLS LAST,
				"connectivity_verified_at" DESC NULLS LAST,
				"created_at" DESC,
				"id" DESC
		) AS active_rank
	FROM "plugin_instances"
	WHERE "status" = 'active'
)
UPDATE "plugin_instances" AS instance
SET
	"status" = 'revoked',
	"access_expires_at" = now(),
	"connectivity_status" = 'expired',
	"connectivity_challenge_hash" = NULL,
	"connectivity_challenge_expires_at" = NULL,
	"updated_at" = now()
FROM ranked_active_instances
WHERE instance."id" = ranked_active_instances."id"
	AND ranked_active_instances.active_rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_instances_one_active_partner_unique" ON "plugin_instances" USING btree ("tenant_id","partner_id") WHERE "plugin_instances"."status" = 'active';
