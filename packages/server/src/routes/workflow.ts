import { Router } from "express";

import { AppError } from "../domain/identity.js";
import type { WorkflowService } from "../workflow/workflow-service.js";

/** R2：专题唯一执行状态路由。挂在 `/cases`，路径形如 `/:id/workflow/*`。 */
export function createWorkflowRouter(workflow: WorkflowService): Router {
  const router = Router();

  // 人工检查点确认（实体归并 / 矛盾检测）。权限沿用专题写权限（owner/admin），在服务内收口。
  router.post("/:id/workflow/checkpoints/:key/confirm", async (req, res) => {
    const state = await workflow.confirmCheckpoint(req.identity, req.params.id, parseCheckpointKey(req.params.key));
    res.json({ ok: true, workflow: state });
  });

  return router;
}

function parseCheckpointKey(key: string): "entities" | "contradictions" {
  if (key === "entities" || key === "contradictions") return key;
  throw new AppError(400, "未知检查点");
}
