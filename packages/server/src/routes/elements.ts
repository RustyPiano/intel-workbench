import { Router } from "express";

import type { ElementService } from "../elements/element-service.js";

/**
 * 要素路由（工程方案 §5）。GET 读已抽取要素；POST 触发一次抽取（受控管线）。
 * 挂在 `/cases`，路径 `/:id/elements`。
 */
export function createElementsRouter(elements: ElementService): Router {
  const router = Router();

  router.get("/:id/elements", async (req, res) => {
    res.json({ ok: true, elements: await elements.get(req.identity, req.params.id) });
  });

  router.post("/:id/elements", async (req, res) => {
    res.status(201).json({ ok: true, elements: await elements.extract(req.identity, req.params.id) });
  });

  return router;
}
