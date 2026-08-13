WITH review_counts AS (
	SELECT
		r.id,
		count(wi.id) FILTER (WHERE wi.review_status = 'approved')::int AS approved,
		count(wi.id) FILTER (WHERE wi.review_status = 'excluded')::int AS excluded,
		count(wi.id) FILTER (WHERE wi.review_status = 'pending')::int AS pending
	FROM reviews r
	LEFT JOIN work_items wi ON wi.review_id = r.id
	WHERE r.state = 'IN_PROGRESS'
	GROUP BY r.id
)
UPDATE reviews r
SET
	approved_count = counts.approved,
	excluded_count = counts.excluded,
	pending_count = counts.pending,
	version = CASE
		WHEN r.approved_count <> counts.approved
			OR r.excluded_count <> counts.excluded
			OR r.pending_count <> counts.pending
		THEN r.version + 1
		ELSE r.version
	END,
	updated_at = CASE
		WHEN r.approved_count <> counts.approved
			OR r.excluded_count <> counts.excluded
			OR r.pending_count <> counts.pending
		THEN now()
		ELSE r.updated_at
	END
FROM review_counts counts
WHERE r.id = counts.id;
