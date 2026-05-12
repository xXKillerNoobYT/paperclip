import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../middleware/logger.js";

export const ONBOARDING_ALERT_DEFAULTS = {
  p95LatencyMs: 250,
  errorRatePercent: 5,
  minimumRequests: 5,
  alertCooldownMs: 5 * 60 * 1000,
} as const;

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_000, 5_000] as const;
const ONBOARDING_ROUTE_PATTERNS: Array<{ key: string; method: string; pattern: RegExp }> = [
  { key: "company_create", method: "POST", pattern: /^\/api\/companies\/?$/ },
  { key: "company_goals_list", method: "GET", pattern: /^\/api\/companies\/[^/]+\/goals\/?$/ },
  { key: "company_goal_create", method: "POST", pattern: /^\/api\/companies\/[^/]+\/goals\/?$/ },
  { key: "adapter_models", method: "GET", pattern: /^\/api\/companies\/[^/]+\/adapters\/[^/]+\/models\/?$/ },
  { key: "adapter_environment_test", method: "POST", pattern: /^\/api\/companies\/[^/]+\/adapters\/[^/]+\/test-environment\/?$/ },
  { key: "first_agent_hire", method: "POST", pattern: /^\/api\/companies\/[^/]+\/agent-hires\/?$/ },
  { key: "onboarding_approval", method: "POST", pattern: /^\/api\/approvals\/[^/]+\/approve\/?$/ },
  { key: "onboarding_project_create", method: "POST", pattern: /^\/api\/companies\/[^/]+\/projects\/?$/ },
  { key: "onboarding_issue_create", method: "POST", pattern: /^\/api\/companies\/[^/]+\/issues\/?$/ },
];

type RouteMetric = {
  routeKey: string;
  method: string;
  requests: number;
  errors: number;
  totalLatencyMs: number;
  latenciesMs: number[];
  buckets: Record<string, number>;
  firstSeenAt: number;
  lastSeenAt: number;
};

type AlertNotification = {
  id: string;
  metric: "p95_latency" | "error_rate";
  routeKey: string;
  value: number;
  threshold: number;
  correlationId: string;
  notifiedAt: string;
};

const metricsByRoute = new Map<string, RouteMetric>();
const recentAlertNotifications: AlertNotification[] = [];
const lastAlertAtByKey = new Map<string, number>();

function normalizePath(req: Request): string {
  return (req.originalUrl || req.url || "/").split("?")[0] ?? "/";
}

function routeKeyFor(req: Request): string | null {
  const method = req.method.toUpperCase();
  const path = normalizePath(req);
  return ONBOARDING_ROUTE_PATTERNS.find((entry) => entry.method === method && entry.pattern.test(path))?.key ?? null;
}

function getOrCreateRouteMetric(routeKey: string, method: string, now: number): RouteMetric {
  const key = `${method}:${routeKey}`;
  const existing = metricsByRoute.get(key);
  if (existing) return existing;
  const buckets = Object.fromEntries(LATENCY_BUCKETS_MS.map((bucket) => [`le_${bucket}`, 0]));
  const metric: RouteMetric = {
    routeKey,
    method,
    requests: 0,
    errors: 0,
    totalLatencyMs: 0,
    latenciesMs: [],
    buckets,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  metricsByRoute.set(key, metric);
  return metric;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function recordAlert(input: {
  metric: AlertNotification["metric"];
  routeKey: string;
  value: number;
  threshold: number;
  correlationId: string;
  now: number;
}) {
  const key = `${input.metric}:${input.routeKey}`;
  const lastAlertAt = lastAlertAtByKey.get(key) ?? 0;
  if (input.now - lastAlertAt < ONBOARDING_ALERT_DEFAULTS.alertCooldownMs) return;
  lastAlertAtByKey.set(key, input.now);

  const notification: AlertNotification = {
    id: randomUUID(),
    metric: input.metric,
    routeKey: input.routeKey,
    value: Number(input.value.toFixed(2)),
    threshold: input.threshold,
    correlationId: input.correlationId,
    notifiedAt: new Date(input.now).toISOString(),
  };
  recentAlertNotifications.unshift(notification);
  recentAlertNotifications.splice(20);
  logger.warn({ onboardingAlert: notification }, "onboarding_observability_alert");
}

function evaluateAlerts(metric: RouteMetric, correlationId: string, now: number) {
  if (metric.requests < ONBOARDING_ALERT_DEFAULTS.minimumRequests) return;
  const p95LatencyMs = percentile(metric.latenciesMs, 95);
  if (p95LatencyMs > ONBOARDING_ALERT_DEFAULTS.p95LatencyMs) {
    recordAlert({
      metric: "p95_latency",
      routeKey: metric.routeKey,
      value: p95LatencyMs,
      threshold: ONBOARDING_ALERT_DEFAULTS.p95LatencyMs,
      correlationId,
      now,
    });
  }

  const errorRatePercent = metric.requests > 0 ? (metric.errors / metric.requests) * 100 : 0;
  if (errorRatePercent > ONBOARDING_ALERT_DEFAULTS.errorRatePercent) {
    recordAlert({
      metric: "error_rate",
      routeKey: metric.routeKey,
      value: errorRatePercent,
      threshold: ONBOARDING_ALERT_DEFAULTS.errorRatePercent,
      correlationId,
      now,
    });
  }
}

function extractCompanyId(req: Request): string | null {
  const paramsCompanyId = typeof req.params?.companyId === "string" ? req.params.companyId : null;
  if (paramsCompanyId) return paramsCompanyId;
  const body = req.body as Record<string, unknown> | undefined;
  return typeof body?.companyId === "string" ? body.companyId : null;
}

export function onboardingObservabilityMiddleware(req: Request, res: Response, next: NextFunction) {
  const correlationId = req.correlationId ?? req.get("x-correlation-id") ?? req.get("x-request-id") ?? randomUUID();
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);

  const routeKey = routeKeyFor(req);
  if (!routeKey) {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const endedAt = Date.now();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const roundedDurationMs = Number(durationMs.toFixed(2));
    const metric = getOrCreateRouteMetric(routeKey, req.method.toUpperCase(), endedAt);
    metric.requests += 1;
    metric.totalLatencyMs += durationMs;
    metric.latenciesMs.push(durationMs);
    metric.lastSeenAt = endedAt;
    for (const bucket of LATENCY_BUCKETS_MS) {
      if (durationMs <= bucket) metric.buckets[`le_${bucket}`] += 1;
    }
    if (res.statusCode >= 400) metric.errors += 1;

    logger.info({
      event: "onboarding_request_completed",
      correlationId,
      routeKey,
      method: req.method,
      path: normalizePath(req),
      statusCode: res.statusCode,
      latencyMs: roundedDurationMs,
      companyId: extractCompanyId(req),
      actorType: req.actor?.type ?? "none",
    }, "onboarding_request_completed");

    evaluateAlerts(metric, correlationId, endedAt);
  });

  next();
}

export function getOnboardingObservabilitySnapshot() {
  const now = Date.now();
  const routes = Array.from(metricsByRoute.values()).map((metric) => {
    const durationSeconds = Math.max(1, (metric.lastSeenAt - metric.firstSeenAt) / 1_000);
    const p50LatencyMs = percentile(metric.latenciesMs, 50);
    const p95LatencyMs = percentile(metric.latenciesMs, 95);
    return {
      routeKey: metric.routeKey,
      method: metric.method,
      requests: metric.requests,
      errors: metric.errors,
      errorRatePercent: metric.requests > 0 ? Number(((metric.errors / metric.requests) * 100).toFixed(2)) : 0,
      throughputPerMinute: Number(((metric.requests / durationSeconds) * 60).toFixed(2)),
      averageLatencyMs: metric.requests > 0 ? Number((metric.totalLatencyMs / metric.requests).toFixed(2)) : 0,
      p50LatencyMs: Number(p50LatencyMs.toFixed(2)),
      p95LatencyMs: Number(p95LatencyMs.toFixed(2)),
      latencyBuckets: metric.buckets,
      firstSeenAt: new Date(metric.firstSeenAt).toISOString(),
      lastSeenAt: new Date(metric.lastSeenAt).toISOString(),
    };
  });

  const totals = routes.reduce(
    (acc, route) => {
      acc.requests += route.requests;
      acc.errors += route.errors;
      return acc;
    },
    { requests: 0, errors: 0 },
  );

  return {
    generatedAt: new Date(now).toISOString(),
    correlationHeader: "x-correlation-id",
    defaults: ONBOARDING_ALERT_DEFAULTS,
    dashboardSpec: {
      panels: [
        { metric: "p50LatencyMs", title: "Onboarding API p50 latency", unit: "ms" },
        { metric: "p95LatencyMs", title: "Onboarding API p95 latency", unit: "ms" },
        { metric: "errorRatePercent", title: "Onboarding API error rate", unit: "percent" },
        { metric: "throughputPerMinute", title: "Onboarding API throughput", unit: "requests/minute" },
      ],
    },
    totals: {
      ...totals,
      errorRatePercent: totals.requests > 0 ? Number(((totals.errors / totals.requests) * 100).toFixed(2)) : 0,
    },
    routes,
    recentAlertNotifications,
  };
}

export function resetOnboardingObservabilityForTests() {
  metricsByRoute.clear();
  recentAlertNotifications.splice(0);
  lastAlertAtByKey.clear();
}
