import { Router } from "express";

import type { StatusService } from "../brief/status-service.js";

/**
 * 专题聚合状态路由（破坏性收敛 R2 · 批次 D）。挂在 `/cases`，路径 `/:id/status`。
 * 只读，访问闸门由 StatusService.getStatus 内部经 cases.get 收口（沿用专题读权限）。
 */
export function createStatusRouter(status: StatusService): Router {
  const router = Router();

  router.get("/:id/status", async (req, res) => {
    res.json({ ok: true, status: await status.getStatus(req.identity, req.params.id) });
  });

  return router;
}
