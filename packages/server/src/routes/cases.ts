import { Router } from "express";

import type { AuditService } from "../audit/audit-service.js";
import type { CaseService } from "../cases/case-service.js";
import { AppError } from "../domain/identity.js";
import type { IngestFile, MaterialService } from "../materials/material-service.js";

/**
 * 专题 REST 路由（工程方案 §5）。M1 做实 CRUD；M2 接通素材汇入/列表
 * （`/:id/materials`）。素材内容（`/materials/:mid`）见 materials.ts。
 */
export function createCasesRouter(cases: CaseService, materials: MaterialService, audit: AuditService): Router {
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

  // 流式上传素材（二期 §4.6）：请求体即文件字节（application/octet-stream），
  // 绕 25MB base64-in-JSON 上限，直接 pipe 落盘。文件名经 x-upload-filename 头传递。
  router.post("/:id/materials/upload", async (req, res) => {
    const filename = decodeURIComponent(req.header("x-upload-filename") ?? "");
    const settle = req.header("x-upload-batch") !== "defer";
    const material = await materials.ingestStream(req.identity, req.params.id, filename, req, { settle });
    res.status(201).json({ ok: true, material });
  });

  router.post("/:id/materials/settle", async (req, res) => {
    await materials.settleIngest(req.identity, req.params.id);
    res.json({ ok: true });
  });

  // 显式加工媒体素材（二期 P2.3a §4.1）：pending/failed/done → done|failed。
  router.post("/:id/materials/:mid/process", async (req, res) => {
    const material = await materials.process(req.identity, req.params.id, req.params.mid);
    res.json({ ok: true, material });
  });

  // 重建稠密索引（embed 不可达时上传仍 done，待端点恢复手动重建检索向量）。
  router.post("/:id/materials/:mid/reindex", async (req, res) => {
    const material = await materials.reindex(req.identity, req.params.id, req.params.mid);
    res.json({ ok: true, material });
  });

  // 删除素材（清理落盘 + 从 manifest 摘除 + 审计）。
  router.delete("/:id/materials/:mid", async (req, res) => {
    await materials.remove(req.identity, req.params.id, req.params.mid);
    res.json({ ok: true });
  });

  // 本专题审计链（§7.2 镜像）：经 cases.get 校验访问 + 密级；可读该专题者即可查其审计轨迹。
  router.get("/:id/audit", async (req, res) => {
    await cases.get(req.identity, req.params.id);
    res.json({ ok: true, events: await audit.readCaseEvents(req.params.id) });
  });

  router.post("/", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.description !== undefined && typeof body.description !== "string") {
      throw new AppError(400, "专题说明必须为字符串");
    }
    const manifest = await cases.create(req.identity, {
      name: typeof body.name === "string" ? body.name : "",
      clearance: body.clearance as never,
      description: body.description,
    });
    res.status(201).json({ ok: true, case: manifest });
  });

  router.get("/:id", async (req, res) => {
    res.json({ ok: true, case: await cases.get(req.identity, req.params.id) });
  });

  router.patch("/:id", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const manifest = await cases.update(req.identity, req.params.id, {
      name: body.name === undefined || typeof body.name === "string" ? body.name : "",
      status: body.status as never,
      autopilot: typeof body.autopilot === "boolean" ? body.autopilot : undefined,
    });
    res.json({ ok: true, case: manifest });
  });

  return router;
}
