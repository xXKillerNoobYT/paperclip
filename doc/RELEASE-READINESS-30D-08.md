# 30D-08 Onboarding Vertical Slice Release Readiness

Owner: CTO

Last updated: 2026-05-12

## Scope

This checklist covers the onboarding vertical slice needed for the 30D-08 release readiness milestone.

The happy path is:

1. Start a clean authenticated/private Paperclip instance from the Docker smoke image.
2. Bootstrap a board operator session.
3. Complete the onboarding wizard.
4. Create a company.
5. Create the initial CEO agent.
6. Create the first task.
7. Open the issue created by onboarding.
8. Verify the CEO received an assignment-triggered heartbeat run.

Out of scope for this release gate:

- Visual polish beyond blocking UX defects.
- External adapter marketplace coverage.
- Full production deployment validation.
- Browser matrix coverage outside Chromium.

## Staging-Like Setup

Run from the repository root with Docker running:

```sh
./scripts/smoke/onboarding-vertical-slice.sh
```

The wrapper uses:

- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- isolated temporary `PAPERCLIP_HOME` data
- Docker image `paperclip-onboarding-vertical-slice`
- UI/API base URL `http://127.0.0.1:3232`

Useful overrides:

```sh
HOST_PORT=3333 \
PAPERCLIP_RELEASE_SMOKE_BASE_URL=http://127.0.0.1:3333 \
./scripts/smoke/onboarding-vertical-slice.sh
```

Set `PRESERVE_SMOKE_CONTAINER=true` to keep the container, data directory, and generated smoke metadata after the run for debugging.

## Smoke Test Script

The wrapper composes the existing release-smoke pieces:

- `scripts/docker-onboard-smoke.sh` builds and starts the staging-like authenticated Docker instance, creates or signs in the smoke admin, accepts the bootstrap invite when needed, and writes connection metadata.
- `pnpm test:release-smoke` runs `tests/release-smoke/docker-auth-onboarding.spec.ts` against that instance.

Expected pass signal:

```txt
==> Onboarding vertical slice smoke passed
```

The Playwright test validates:

- sign-in redirects away from `/auth`
- onboarding wizard progresses through company, first agent, first task, and launch steps
- the created company exists via `GET /api/companies`
- the CEO agent exists and is not using the fallback `process` adapter
- the first issue is assigned to the CEO
- a heartbeat run exists for that CEO with `invocationSource = "assignment"` and status `queued`, `running`, `succeeded`, or `failed`

## Release Checklist

Before release:

- Run `./scripts/smoke/onboarding-vertical-slice.sh` from a clean checkout or clean worktree.
- Confirm no secrets are printed beyond the generated local smoke credentials.
- Confirm the smoke instance reports authenticated/private mode at `/api/health`.
- Confirm the smoke creates exactly one release-smoke company for the run.
- Confirm `GET /api/observability/onboarding` is reachable for an authenticated board or agent actor.
- Confirm onboarding observability includes the route keys listed in `doc/OBSERVABILITY.md`.
- Confirm no `recentAlertNotifications` remain unexplained after the smoke run.
- Confirm plugin job retry and dead-letter behavior remain covered by `doc/RUNBOOK-reliability-guardrails.md`.
- Keep the Playwright HTML report or terminal output attached to the release issue when this gate is run for a release candidate.

## Observability Verification

Use the baseline from `doc/OBSERVABILITY.md`.

During or after smoke execution, inspect:

```sh
curl -fsS "$SMOKE_BASE_URL/api/observability/onboarding"
```

The authenticated smoke wrapper writes `SMOKE_BASE_URL`, `SMOKE_ADMIN_EMAIL`, and `SMOKE_ADMIN_PASSWORD` to its temporary metadata file. With `PRESERVE_SMOKE_CONTAINER=true`, the wrapper prints that directory before exit.

Required signals:

- `onboarding_request_completed` structured logs include a stable `correlationId`.
- Onboarding route metrics include request count, error count, error rate, throughput, average latency, p50 latency, p95 latency, and histogram buckets.
- Dashboard panel specs exist for p50 latency, p95 latency, error rate, and throughput.
- Default alerts remain at p95 latency greater than 250 ms, error rate greater than 5%, minimum sample size 5, and 5-minute cooldown per metric and route.

## Rollback Plan

If the onboarding vertical slice fails after release:

1. Stop new rollout traffic or revert the deployed release to the previous stable image/package.
2. Preserve the failing smoke run output, Playwright trace, server logs, and container data directory before cleanup.
3. Re-run the smoke wrapper with `PRESERVE_SMOKE_CONTAINER=true` on the candidate and previous stable release to separate regression from environment failure.
4. Check `GET /api/observability/onboarding` for route-specific error rate or p95 spikes.
5. Check plugin job reliability signals using `doc/RUNBOOK-reliability-guardrails.md`; replay dead-letter jobs only with a new retry idempotency key after external side effects are reviewed.
6. If rollback touches npm release state, use the existing rollback utility:

```sh
pnpm release:rollback -- <stable-version> --dry-run
pnpm release:rollback -- <stable-version>
```

Rollback is complete when:

- the previous stable release passes `./scripts/smoke/onboarding-vertical-slice.sh`
- onboarding observability shows no unexplained alerts for the smoke route set
- any plugin dead-letter or retry incident is either replayed successfully or assigned to a named plugin owner

## Residual Risks

- The smoke proves Chromium only; it does not replace broader browser e2e coverage.
- The CEO heartbeat assertion accepts `failed` because this gate verifies assignment dispatch, not live model-provider credentials.
- Docker build time and registry/package availability can fail independently of onboarding behavior.
