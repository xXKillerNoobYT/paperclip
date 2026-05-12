ALTER TABLE "plugin_job_runs"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "plugin_job_runs_job_trigger_idempotency_idx"
  ON "plugin_job_runs" ("job_id", "trigger", "idempotency_key");
