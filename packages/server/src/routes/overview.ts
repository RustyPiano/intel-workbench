import { Router } from "express";

import type { OverviewService } from "../overview/overview-service.js";

export function createOverviewRouter(overview: OverviewService): Router {
  const router = Router();
  router.get("/", async (req, res) => {
    res.json({ ok: true, overview: await overview.summary(req.identity) });
  });
  return router;
}
