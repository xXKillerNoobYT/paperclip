import { Router } from "express";
import { unauthorized } from "../errors.js";
import { getOnboardingObservabilitySnapshot } from "../services/onboarding-observability.js";

export function onboardingObservabilityRoutes() {
  const router = Router();

  router.get("/observability/onboarding", (req, res) => {
    if (req.actor?.type !== "board" && req.actor?.type !== "agent") {
      throw unauthorized("Authentication required");
    }
    res.json(getOnboardingObservabilitySnapshot());
  });

  return router;
}
