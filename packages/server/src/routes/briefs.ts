import { Router } from "express";

import type { BriefService } from "../brief/brief-service.js";

/**
 * 研判简报路由（阶段三 M2 / 计划 D1·D5）。挂在 `/cases`，路径 `/:id/brief`。
 * 读操作，访问闸门由 BriefService.getBrief 内部经 cases.get 收口；`?refresh=1` 强制重算。
 */
export function createBriefRouter(briefs: BriefService): Router {
  const router = Router();

  router.get("/:id/brief", async (req, res) => {
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    res.json({ ok: true, brief: await briefs.getBrief(req.identity, req.params.id, { refresh }) });
  });

  return router;
}
