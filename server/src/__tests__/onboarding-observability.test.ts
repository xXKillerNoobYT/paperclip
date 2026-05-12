import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { onboardingObservabilityRoutes } from "../routes/onboarding-observability.js";
import {
  getOnboardingObservabilitySnapshot,
  onboardingObservabilityMiddleware,
  resetOnboardingObservabilityForTests,
} from "../services/onboarding-observability.js";

function createApp(handler: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", source: "local_implicit" };
    next();
  });
  app.use(onboardingObservabilityMiddleware);
  app.post("/api/companies", handler);
  app.use("/api", onboardingObservabilityRoutes());
  app.use(errorHandler);
  return app;
}

describe("onboarding observability", () => {
  beforeEach(() => {
    resetOnboardingObservabilityForTests();
  });

  it("propagates a stable correlation id and records onboarding request metrics", async () => {
    const app = createApp((_req, res) => {
      res.status(201).json({ id: "company-1" });
    });

    const res = await request(app)
      .post("/api/companies")
      .set("x-correlation-id", "synthetic-onboarding-request")
      .send({ name: "Synthetic Co" });

    expect(res.status).toBe(201);
    expect(res.headers["x-correlation-id"]).toBe("synthetic-onboarding-request");

    const snapshot = getOnboardingObservabilitySnapshot();
    expect(snapshot.totals.requests).toBe(1);
    expect(snapshot.routes).toEqual([
      expect.objectContaining({
        routeKey: "company_create",
        method: "POST",
        requests: 1,
        errors: 0,
        p50LatencyMs: expect.any(Number),
        p95LatencyMs: expect.any(Number),
        throughputPerMinute: expect.any(Number),
      }),
    ]);
  });

  it("exposes dashboard metrics and alert defaults through the observability route", async () => {
    const app = createApp((_req, res) => {
      res.status(201).json({ id: "company-1" });
    });

    await request(app).post("/api/companies").send({ name: "Synthetic Co" });
    const res = await request(app).get("/api/observability/onboarding");

    expect(res.status).toBe(200);
    expect(res.body.defaults).toMatchObject({
      p95LatencyMs: 250,
      errorRatePercent: 5,
      minimumRequests: 5,
    });
    expect(res.body.dashboardSpec.panels.map((panel: { metric: string }) => panel.metric)).toEqual([
      "p50LatencyMs",
      "p95LatencyMs",
      "errorRatePercent",
      "throughputPerMinute",
    ]);
  });

  it("routes default threshold breaches to alert notifications", async () => {
    const app = createApp((_req, res) => {
      res.status(500).json({ error: "synthetic failure" });
    });

    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/api/companies").send({ name: `Synthetic ${i}` });
    }

    const snapshot = getOnboardingObservabilitySnapshot();
    expect(snapshot.routes[0]).toMatchObject({
      routeKey: "company_create",
      requests: 5,
      errors: 5,
      errorRatePercent: 100,
    });
    expect(snapshot.recentAlertNotifications).toEqual([
      expect.objectContaining({
        metric: "error_rate",
        routeKey: "company_create",
        threshold: 5,
      }),
    ]);
  });
});
