import { Router } from "express";

import type { CreateFindingInput, FindingService, ReviewFindingInput } from "../finding/finding-service.js";

export function createFindingsRouter(findings: FindingService): Router {
  const router = Router();

  router.get("/:id/findings", async (req, res) => {
    res.json({ ok: true, findings: await findings.list(req.identity, req.params.id) });
  });

  router.post("/:id/findings", async (req, res) => {
    const finding = await findings.create(req.identity, req.params.id, (req.body ?? {}) as CreateFindingInput);
    res.status(201).json({ ok: true, finding });
  });

  router.post("/:id/findings/:findingId/review", async (req, res) => {
    const finding = await findings.review(req.identity, req.params.id, req.params.findingId, (req.body ?? {}) as ReviewFindingInput);
    res.json({ ok: true, finding });
  });

  return router;
}
