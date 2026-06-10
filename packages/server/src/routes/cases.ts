import { Router } from "express";

import type { CaseService } from "../cases/case-service.js";
import type { IngestFile, MaterialService } from "../materials/material-service.js";

/**
 * 专题 REST 路由（工程方案 §5）。M1 做实 CRUD；M2 接通素材汇入/列表
 * （`/:id/materials`）。素材内容（`/materials/:mid`）见 materials.ts。
 */
export function createCasesRouter(cases: CaseService, materials: MaterialService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ ok: true, cases: await cases.list(req.identity) });
  });

  // 素材子路由（声明在 `/:id` 之前，避免被参数路由吞掉）。
  router.get("/:id/materials", async (req, res) => {
    res.json({ ok: true, materials: await materials.list(req.identity, req.params.id) });
  });

  router.post("/:id/materials", async (req, res) => {
    const { files } = (req.body ?? {}) as { files?: IngestFile[] };
    const ingested = await materials.ingest(req.identity, req.params.id, files ?? []);
    res.status(201).json({ ok: true, materials: ingested });
  });

  // 显式加工媒体素材（二期 P2.3a §4.1）：pending/failed/done → done|failed。
  router.post("/:id/materials/:mid/process", async (req, res) => {
    const material = await materials.process(req.identity, req.params.id, req.params.mid);
    res.json({ ok: true, material });
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
