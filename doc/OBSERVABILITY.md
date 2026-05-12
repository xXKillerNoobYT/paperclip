# Observability Baseline

## Onboarding Requests

The onboarding API path emits a stable correlation ID on every request.

- Incoming `x-correlation-id` is preserved.
- If absent, `x-request-id` is reused.
- If neither header is present, the server generates a UUID.
- The selected ID is returned as `x-correlation-id` and included in structured logs.

Covered onboarding operations:

- `POST /api/companies`
- `GET /api/companies/:companyId/goals`
- `POST /api/companies/:companyId/goals`
- `GET /api/companies/:companyId/adapters/:type/models`
- `POST /api/companies/:companyId/adapters/:type/test-environment`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/approvals/:approvalId/approve`
- `POST /api/companies/:companyId/projects`
- `POST /api/companies/:companyId/issues`

Each covered request logs `onboarding_request_completed` with `correlationId`, `routeKey`, `method`, `path`, `statusCode`, `latencyMs`, `companyId`, and `actorType`.

## Metrics

The in-process onboarding metrics snapshot is available to authenticated board or agent actors at:

```sh
GET /api/observability/onboarding
```

The snapshot includes per-route request counts, error counts, error rate, throughput, average latency, p50 latency, p95 latency, and latency histogram buckets.

## Dashboard Spec

The first dashboard should chart these route-level series:

- p50 latency in milliseconds
- p95 latency in milliseconds
- error rate percentage
- throughput in requests per minute

Use the `dashboardSpec.panels` array from `GET /api/observability/onboarding` as the contract for panel names, units, and metric keys.

## Default Alerts

Default alert thresholds are:

- p95 latency: greater than 250 ms
- error rate: greater than 5%
- minimum sample size: 5 requests
- alert cooldown: 5 minutes per metric and route

Threshold breaches are routed through the server notifier path as structured warning logs with message `onboarding_observability_alert` and are also retained in `recentAlertNotifications` in the snapshot for board-visible inspection.
