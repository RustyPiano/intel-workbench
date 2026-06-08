import { Router } from "express";

import type { CaseService } from "../cases/case-service.js";

/**
 * 专题 REST 路由（工程方案 §5，M1 做实部分）。素材子路由（`/:id/materials`）
 * 仍为占位，由 api.ts 的 stub 兜底（M2 接通）。
 */
export function createCasesRouter(cases: CaseService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ ok: true, cases: await cases.list(req.identity) });
  });

  router.post("/", async (req, res) => {
    const { name, clearance } = (req.body ?? {}) as { name?: string; clearance?: string };
    const manifest = await cases.create(req.identity, {
      name: name ?? "",
      clearance: clearance as never,
    });
    res.status(201).json({ ok: true, case: manifest });
  });

  router.get("/:id", async (req, res) => {
    res.json({ ok: true, case: await cases.get(req.identity, req.params.id) });
  });

  router.patch("/:id", async (req, res) => {
    const { name, status } = (req.body ?? {}) as { name?: string; status?: string };
    const manifest = await cases.update(req.identity, req.params.id, {
      name,
      status: status as never,
    });
    res.json({ ok: true, case: manifest });
  });

  return router;
}
