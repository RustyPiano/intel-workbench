import { Router } from "express";

import type { ContradictionService } from "../analysis/contradiction-service.js";

/** 矛盾检测路由（C1a）。GET 读已持久化结果；POST 运行交叉验证/矛盾检测。访问/密级校验在服务内（cases.get）。 */
export function createContradictionsRouter(contradictions: ContradictionService): Router {
  const router = Router();

  router.get("/:id/contradictions", async (req, res) => {
    const result = await contradictions.getResult(req.identity, req.params.id);
    res.json({ ok: true, result, contradictions: result.contradictions });
  });

  router.post("/:id/contradictions", async (req, res) => {
    const result = await contradictions.detect(req.identity, req.params.id);
    res.status(201).json({ ok: true, result, contradictions: result.contradictions });
  });

  return router;
}
