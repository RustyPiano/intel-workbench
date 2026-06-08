import { Router } from "express";

import type { DraftInput, ReportService } from "../report/report-service.js";

/**
 * 报告路由（工程方案 §5 / §7.4）。草稿生成 + 复核闸门状态机。
 * 挂在 `/cases`，路径形如 `/:id/report*`。
 */
export function createReportsRouter(reports: ReportService): Router {
  const router = Router();

  router.get("/:id/report", async (req, res) => {
    res.json({ ok: true, report: await reports.get(req.identity, req.params.id) });
  });

  router.post("/:id/report/draft", async (req, res) => {
    const report = await reports.draft(req.identity, req.params.id, (req.body ?? {}) as DraftInput);
    res.status(201).json({ ok: true, report });
  });

  router.post("/:id/report/submit", async (req, res) => {
    res.json({ ok: true, report: await reports.submit(req.identity, req.params.id) });
  });

  router.post("/:id/report/approve", async (req, res) => {
    res.json({ ok: true, report: await reports.approve(req.identity, req.params.id) });
  });

  router.post("/:id/report/export", async (req, res) => {
    res.json({ ok: true, export: await reports.export(req.identity, req.params.id) });
  });

  return router;
}
