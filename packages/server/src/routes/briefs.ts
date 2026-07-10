import { Router } from "express";

import type { BriefService } from "../brief/brief-service.js";

/**
 * 研判简报路由（破坏性收敛 R2 · 批次 D）。挂在 `/cases`，路径 `/:id/brief`。
 * 只读确定性投影，访问闸门由 BriefService.getBrief 内部经 cases.get 收口。
 */
export function createBriefRouter(briefs: BriefService): Router {
  const router = Router();

  router.get("/:id/brief", async (req, res) => {
    res.json({ ok: true, brief: await briefs.getBrief(req.identity, req.params.id) });
  });

  return router;
}
