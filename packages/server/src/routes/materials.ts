import { Router } from "express";

import type { MaterialService } from "../materials/material-service.js";

/**
 * 素材内容路由（工程方案 §5：`GET /api/materials/:mid`）。
 * 文档返回归一化原文；媒体/未加工返回降级提示（产品 spec §10）。
 */
export function createMaterialsRouter(materials: MaterialService): Router {
  const router = Router();

  router.get("/:mid", async (req, res) => {
    res.json({ ok: true, ...(await materials.getContent(req.identity, req.params.mid)) });
  });

  return router;
}
