import { Router } from "express";

import type { CreateFindingInput, FindingService, ReviewFindingInput } from "../finding/finding-service.js";

export function createFindingsRouter(findings: FindingService): Router {
  const router = Router();

  router.get("/:id/findings", async (req, res) => {
    res.json({ ok: true, findings: await findings.list(req.identity, req.params.id) });
  });

  router.post("/:id/findings", async (req, res) => {
    const result = await findings.create(req.identity, req.params.id, (req.body ?? {}) as CreateFindingInput);
    // 晋升不合格：沿用现有路由错误状态码，响应体携带 promotion 判定与原因。
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: "request_error", promotion: { eligible: false, reason: result.reason } });
      return;
    }
    res.status(201).json({ ok: true, finding: result.finding, promotion: { eligible: true } });
  });

  router.post("/:id/findings/:findingId/review", async (req, res) => {
    const finding = await findings.review(req.identity, req.params.id, req.params.findingId, (req.body ?? {}) as ReviewFindingInput);
    res.json({ ok: true, finding });
  });

  return router;
}
