import { Router } from "express";

import type { AdvanceStageInput, TaskService } from "../task/task-service.js";

/** Batch D：任务编排层路由。挂在 `/cases`，路径形如 `/:id/task-runs*`。 */
export function createTaskRouter(tasks: TaskService): Router {
  const router = Router();

  router.post("/:id/task-runs", async (req, res) => {
    const { templateId } = (req.body ?? {}) as { templateId?: string };
    const snapshot = await tasks.createRun(req.identity, req.params.id, templateId);
    res.status(snapshot.created ? 201 : 200).json({ ok: true, ...snapshot });
  });

  // task-run reads inherit case read-sharing; mutations are owner/admin-gated.
  router.get("/:id/task-runs/current", async (req, res) => {
    res.json({ ok: true, snapshot: await tasks.getCurrentRun(req.identity, req.params.id) });
  });

  router.get("/:id/task-runs/:runId", async (req, res) => {
    res.json({ ok: true, ...(await tasks.getRun(req.identity, req.params.id, req.params.runId)) });
  });

  router.post("/:id/task-runs/:runId/stages/:stageKey/advance", async (req, res) => {
    const snapshot = await tasks.advanceStage(
      req.identity,
      req.params.id,
      req.params.runId,
      req.params.stageKey,
      (req.body ?? {}) as AdvanceStageInput,
    );
    res.json({ ok: true, ...snapshot });
  });

  router.post("/:id/task-runs/:runId/stages/:stageKey/confirm", async (req, res) => {
    const snapshot = await tasks.confirmStage(req.identity, req.params.id, req.params.runId, req.params.stageKey);
    res.json({ ok: true, ...snapshot });
  });

  return router;
}
