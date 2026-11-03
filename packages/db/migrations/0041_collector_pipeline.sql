ALTER TABLE collector_uploads ADD COLUMN analysis_enqueued_at timestamptz;
--> statement-breakpoint
ALTER TABLE collector_devices ADD COLUMN client_state jsonb, ADD COLUMN state_observed_at timestamptz;
--> statement-breakpoint
CREATE TABLE collector_upload_jobs (
  upload_id uuid NOT NULL CONSTRAINT collector_upload_jobs_upload_id_collector_uploads_id_fk REFERENCES collector_uploads(id) ON DELETE CASCADE,
  job_id uuid NOT NULL CONSTRAINT collector_upload_jobs_job_id_agent_jobs_id_fk REFERENCES agent_jobs(id) ON DELETE CASCADE,
  CONSTRAINT collector_upload_jobs_upload_id_job_id_pk PRIMARY KEY (upload_id, job_id)
);
--> statement-breakpoint
CREATE INDEX collector_upload_jobs_job_idx ON collector_upload_jobs(job_id);
--> statement-breakpoint
CREATE TABLE service_heartbeats (
  name text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_tick_at timestamptz,
  status text NOT NULL DEFAULT 'starting',
  error_code text,
  capabilities jsonb NOT NULL DEFAULT '{}'
);
