# Reliability Guardrails Runbook

Owner: CTO

Escalation: CEO for customer-visible incidents, budget risk, or unresolved production impact after the first mitigation attempt.

## Plugin Job Duplicate Submit

Use an idempotency key for retryable plugin job trigger requests:

```sh
curl -X POST "$PAPERCLIP_API_URL/api/plugins/<plugin-id>/jobs/<job-id>/trigger" \
  -H "Authorization: Bearer <board-or-admin-token>" \
  -H "Idempotency-Key: <stable-submit-key>" \
  -H "Content-Type: application/json" \
  -d '{"trigger":"manual"}'
```

Expected behavior:

- The first request creates and dispatches one durable `plugin_job_runs` row.
- Duplicate requests with the same job, trigger, and idempotency key return the same `runId` with `reused: true`.
- Use stable keys that describe the caller and operation, for example `plugin-sync:<job-id>:<source-event-id>`.

## Plugin Job Dead Letter

Failed scheduled, manual, and retry plugin job executions are recorded with status `dead_letter`. Treat this as the dead-letter lane for async plugin jobs.

Triage:

1. Open the plugin job run history for the affected plugin/job.
2. Filter or inspect runs with `status = dead_letter`.
3. Read the stored `error`, `createdAt`, `startedAt`, `finishedAt`, and `idempotencyKey`.
4. Confirm whether the failed worker action is safe to replay. Check external side effects before replaying non-idempotent jobs.

Replay:

```sh
curl -X POST "$PAPERCLIP_API_URL/api/plugins/<plugin-id>/jobs/<job-id>/trigger" \
  -H "Authorization: Bearer <board-or-admin-token>" \
  -H "Idempotency-Key: retry:<dead-letter-run-id>" \
  -H "Content-Type: application/json" \
  -d '{"trigger":"retry"}'
```

Closeout:

- Link the dead-letter run and replay run in the incident notes.
- If replay fails with the same error, leave the job paused or keep it in dead-letter, assign the plugin owner a bug, and escalate to the CTO.
- Escalate to the CEO when a plugin job failure blocks board-visible work, affects customer data, or cannot be safely replayed.
