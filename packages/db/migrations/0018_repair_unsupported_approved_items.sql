WITH unsupported_completed_items AS (
	SELECT wi.id, wi.review_id
	FROM work_items wi
	JOIN reviews r ON r.id = wi.review_id
	WHERE r.state = 'IN_PROGRESS'
		AND wi.review_status = 'approved'
		AND wi.status = 'completed'
		AND jsonb_array_length(
			CASE
				WHEN jsonb_typeof(wi.payload->'partnerFacts') = 'array'
				THEN wi.payload->'partnerFacts'
				ELSE '[]'::jsonb
			END
		) = 0
		AND NOT EXISTS (
			SELECT 1
			FROM work_item_facts wf
			JOIN session_facts sf ON sf.id = wf.fact_id
			WHERE wf.work_item_id = wi.id
				AND (
					sf.payload->>'completionSupport' = 'evidence'
					OR sf.payload->>'factOrigin' = 'partner_supplied'
					OR EXISTS (
						SELECT 1
						FROM jsonb_array_elements(
							CASE
								WHEN jsonb_typeof(sf.payload->'contributions') = 'array'
								THEN sf.payload->'contributions'
								ELSE '[]'::jsonb
							END
						) contribution
						WHERE contribution->>'kind' = 'outcome'
							AND contribution->>'confidence' IN ('high', 'medium')
					)
				)
		)
), repaired_items AS (
	UPDATE work_items wi
	SET review_status = 'pending', updated_at = now()
	FROM unsupported_completed_items unsupported
	WHERE wi.id = unsupported.id
	RETURNING wi.review_id
), affected_reviews AS (
	SELECT DISTINCT review_id FROM repaired_items
)
UPDATE reviews r
SET
	approved_count = counts.approved,
	excluded_count = counts.excluded,
	pending_count = counts.pending,
	version = r.version + 1,
	updated_at = now()
FROM affected_reviews affected
CROSS JOIN LATERAL (
	SELECT
		count(*) FILTER (WHERE wi.review_status = 'approved')::int AS approved,
		count(*) FILTER (WHERE wi.review_status = 'excluded')::int AS excluded,
		count(*) FILTER (WHERE wi.review_status = 'pending')::int AS pending
	FROM work_items wi
	WHERE wi.review_id = affected.review_id
) counts
WHERE r.id = affected.review_id;
